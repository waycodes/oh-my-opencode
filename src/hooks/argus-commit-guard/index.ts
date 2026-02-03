import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { computeTaskScopedChanges } from "../../shared/git-change-tracker"
import { getBlockingArgusReviews, hasApprovedArgusReview } from "../../features/review-gate"
import { log } from "../../shared/logger"

const SHELL_SPLIT_REGEX = /\s*(?:;|&&|\|\||\|)\s*/
const ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/

function isGitCommitCommand(command: string): boolean {
  if (!command) return false
  const segments = command.split(SHELL_SPLIT_REGEX)
  for (const raw of segments) {
    const segment = raw.trim()
    if (!segment) continue
    const tokens = segment.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue

    let idx = 0
    while (idx < tokens.length && ENV_ASSIGNMENT_REGEX.test(tokens[idx])) {
      idx += 1
    }
    if (idx >= tokens.length) continue

    if (tokens[idx].toLowerCase() !== "git") continue
    for (let i = idx + 1; i < tokens.length; i += 1) {
      if (tokens[i].toLowerCase() === "commit") {
        return true
      }
    }
  }
  return false
}

function formatPendingReviewIds(ids: string[]): string {
  if (ids.length === 0) return "(none)"
  return ids.map((id) => `- ${id}`).join("\n")
}

export function createArgusCommitGuardHook(ctx: PluginInput): Hooks {
  return {
    "tool.execute.before": async (input, output): Promise<void> => {
      if (input.tool.toLowerCase() !== "bash") return
      const command = output.args.command as string | undefined
      if (!command || !isGitCommitCommand(command)) return

      const changeSet = computeTaskScopedChanges(ctx.directory, { dirtyFiles: new Map() })
      if (changeSet.files.length === 0) return

      if (changeSet.isTrivial && changeSet.trivialReason !== "No task-scoped changes detected") {
        return
      }

      const sessionID = input.sessionID
      if (!sessionID) {
        throw new Error(
          "Git commit blocked: missing session context for Argus review. " +
          "Keep changes in the working tree until Argus returns [APPROVE]."
        )
      }

      const pending = getBlockingArgusReviews(sessionID)
      if (pending.length > 0) {
        const ids = pending.map((record) => record.taskId)
        throw new Error(
          "Git commit blocked: Argus review pending. " +
          "Keep changes in the working tree until Argus returns [APPROVE].\n\n" +
          `Pending Argus task(s):\n${formatPendingReviewIds(ids)}`
        )
      }

      if (!hasApprovedArgusReview(sessionID)) {
        throw new Error(
          "Git commit blocked: Argus review required before commit. " +
          "Keep changes in the working tree until Argus returns [APPROVE]."
        )
      }

      log("[argus-commit-guard] Commit allowed after approved Argus review", {
        sessionID,
        files: changeSet.files,
      })
    },
  }
}
