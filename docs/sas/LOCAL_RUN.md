# SAS-ClineContainers: Local Run & Current Scope

This repository now contains a minimal SAS loop implementation that creates a container spec per task, injects SAS context into prompts, estimates determinacy from invariants, and gates tool execution to planned steps while in the implementer phase. This document explains what is ready today, what remains simplified, and how to run the VS Code extension locally to exercise the SAS workflow.

## Current implementation state
- **Spec lifecycle:** SAS specs are created under `sas/containers/*.sas.md` with frontmatter, mapping/invariant sections, plan state, implementation log, and open questions. Phases (A1/A2/A3) are logged as the task progresses.
- **Determinacy:** Invariants parsed from section 2 drive a coarse determinacy score; planning is considered ready when mapping data exists and invariants are present, and implementation is allowed when determinacy is ≥0.5 (or no invariant has been judged yet) and at least one plan item is still TODO.
- **Plan-only execution:** Tool calls are blocked unless the SAS phase is `implementer` and the tool name matches an open plan item in section 4. Completing a tool call marks the matched plan item done and flips the next unknown invariant to satisfied.
- **Prompt grounding:** The active container spec (truncated) is injected into the system prompt along with scope paths and the current SAS phase, so the model sees container-specific guidance.
- **Limitations:** Mapping tables and invariant statuses still rely on model- or user-provided text; there is no automatic code analysis to populate section 3, and determinacy is heuristic rather than formal proof. Multi-step approvals still depend on the existing Cline UX rather than SAS-specific dialogs.

## Run the extension locally in VS Code
1. **Install dependencies**
   ```bash
   npm run install:all
   ```
2. **Start the extension in watch mode** (builds the extension and type-checks continuously):
   ```bash
   npm run dev
   ```
3. **Launch the Extension Development Host**
   - Open this repository in VS Code.
   - Press `F5` (or run the `Run Extension` launch configuration). VS Code will open a new window running the development build.
4. **Start a SAS-governed task**
   - In the dev host, open the Cline sidebar and start a new task.
   - Provide the task name and scope paths; a spec file is created at `sas/containers/<task>.sas.md` with your intent recorded under section 0.
   - Add mapping/invariant details in the spec (or via the model) so determinacy can reach the planning threshold.
5. **Plan and implement**
   - Planner updates (reasoning/plan messages) populate section 4 and seed invariants in section 2.
   - Tool calls will run only when: the SAS phase is implementer, determinacy is above the threshold, and the tool name matches a TODO plan bullet. Successful tool calls mark the step done and update invariant status.
6. **Inspect the SAS spec**
   - Open the generated `*.sas.md` to review phase transitions, plan completion, implementation logs, and open questions.

## Notes for testing
- If a tool call is blocked, check section 4 for the exact TODO text: tool names must appear in the plan bullet to be allowed.
- If determinacy is low (few invariants or none satisfied), add or update invariant lines in section 2 (format: `- [status] description`) and ensure the mapping layer (section 1) is not empty.
- The SAS loop is intentionally conservative: missing mapping data or invariants will push the phase back to the instantiator.
