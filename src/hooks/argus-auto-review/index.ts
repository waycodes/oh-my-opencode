import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundManager } from "../../features/background-agent"
import { isCallerOrchestrator } from "../../shared/session-utils"
import { log } from "../../shared/logger"

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

function parseChangedFilesFromAtlasOutput(text: string): string[] {
  const lines = (text ?? "").split("\n")
  const idx = lines.findIndex((l) => l.trim() === "[FILE CHANGES SUMMARY]")
  if (idx === -1) return []

  const files = new Set<string>()
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === "") continue
    if (trimmed === "---" || trimmed.startsWith("<system-reminder>")) break
    if (trimmed.endsWith(":") || trimmed.startsWith("[") || trimmed.startsWith("##")) {
      continue
    }

    const match = line.match(/^\s{2}(.+?)\s{2}\((?:\+\d+(?:,\s-\d+)?|-\d+)\)\s*$/)
    if (!match) continue
    const path = match[1]?.trim()
    if (path) files.add(path)
  }

  return Array.from(files)
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

  return `Review the code changes from the just-completed Sisyphus-Junior task.

${descLine}
${sessionLine}

Files to review:
${fileList}

Rules:
- Read each listed file and review for type safety, bugs, security, patterns, error handling, performance.
- Run lsp_diagnostics on the listed files.
- Return a verdict: [APPROVE] or [REJECT] with specific, actionable issues.`
}

export function createArgusAutoReviewHook(
  ctx: PluginInput,
  options: { backgroundManager: Pick<BackgroundManager, "launch"> }
) {
  const backgroundManager = options.backgroundManager

  return {
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

      const outputStr = typeof output.output === "string" ? output.output : ""
      const changedFiles = parseChangedFilesFromAtlasOutput(outputStr)

      const prompt = buildArgusPrompt({
        changedFiles,
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

        const fileList = formatFileList(changedFiles, 10)
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
          fileCount: changedFiles.length,
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
