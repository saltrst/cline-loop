import fs from "node:fs/promises"
import path from "node:path"

import { Logger } from "@services/logging/Logger"
import { fileExistsAtPath } from "@/utils/fs"

export interface SasContainerMetadata {
	containerId: string
	title: string
	createdAt?: string
	scopePaths?: string[]
	primaryModel?: string
	backupModel?: string
}

const FRONTMATTER_DELIMITER = "---"

const SECTION_HEADINGS = {
	taskClaim: "## 0. Task-Claim (C_t, E_t)",
	mappingLayer: "## 1. Mapping Layer for this Container",
	mechanics: "## 2. Mechanics & Invariants",
	mappingTable: "## 3. Code Mapping Table",
	plan: "## 4. Plan State (Agent 2 Output)",
	implementation: "## 5. Implementation Diffs (Agent 3 Output)",
	openQuestions: "## 6. Open Questions / Indeterminate Regions",
}

function sanitizeContainerId(rawId: string): string {
	const trimmed = rawId.trim().toLowerCase()
	const normalized = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, "")
	return normalized || "task"
}

function buildFrontmatter(metadata: SasContainerMetadata): string {
	const createdAt = metadata.createdAt ?? new Date().toISOString()
	const scopePaths = metadata.scopePaths?.length ? metadata.scopePaths : ["."]
	const primaryModel = metadata.primaryModel ?? "gpt-5.1-thinking"
	const backupModel = metadata.backupModel ?? "gpt-4.1"

	const frontmatter = {
		container_id: sanitizeContainerId(metadata.containerId),
		title: metadata.title,
		created_at: createdAt,
		version: 1,
		status: "active",
		scope: {
			paths: scopePaths,
			tests: [],
		},
		models: {
			primary: primaryModel,
			backup: backupModel,
		},
	}

	const yamlLines = [FRONTMATTER_DELIMITER]

	yamlLines.push(`container_id: ${frontmatter.container_id}`)
	yamlLines.push(`title: "${frontmatter.title.replace(/"/g, '\\"')}"`)
	yamlLines.push(`created_at: "${frontmatter.created_at}"`)
	yamlLines.push(`version: ${frontmatter.version}`)
	yamlLines.push(`status: "${frontmatter.status}"`)
	yamlLines.push("scope:")
	yamlLines.push("  paths:")
	for (const scopePath of frontmatter.scope.paths) {
		yamlLines.push(`    - "${scopePath}"`)
	}
	yamlLines.push("  tests: []")
	yamlLines.push("models:")
	yamlLines.push(`  primary: "${frontmatter.models.primary}"`)
	yamlLines.push(`  backup: "${frontmatter.models.backup}"`)
	yamlLines.push(FRONTMATTER_DELIMITER)

	return yamlLines.join("\n")
}

function buildInitialTemplate(metadata: SasContainerMetadata, initialTask?: string): string {
	const frontmatter = buildFrontmatter(metadata)
	const description = initialTask?.trim() ?? "Pending user intent"

	return [
		frontmatter,
		"",
		SECTION_HEADINGS.taskClaim,
		"- User intent: " + description,
		"- Task claim: Pending determinacy mapping.",
		"",
		SECTION_HEADINGS.mappingLayer,
		"- Entities: _",
		"- Attributes: _",
		"- Relations: _",
		"- Constraints: _",
		"",
		SECTION_HEADINGS.mechanics,
		"- Invariants: _",
		"",
		SECTION_HEADINGS.mappingTable,
		"| ID | Concept | File:Line(s) | Kind | Status |",
		"| -- | -------- | ------------- | ---- | ------ |",
		"| M1 | pending | pending | pending | unknown |",
		"",
		SECTION_HEADINGS.plan,
		"- [ ] Pending plan items",
		"",
		SECTION_HEADINGS.implementation,
		"- No implementation actions recorded yet.",
		"",
		SECTION_HEADINGS.openQuestions,
		"- None recorded.",
		"",
	].join("\n")
}

export class SasContainerRegistry {
	constructor(private readonly workspaceRoot: string) {}

	private async ensureContainerDirectory(): Promise<string> {
		const containerDir = path.join(this.workspaceRoot, "sas", "containers")
		await fs.mkdir(containerDir, { recursive: true })
		return containerDir
	}

	async ensureSpecFile(metadata: SasContainerMetadata, initialTask?: string): Promise<string | undefined> {
		try {
			const containerDir = await this.ensureContainerDirectory()
			const sanitizedId = sanitizeContainerId(metadata.containerId)
			const specPath = path.join(containerDir, `${sanitizedId}.sas.md`)

			if (!(await fileExistsAtPath(specPath))) {
				const content = buildInitialTemplate(metadata, initialTask)
				await fs.writeFile(specPath, content, "utf8")
			}

			return specPath
		} catch (error) {
			Logger.error("Failed to ensure SAS container spec", error)
			return undefined
		}
	}

	getSectionHeadings() {
		return SECTION_HEADINGS
	}
}
