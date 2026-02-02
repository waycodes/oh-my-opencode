import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { captureGitBaseline, computeTaskScopedChanges } from "./git-change-tracker"

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-change-tracker-"))
  execSync("git init", { cwd: dir })
  execSync("git config user.email \"test@example.com\"", { cwd: dir })
  execSync("git config user.name \"Test User\"", { cwd: dir })
  return dir
}

function git(cwd: string, cmd: string): void {
  execSync(cmd, { cwd, stdio: ["ignore", "ignore", "ignore"] })
}

describe("git-change-tracker", () => {
  test("captures task-scoped changes including edits to pre-dirty files", () => {
    //#given
    const dir = initRepo()
    try {
      writeFileSync(join(dir, "a.txt"), "one\n", "utf-8")
      git(dir, "git add a.txt")
      git(dir, "git commit -m \"init\"")

      // pre-existing dirty change
      writeFileSync(join(dir, "a.txt"), "one-mod\n", "utf-8")

      const baseline = captureGitBaseline(dir)

      // task-scoped changes
      writeFileSync(join(dir, "a.txt"), "one-mod2\n".repeat(12), "utf-8")
      writeFileSync(join(dir, "b.txt"), "two\n".repeat(6), "utf-8")

      //#when
      const changeSet = computeTaskScopedChanges(dir, baseline)

      //#then
      expect(changeSet.files).toContain("a.txt")
      expect(changeSet.files).toContain("b.txt")
      expect(changeSet.isTrivial).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("treats docs-only small changes as trivial", () => {
    //#given
    const dir = initRepo()
    try {
      writeFileSync(join(dir, "README.md"), "hello\n", "utf-8")
      git(dir, "git add README.md")
      git(dir, "git commit -m \"init\"")

      const baseline = captureGitBaseline(dir)

      writeFileSync(join(dir, "README.md"), "hello\nworld\n", "utf-8")

      //#when
      const changeSet = computeTaskScopedChanges(dir, baseline)

      //#then
      expect(changeSet.files).toContain("README.md")
      expect(changeSet.isTrivial).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
