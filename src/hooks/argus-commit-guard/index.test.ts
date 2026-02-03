import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import {
  resetReviewGateForTest,
  registerArgusReview,
  setArgusReviewVerdict,
} from "../../features/review-gate"
import { createArgusCommitGuardHook } from "./index"

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-commit-guard-"))
  execSync("git init", { cwd: dir })
  execSync("git config user.email \"test@example.com\"", { cwd: dir })
  execSync("git config user.name \"Test User\"", { cwd: dir })
  writeFileSync(join(dir, "src.txt"), "one\n", "utf-8")
  execSync("git add src.txt", { cwd: dir })
  execSync("git commit -m \"init\"", { cwd: dir })
  return dir
}

describe("argus-commit-guard hook", () => {
  let TEST_DIR: string

  afterEach(() => {
    if (TEST_DIR) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    resetReviewGateForTest()
  })

  test("blocks git commit when changes exist and no approved Argus review", async () => {
    //#given
    TEST_DIR = initRepo()
    writeFileSync(join(TEST_DIR, "src.txt"), "two\n".repeat(12), "utf-8")
    const hook = createArgusCommitGuardHook({ directory: TEST_DIR } as any)

    //#when / #then
    await expect(async () => {
      await hook["tool.execute.before"]?.(
        { tool: "bash", sessionID: "ses-1", callID: "call-1" } as any,
        { args: { command: "git commit -m \"test\"" } } as any
      )
    }).toThrow()
  })

  test("allows git commit when Argus review is approved", async () => {
    //#given
    TEST_DIR = initRepo()
    writeFileSync(join(TEST_DIR, "src.txt"), "two\n".repeat(12), "utf-8")
    registerArgusReview({ taskId: "bg_argus_1", parentSessionId: "ses-2" })
    setArgusReviewVerdict("bg_argus_1", "approved")
    const hook = createArgusCommitGuardHook({ directory: TEST_DIR } as any)

    //#when / #then
    await hook["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses-2", callID: "call-2" } as any,
      { args: { command: "git commit -m \"test\"" } } as any
    )
    expect(true).toBe(true)
  })

  test("blocks git commit when Argus review is pending", async () => {
    //#given
    TEST_DIR = initRepo()
    writeFileSync(join(TEST_DIR, "src.txt"), "two\n".repeat(12), "utf-8")
    registerArgusReview({ taskId: "bg_argus_2", parentSessionId: "ses-3" })
    const hook = createArgusCommitGuardHook({ directory: TEST_DIR } as any)

    //#when / #then
    await expect(async () => {
      await hook["tool.execute.before"]?.(
        { tool: "bash", sessionID: "ses-3", callID: "call-3" } as any,
        { args: { command: "git commit -m \"test\"" } } as any
      )
    }).toThrow()
  })

  test("allows docs-only changes without Argus review", async () => {
    //#given
    TEST_DIR = initRepo()
    writeFileSync(join(TEST_DIR, "README.md"), "docs\n", "utf-8")
    const hook = createArgusCommitGuardHook({ directory: TEST_DIR } as any)

    //#when / #then
    await hook["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses-4", callID: "call-4" } as any,
      { args: { command: "git commit -m \"docs\"" } } as any
    )
    expect(true).toBe(true)
  })
})
