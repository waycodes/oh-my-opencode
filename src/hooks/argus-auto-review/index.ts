import type { PluginInput } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
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

type CompletionCandidate = {
  kind: "todowrite" | "sisyphus-file"
  filePath?: string
  completedCount?: number
}

const WRITE_EDIT_TOOLS = new Set(["Write", "Edit", "write", "edit"])
const TASK_FILE_REGEX = /\.sisyphus[\\/](plans|tasks)[\\/]/

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

function resolvePath(rootDir: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(rootDir, filePath)
}

function readFileSafe(rootDir: string, filePath: string): string {
  try {
    return readFileSync(resolvePath(rootDir, filePath), "utf-8")
  } catch {
    return ""
  }
}

function countCompletedCheckboxes(text: string): number {
  const matches = text.match(/\[\s*[xX]\s*\]/g)
  return matches ? matches.length : 0
}

function appendOutput(output: ToolExecuteAfterOutput, text: string): void {
  const current = typeof output.output === "string" ? output.output : ""
  output.output = current + text
}

function buildArgusPrompt(args: {
  changedFiles: string[]
  diff?: string
  subagentSessionId?: string
  subagentDescription?: string
  subagentType?: string
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

  const agentLine = args.subagentType
    ? `Subagent type: ${args.subagentType}`
    : "Subagent type: (unknown)"

  return `Review the code changes from the just-completed subagent task.

${descLine}
${sessionLine}
${agentLine}

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
  const completionCandidates = new Map<string, CompletionCandidate>()

  return {
    "tool.execute.before": async (
      input: ToolExecuteAfterInput,
      output: { args: Record<string, unknown> }
    ): Promise<void> => {
      if (!isCallerOrchestrator(input.sessionID)) return
      if (!input.callID) return
      const toolLower = input.tool.toLowerCase()

      if (toolLower === "delegate_task") {
        if (!baselines.has(input.callID)) {
          baselines.set(input.callID, captureGitBaseline(ctx.directory))
        }
        return
      }

      if (toolLower === "todowrite") {
        const todos = output.args.todos as Array<{ status?: string }> | undefined
        const attemptsCompletion = Array.isArray(todos)
          && todos.some(t => String(t.status ?? "").toLowerCase() === "completed")
        if (attemptsCompletion) {
          completionCandidates.set(input.callID, { kind: "todowrite" })
        }
        return
      }

      if (WRITE_EDIT_TOOLS.has(input.tool)) {
        const filePath = (output.args.filePath ?? output.args.path ?? output.args.file) as string | undefined
        if (filePath && TASK_FILE_REGEX.test(filePath)) {
          const beforeText = readFileSafe(ctx.directory, filePath)
          completionCandidates.set(input.callID, {
            kind: "sisyphus-file",
            filePath,
            completedCount: countCompletedCheckboxes(beforeText),
          })
        }
      }
    },
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput
    ): Promise<void> => {
      if (!output) return
      if (!isCallerOrchestrator(input.sessionID)) return
      const toolLower = input.tool.toLowerCase()

      const launchCompletionReview = async (reason: string): Promise<void> => {
        if (!input.sessionID) return
        const changeSet = computeTaskScopedChanges(ctx.directory, { dirtyFiles: new Map() })
        if (changeSet.isTrivial) {
          appendOutput(
            output,
            `\n\n<system-reminder>\n[ARGUS AUTO-REVIEW SKIPPED]\nReason: ${changeSet.trivialReason ?? "Trivial change"}\nFiles: ${changeSet.files.length > 0 ? changeSet.files.join(", ") : "(none)"}\n</system-reminder>`
          )
          return
        }

        const prompt = buildArgusPrompt({
          changedFiles: changeSet.files,
          diff: changeSet.diff,
          subagentDescription: reason,
          subagentType: "completion-marker",
        })

        try {
          const task = await backgroundManager.launch({
            description: `Argus auto-review: ${reason}`,
            prompt,
            agent: "argus",
            parentSessionID: input.sessionID ?? "",
            parentMessageID: input.callID ?? "",
          })

          registerArgusReview({
            taskId: task.id,
            parentSessionId: input.sessionID ?? "",
            description: reason,
            files: changeSet.files,
            diff: changeSet.diff,
          })

          const fileList = formatFileList(changeSet.files, 10)
          appendOutput(
            output,
            `\n\n<system-reminder>\n[ARGUS AUTO-REVIEW LAUNCHED]\nTask ID: \`${task.id}\`\nFiles:\n${fileList}\n\nWait for completion notification, then inspect the review.\nDo NOT mark this task complete until Argus returns [APPROVE].\n</system-reminder>`
          )

          log("[argus-auto-review] Argus review launched (completion)", {
            parentSessionID: input.sessionID,
            taskId: task.id,
            fileCount: changeSet.files.length,
          })
        } catch (err) {
          appendOutput(
            output,
            `\n\n<system-reminder>\n[ARGUS AUTO-REVIEW FAILED]\nFailed to launch Argus review: ${String(err)}\n</system-reminder>`
          )
          log("[argus-auto-review] Failed to launch Argus review (completion)", { error: String(err) })
        }
      }

      if (toolLower === "delegate_task") {
        const meta = (output.metadata ?? {}) as Record<string, unknown>
        const delegatedAgent = typeof meta.agent === "string" ? meta.agent : undefined
        const runInBackground = meta.run_in_background === true
        const description = typeof meta.description === "string" ? meta.description : undefined
        const subagentSessionId = typeof meta.sessionId === "string" ? meta.sessionId : undefined

        if (!delegatedAgent) return
        const delegatedAgentLower = delegatedAgent.toLowerCase()
        if (delegatedAgentLower === "argus" || delegatedAgentLower === "momus") return
        if (runInBackground) return

        const baseline = input.callID ? baselines.get(input.callID) : undefined
        if (input.callID) {
          baselines.delete(input.callID)
        }
        const changeSet = computeTaskScopedChanges(ctx.directory, baseline ?? { dirtyFiles: new Map() })

        if (changeSet.isTrivial) {
          appendOutput(
            output,
            `\n\n<system-reminder>\n[ARGUS AUTO-REVIEW SKIPPED]\nReason: ${changeSet.trivialReason ?? "Trivial change"}\nFiles: ${changeSet.files.length > 0 ? changeSet.files.join(", ") : "(none)"}\n</system-reminder>`
          )
          return
        }

        const prompt = buildArgusPrompt({
          changedFiles: changeSet.files,
          diff: changeSet.diff,
          subagentSessionId,
          subagentDescription: description,
          subagentType: delegatedAgent,
        })

        try {
          const task = await backgroundManager.launch({
            description: `Argus auto-review: ${description ?? "subagent task"}`,
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
          appendOutput(
            output,
            `\n\n<system-reminder>\n[ARGUS AUTO-REVIEW LAUNCHED]\nTask ID: \`${task.id}\`\nFiles:\n${fileList}\n\nWait for completion notification, then inspect the review.\nDo NOT mark this task complete until Argus returns [APPROVE].\n</system-reminder>`
          )

          log("[argus-auto-review] Argus review launched", {
            parentSessionID: input.sessionID,
            delegatedAgent,
            taskId: task.id,
            fileCount: changeSet.files.length,
          })
        } catch (err) {
          appendOutput(
            output,
            `\n\n<system-reminder>\n[ARGUS AUTO-REVIEW FAILED]\nFailed to launch Argus review: ${String(err)}\n</system-reminder>`
          )
          log("[argus-auto-review] Failed to launch Argus review", { error: String(err) })
        }
        return
      }

      if (toolLower === "todowrite" && input.callID) {
        const candidate = completionCandidates.get(input.callID)
        completionCandidates.delete(input.callID)
        if (candidate?.kind === "todowrite") {
          await launchCompletionReview("todo completion")
        }
        return
      }

      if (WRITE_EDIT_TOOLS.has(input.tool) && input.callID) {
        const candidate = completionCandidates.get(input.callID)
        completionCandidates.delete(input.callID)
        if (candidate?.kind === "sisyphus-file" && candidate.filePath) {
          const afterText = readFileSafe(ctx.directory, candidate.filePath)
          const afterCount = countCompletedCheckboxes(afterText)
          const beforeCount = candidate.completedCount ?? 0
          if (afterCount > beforeCount) {
            await launchCompletionReview("plan/task completion")
          }
        }
      }
    },
  }
}
