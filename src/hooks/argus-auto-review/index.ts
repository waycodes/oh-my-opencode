import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundManager } from "../../features/background-agent"
import { isCallerOrchestrator } from "../../shared/session-utils"
import { log } from "../../shared/logger"
import { captureGitBaseline, computeTaskScopedChanges, type GitBaseline } from "../../shared/git-change-tracker"
import { registerArgusReview } from "../../features/review-gate"

type ToolExecuteAfterInput = {
  tool: string
  sessionID?: string
  callID?: string
}

type ToolExecuteAfterOutput = {
  title: string
  output: string
  metadata: Record<string, unknown>
}

function formatFileList(files: string[], max: number): string {
  if (files.length === 0) return "(no files detected)"
  const shown = files.slice(0, max)
  const remaining = files.length - shown.length
  const lines = shown.map((f) => `- ${f}`)
  if (remaining > 0) {
    lines.push(`- ...and ${remaining} more`)
  }
  return lines.join("\n")
}

function buildArgusPrompt(args: {
  changedFiles: string[]
  diff?: string
  subagentSessionId?: string
  subagentDescription?: string
}): string {
  const fileList = args.changedFiles.length > 0
    ? args.changedFiles.map((f) => `- ${f}`).join("\n")
    : "- (no file list available - infer from git status/diff)"

  const sessionLine = args.subagentSessionId
    ? `Subagent session: ${args.subagentSessionId}`
    : "Subagent session: (unknown)"

  const descLine = args.subagentDescription
    ? `Completed task: ${args.subagentDescription}`
    : "Completed task: (unknown)"

  const diffBlock = args.diff
    ? `\nDiff (task-scoped, unified=3):\n${args.diff}\n`
    : "\nDiff: (none)\n"

  return `Review the code changes from the just-completed Sisyphus-Junior task.

${descLine}
${sessionLine}

Files to review:
${fileList}
${diffBlock}

Rules:
- Review ONLY the diff and listed files.
- Run lsp_diagnostics on the listed files.
- Return a verdict: [APPROVE] or [REJECT] with specific, actionable issues.`
}

export function createArgusAutoReviewHook(
  ctx: PluginInput,
  options: { backgroundManager: Pick<BackgroundManager, "launch"> }
) {
  const backgroundManager = options.backgroundManager
  const baselines = new Map<string, GitBaseline>()

  return {
    "tool.execute.before": async (
      input: ToolExecuteAfterInput,
      output: { args: Record<string, unknown> }
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== "delegate_task") return
      if (!isCallerOrchestrator(input.sessionID)) return
      if (!input.callID) return

      if (!baselines.has(input.callID)) {
        baselines.set(input.callID, captureGitBaseline(ctx.directory))
      }
    },
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput
    ): Promise<void> => {
      if (!output) return
      if (input.tool.toLowerCase() !== "delegate_task") return
      if (!isCallerOrchestrator(input.sessionID)) return

      const meta = (output.metadata ?? {}) as Record<string, unknown>
      const delegatedAgent = typeof meta.agent === "string" ? meta.agent : undefined
      const runInBackground = meta.run_in_background === true
      const description = typeof meta.description === "string" ? meta.description : undefined
      const subagentSessionId = typeof meta.sessionId === "string" ? meta.sessionId : undefined

      if (!delegatedAgent || delegatedAgent.toLowerCase() !== "sisyphus-junior") return
      if (runInBackground) return

      const baseline = input.callID ? baselines.get(input.callID) : undefined
      if (input.callID) {
        baselines.delete(input.callID)
      }
      const changeSet = computeTaskScopedChanges(ctx.directory, baseline ?? { dirtyFiles: new Map() })

      if (changeSet.isTrivial) {
        output.output += `\n\n<system-reminder>
[ARGUS AUTO-REVIEW SKIPPED]
Reason: ${changeSet.trivialReason ?? "Trivial change"}
Files: ${changeSet.files.length > 0 ? changeSet.files.join(", ") : "(none)"}
</system-reminder>`
        return
      }

      const prompt = buildArgusPrompt({
        changedFiles: changeSet.files,
        diff: changeSet.diff,
        subagentSessionId,
        subagentDescription: description,
      })

      try {
        const task = await backgroundManager.launch({
          description: `Argus auto-review: ${description ?? "sisyphus-junior task"}`,
          prompt,
          agent: "argus",
          parentSessionID: input.sessionID ?? "",
          parentMessageID: input.callID ?? "",
          parentAgent: "atlas",
        })

        registerArgusReview({
          taskId: task.id,
          parentSessionId: input.sessionID ?? "",
          subagentSessionId,
          description,
          files: changeSet.files,
          diff: changeSet.diff,
        })

        const fileList = formatFileList(changeSet.files, 10)
        output.output += `\n\n<system-reminder>
[ARGUS AUTO-REVIEW LAUNCHED]
Task ID: \`${task.id}\`
Files:\n${fileList}

Wait for completion notification, then inspect the review.
Do NOT mark this task complete until Argus returns [APPROVE].
</system-reminder>`

        log("[argus-auto-review] Argus review launched", {
          parentSessionID: input.sessionID,
          delegatedAgent,
          taskId: task.id,
          fileCount: changeSet.files.length,
        })
      } catch (err) {
        output.output += `\n\n<system-reminder>
[ARGUS AUTO-REVIEW FAILED]
Failed to launch Argus review: ${String(err)}
</system-reminder>`
        log("[argus-auto-review] Failed to launch Argus review", { error: String(err) })
      }
    },
  }
}
