import fs from "node:fs/promises"
import path from "node:path"

import { Logger } from "@services/logging/Logger"

import { SasContainerMetadata, SasContainerRegistry } from "./SasContainerRegistry"

type SayEvent = {
	type: string
	text?: string
	partial?: boolean
}

type SasAgentPhase = "instantiator" | "planner" | "implementer"

export type SasOrchestratorParams = {
	workspaceRoot: string
	containerId: string
	title: string
	initialTask?: string
	scopePaths?: string[]
}

type SasInvariantStatus = "satisfied" | "violated" | "unknown"

type SasInvariant = {
	id: string
	description: string
	status: SasInvariantStatus
}

type SasPlanItem = {
	id: string
	text: string
	status: "todo" | "done"
}

export type SasDeterminacyState = {
	determinacy: number
	invariants: SasInvariant[]
	plan: SasPlanItem[]
	readyForPlanning: boolean
	readyForImplementation: boolean
}

export class SasOrchestrator {
	private registry: SasContainerRegistry
	private specPath?: string
	private readonly containerId: string
	private readonly title: string
	private readonly initialTask?: string
	private readonly scopePaths?: string[]
	private readonly sectionHeadings: ReturnType<SasContainerRegistry["getSectionHeadings"]>
	private currentPhase?: SasAgentPhase

	constructor(params: SasOrchestratorParams) {
		this.registry = new SasContainerRegistry(params.workspaceRoot)
		this.containerId = params.containerId
		this.title = params.title
		this.initialTask = params.initialTask
		this.scopePaths = params.scopePaths
		this.sectionHeadings = this.registry.getSectionHeadings()
	}

	async ensureInitialized() {
		if (this.specPath) {
			return this.specPath
		}

		const metadata: SasContainerMetadata = {
			containerId: this.containerId,
			title: this.title,
			scopePaths: this.scopePaths,
		}

		this.specPath = await this.registry.ensureSpecFile(metadata, this.initialTask)
		return this.specPath
	}

	async recordUserIntent(intent: string, attachments?: { files?: string[]; images?: string[] }) {
		await this.ensureInitialized()
		await this.setPhase("instantiator", "Captured user intent")
		const attachmentText = this.formatAttachments(attachments)
		const entry = `- [A1 Instantiator] @ ${new Date().toISOString()}: ${intent || "(no task text)"}${attachmentText}`
		await this.appendToSection(this.sectionHeadings.taskClaim, entry)
	}

	async recordPlanUpdate(planText?: string) {
		await this.ensureInitialized()
		await this.setPhase("planner", "Planner produced an update")
		await this.writePlanItems(planText)
	}

	async recordImplementationUpdate(kind: string, text?: string) {
		await this.ensureInitialized()
		await this.setPhase("implementer", "Implementer acted on plan")
		const entry = `- [A3 Implementer:${kind}] @ ${new Date().toISOString()}: ${text || "(no details provided)"}`
		await this.appendToSection(this.sectionHeadings.implementation, entry)
	}

	async recordOpenQuestion(note: string) {
		await this.ensureInitialized()
		await this.setPhase("instantiator", "Raised an open question")
		const entry = `- ${new Date().toISOString()}: ${note}`
		await this.appendToSection(this.sectionHeadings.openQuestions, entry)
	}

	async recordSayEvent(event: SayEvent) {
		if (event.partial) {
			return
		}

		const type = event.type
		const text = event.text

		if (type === "task") {
			await this.recordUserIntent(text ?? "(no task text provided)")
			return
		}

		if (type === "reasoning" || type === "generate_explanation" || type === "task_progress") {
			await this.recordPlanUpdate(text)
			return
		}

		if (type === "error" || type === "clineignore_error") {
			await this.recordOpenQuestion(text ?? "Error emitted by task")
			return
		}

		const implementationTypes = new Set([
			"command",
			"command_output",
			"tool",
			"checkpoint_created",
			"user_feedback_diff",
			"hook_output",
			"api_req_finished",
			"api_req_started",
			"completion_result",
		])

		if (implementationTypes.has(type)) {
			await this.recordImplementationUpdate(type, text)
		}
	}

	async getSpecInstructions(maxChars = 6000): Promise<string | undefined> {
		await this.ensureInitialized()
		if (!this.specPath) {
			return undefined
		}

		try {
			const content = await fs.readFile(this.specPath, "utf8")
			const trimmed = content.trim()
			const truncated = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n... (truncated)` : trimmed

			const fileLabel = path.basename(this.specPath)
			const scopeText = this.scopePaths?.length ? this.scopePaths.join(", ") : "."
			const phaseLabel = this.currentPhase ? this.formatPhase(this.currentPhase) : "unspecified"
			const sasLoopSummary =
				"Operate within the SAS three-agent loop: " +
				"A1=Instantiator (spec intent), A2=Planner (mapping + plan), A3=Implementer (apply approved diffs)."
			const scopeSummary = `Scope paths: ${scopeText}`
			const phaseSummary = `Current SAS phase: ${phaseLabel}`
			return [
				`SAS container spec: ${fileLabel}`,
				sasLoopSummary,
				scopeSummary,
				phaseSummary,
				"Ground planning and execution in this spec (sections 0-6).",
				truncated,
			].join("\n\n")
		} catch (error) {
			Logger.error("Failed to read SAS spec for prompt context", error)
			return undefined
		}
	}

	async setPhase(phase: SasAgentPhase, reason?: string) {
		await this.ensureInitialized()

		if (this.currentPhase === phase && !reason) {
			return
		}

		this.currentPhase = phase
		const entryReason = reason ? ` — ${reason}` : ""
		const entry = `- [Loop ${this.formatPhase(phase)}] ${new Date().toISOString()}${entryReason}`
		await this.appendToSection(this.sectionHeadings.taskClaim, entry)
	}

	async getDeterminacyState(): Promise<SasDeterminacyState> {
		await this.ensureInitialized()

		const invariants = await this.readInvariants()
		const plan = await this.readPlanItems()
		const satisfied = invariants.filter((inv) => inv.status === "satisfied").length
		const total = invariants.length || 1
		const determinacy = Math.max(0, Math.min(1, satisfied / total))

		const mappingReady = await this.hasMappingLayer()
		const readyForPlanning = mappingReady && invariants.length > 0
		const hasKnownInvariant = invariants.some((inv) => inv.status !== "unknown")
		const readyForImplementation = plan.some((item) => item.status === "todo") && (determinacy >= 0.5 || !hasKnownInvariant)

		return { determinacy, invariants, plan, readyForPlanning, readyForImplementation }
	}

	async validatePlannedToolExecution(toolName: string): Promise<{ allowed: boolean; reason?: string; planItemId?: string }> {
		const state = await this.getDeterminacyState()

		if (this.currentPhase !== "implementer") {
			return { allowed: false, reason: "SAS is not in implementer phase; plan steps must be approved first." }
		}

		if (!state.readyForImplementation) {
			return { allowed: false, reason: "Determinacy too low or no open plan items to execute." }
		}

		const normalizedTool = toolName.toLowerCase()
		const matching = state.plan.find((item) => item.status === "todo" && item.text.toLowerCase().includes(normalizedTool))

		if (!matching) {
			return { allowed: false, reason: "Tool request is not mapped to any open plan step." }
		}

		return { allowed: true, planItemId: matching.id }
	}

	async markPlanStepComplete(planItemId: string, note?: string) {
		await this.ensureInitialized()
		const planItems = await this.readPlanItems()
		const updated = planItems.map((item) => (item.id === planItemId ? { ...item, status: "done" as const } : item))

		await this.writePlanItemsFromList(updated)

		const invariants = await this.readInvariants()
		if (invariants.length) {
			const nextUnknownIndex = invariants.findIndex((inv) => inv.status === "unknown")
			if (nextUnknownIndex !== -1) {
				invariants[nextUnknownIndex] = { ...invariants[nextUnknownIndex], status: "satisfied" }
				await this.writeInvariants(invariants)
			}
		}

		const summary = note ? `${planItemId}: ${note}` : `Completed plan step ${planItemId}`
		await this.recordImplementationUpdate("plan_step", summary)
	}

	private formatAttachments(attachments?: { files?: string[]; images?: string[] }) {
		if (!attachments?.files?.length && !attachments?.images?.length) {
			return ""
		}
		const fileSegment = attachments.files?.length ? ` | files: ${attachments.files.join(", ")}` : ""
		const imageSegment = attachments.images?.length ? ` | images: ${attachments.images.join(", ")}` : ""
		return `${fileSegment}${imageSegment}`
	}

	private formatPhase(phase: SasAgentPhase): string {
		if (phase === "instantiator") {
			return "A1 Instantiator"
		}
		if (phase === "planner") {
			return "A2 Planner"
		}
		return "A3 Implementer"
	}

	private async appendToSection(sectionHeading: string, entry: string) {
		const specPath = this.specPath ?? (await this.ensureInitialized())
		if (!specPath) {
			return
		}

		try {
			const content = await fs.readFile(specPath, "utf8")
			const headingIndex = content.indexOf(sectionHeading)

			if (headingIndex === -1) {
				const updated = `${content.trimEnd()}\n\n${sectionHeading}\n${entry}\n`
				await fs.writeFile(specPath, updated, "utf8")
				return
			}

			const nextHeadingIndex = content.indexOf("\n## ", headingIndex + sectionHeading.length)
			const sectionStart = content.indexOf("\n", headingIndex + sectionHeading.length)
			const bodyStart = sectionStart === -1 ? headingIndex + sectionHeading.length : sectionStart + 1
			const bodyEnd = nextHeadingIndex === -1 ? content.length : nextHeadingIndex

			const before = content.slice(0, bodyStart)
			const existingBody = content.slice(bodyStart, bodyEnd).trimEnd()
			const after = content.slice(bodyEnd)

			const newBody = existingBody ? `${existingBody}\n${entry}` : entry
			const updatedContent = `${before}${newBody}\n\n${after.trimStart()}`

			await fs.writeFile(specPath, updatedContent, "utf8")
		} catch (error) {
			Logger.error("Failed to update SAS container section", error)
		}
	}

	private async replaceSectionBody(sectionHeading: string, newBody: string) {
		const specPath = this.specPath ?? (await this.ensureInitialized())
		if (!specPath) {
			return
		}

		try {
			const content = await fs.readFile(specPath, "utf8")
			const headingIndex = content.indexOf(sectionHeading)

			if (headingIndex === -1) {
				const updated = `${content.trimEnd()}\n\n${sectionHeading}\n${newBody.trim()}\n`
				await fs.writeFile(specPath, updated, "utf8")
				return
			}

			const nextHeadingIndex = content.indexOf("\n## ", headingIndex + sectionHeading.length)
			const sectionStart = content.indexOf("\n", headingIndex + sectionHeading.length)
			const bodyStart = sectionStart === -1 ? headingIndex + sectionHeading.length : sectionStart + 1
			const bodyEnd = nextHeadingIndex === -1 ? content.length : nextHeadingIndex

			const before = content.slice(0, bodyStart)
			const after = content.slice(bodyEnd)
			const updatedContent = `${before}${newBody.trim()}\n\n${after.trimStart()}`

			await fs.writeFile(specPath, updatedContent, "utf8")
		} catch (error) {
			Logger.error("Failed to replace SAS section body", error)
		}
	}

	private async hasMappingLayer(): Promise<boolean> {
		const specPath = this.specPath ?? (await this.ensureInitialized())
		if (!specPath) {
			return false
		}

		try {
			const content = await fs.readFile(specPath, "utf8")
			const mappingIndex = content.indexOf(this.sectionHeadings.mappingLayer)
			if (mappingIndex === -1) return false
			const nextHeadingIndex = content.indexOf("\n## ", mappingIndex + this.sectionHeadings.mappingLayer.length)
			const body = nextHeadingIndex === -1 ? content.slice(mappingIndex) : content.slice(mappingIndex, nextHeadingIndex)

			const meaningfulLine = body
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line && !line.includes("pending") && !line.endsWith(": _"))

			return Boolean(meaningfulLine)
		} catch (error) {
			Logger.error("Failed to read SAS mapping layer", error)
			return false
		}
	}

	private async readPlanItems(): Promise<SasPlanItem[]> {
		const specPath = this.specPath ?? (await this.ensureInitialized())
		if (!specPath) {
			return []
		}

		try {
			const content = await fs.readFile(specPath, "utf8")
			const planIndex = content.indexOf(this.sectionHeadings.plan)
			if (planIndex === -1) {
				return []
			}
			const nextHeadingIndex = content.indexOf("\n## ", planIndex + this.sectionHeadings.plan.length)
			const body = nextHeadingIndex === -1 ? content.slice(planIndex) : content.slice(planIndex, nextHeadingIndex)

			const items: SasPlanItem[] = []
			for (const [index, line] of body.split("\n").entries()) {
				const trimmed = line.trim()
				const match = /^- \[( |x)\]\s*(.+)$/i.exec(trimmed)
				if (!match) {
					continue
				}
				const status = match[1].toLowerCase() === "x" ? "done" : "todo"
				const text = match[2]
				items.push({ id: `S${index + 1}`, text, status })
			}

			return items
		} catch (error) {
			Logger.error("Failed to read SAS plan items", error)
			return []
		}
	}

	private async writePlanItems(planText?: string) {
		if (!planText) {
			const entry = `- [A2 Planner] @ ${new Date().toISOString()}: (no plan text provided)`
			await this.appendToSection(this.sectionHeadings.plan, entry)
			return
		}

		const lines = planText
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line)

		const bullets = lines.map((line) => `- [ ] ${line}`)
		const body = bullets.length ? bullets.join("\n") : `- [ ] ${planText.trim()}`
		await this.replaceSectionBody(this.sectionHeadings.plan, body)

		const invariants = await this.readInvariants()
		if (!invariants.length && bullets.length) {
			const seedInvariants = bullets.map((line, index) => ({
				id: `I${index + 1}`,
				description: `Plan alignment: ${line.replace(/^\s*-\s*\[[^\]]*\]\s*/, "")}`,
				status: "unknown" as const,
			}))
			await this.writeInvariants(seedInvariants)
		}
	}

	private async writePlanItemsFromList(items: SasPlanItem[]) {
		if (!items.length) {
			await this.replaceSectionBody(this.sectionHeadings.plan, "- [ ] Pending plan items")
			return
		}

		const lines = items.map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.text}`)
		await this.replaceSectionBody(this.sectionHeadings.plan, lines.join("\n"))
	}

	private async readInvariants(): Promise<SasInvariant[]> {
		const specPath = this.specPath ?? (await this.ensureInitialized())
		if (!specPath) {
			return []
		}

		try {
			const content = await fs.readFile(specPath, "utf8")
			const mechanicsIndex = content.indexOf(this.sectionHeadings.mechanics)
			if (mechanicsIndex === -1) {
				return []
			}

			const nextHeadingIndex = content.indexOf("\n## ", mechanicsIndex + this.sectionHeadings.mechanics.length)
			const body = nextHeadingIndex === -1 ? content.slice(mechanicsIndex) : content.slice(mechanicsIndex, nextHeadingIndex)

			const invariants: SasInvariant[] = []
			for (const [index, line] of body.split("\n").entries()) {
				const trimmed = line.trim()
				if (!trimmed || trimmed.startsWith("##")) {
					continue
				}
				const match = /^- \[(satisfied|violated|unknown)\]\s*(.+)$/i.exec(trimmed)
				if (match) {
					invariants.push({
						id: `I${index + 1}`,
						description: match[2],
						status: match[1].toLowerCase() as SasInvariantStatus,
					})
					continue
				}

				if (!trimmed.endsWith(": _") && !trimmed.includes("pending")) {
					invariants.push({ id: `I${index + 1}`, description: trimmed.replace(/^-\s*/, ""), status: "unknown" })
				}
			}

			return invariants
		} catch (error) {
			Logger.error("Failed to read SAS invariants", error)
			return []
		}
	}

	private async writeInvariants(invariants: SasInvariant[]) {
		if (!invariants.length) {
			await this.replaceSectionBody(this.sectionHeadings.mechanics, "- Invariants: _")
			return
		}

		const lines = invariants.map((inv) => `- [${inv.status}] ${inv.description}`)
		await this.replaceSectionBody(this.sectionHeadings.mechanics, lines.join("\n"))
	}
}
