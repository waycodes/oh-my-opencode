import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { getOpenCodeStorageDir } from "../../shared/data-path"

const TEST_STORAGE_ROOT = join(tmpdir(), `argus-auto-review-message-storage-${randomUUID()}`)
const TEST_MESSAGE_STORAGE = join(TEST_STORAGE_ROOT, "message")
const TEST_PART_STORAGE = join(TEST_STORAGE_ROOT, "part")

mock.module("../../features/hook-message-injector/constants", () => ({
  OPENCODE_STORAGE: TEST_STORAGE_ROOT,
  MESSAGE_STORAGE: TEST_MESSAGE_STORAGE,
  PART_STORAGE: TEST_PART_STORAGE,
}))

mock.module("../../shared/session-utils", () => ({
  isCallerOrchestrator: () => true,
}))

const { createArgusAutoReviewHook } = await import("./index")
const { MESSAGE_STORAGE } = await import("../../features/hook-message-injector")
const { isCallerOrchestrator } = await import("../../shared/session-utils")
const REAL_MESSAGE_STORAGE = join(getOpenCodeStorageDir(), "message")

function setupMessageStorage(sessionID: string, agent: string): void {
  const messageDirs = [join(MESSAGE_STORAGE, sessionID), join(REAL_MESSAGE_STORAGE, sessionID)]
  for (const messageDir of messageDirs) {
    if (!existsSync(messageDir)) {
      mkdirSync(messageDir, { recursive: true })
    }
  }
  const messageData = {
    agent,
    model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
  }
  for (const messageDir of messageDirs) {
    writeFileSync(join(messageDir, "msg_test001.json"), JSON.stringify(messageData))
  }
}

function cleanupMessageStorage(sessionID: string): void {
  const messageDirs = [join(MESSAGE_STORAGE, sessionID), join(REAL_MESSAGE_STORAGE, sessionID)]
  for (const messageDir of messageDirs) {
    if (existsSync(messageDir)) {
      rmSync(messageDir, { recursive: true, force: true })
    }
  }
}

describe("argus-auto-review hook", () => {
  let TEST_DIR: string

  beforeEach(() => {
    TEST_DIR = join(tmpdir(), `argus-auto-review-test-${randomUUID()}`)
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true })
    }
    execSync("git init", { cwd: TEST_DIR })
    execSync("git config user.email \"test@example.com\"", { cwd: TEST_DIR })
    execSync("git config user.name \"Test User\"", { cwd: TEST_DIR })
    const gitignorePath = join(TEST_DIR, ".gitignore")
    writeFileSync(gitignorePath, ".sisyphus/\\n", "utf-8")
    const initialPath = join(TEST_DIR, "src", "foo.ts")
    mkdirSync(join(TEST_DIR, "src"), { recursive: true })
    writeFileSync(initialPath, "const foo = 1;\\n", "utf-8")
    execSync("git add src/foo.ts .gitignore", { cwd: TEST_DIR })
    execSync("git commit -m \"init\"", { cwd: TEST_DIR })
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true })
  })

  test("should launch Argus review after sync subagent completion from Atlas", async () => {
    //#given
    const sessionID = `session-${randomUUID()}`
    setupMessageStorage(sessionID, "atlas")

    const launchMock = mock(async (input: any) => {
      return {
        id: "bg_argus_123",
        status: "pending",
        queuedAt: new Date(),
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
        parentSessionID: input.parentSessionID,
        parentMessageID: input.parentMessageID,
      }
    })

    const hook = createArgusAutoReviewHook(
      { directory: TEST_DIR } as any,
      { backgroundManager: { launch: launchMock } as any }
    )

    const output = {
      title: "Subagent Task",
      output: `## SUBAGENT WORK COMPLETED\n\n---\n\n**Subagent Response:**\n\nTask completed.`,
      metadata: {
        agent: "hephaestus",
        category: "quick",
        description: "Implement foo",
        run_in_background: false,
        sessionId: "ses_subagent_123",
        sync: true,
      },
    }

    //#when
    await hook["tool.execute.before"]?.(
      { tool: "delegate_task", sessionID, callID: "call-123" } as any,
      { args: { run_in_background: false } } as any
    )
    expect(isCallerOrchestrator(sessionID)).toBe(true)
    writeFileSync(join(TEST_DIR, "src", "bar.ts"), "export const bar = 2;\\n".repeat(12), "utf-8")
    await hook["tool.execute.after"]?.(
      { tool: "delegate_task", sessionID, callID: "call-123" } as any,
      output as any
    )

    //#then
    const launched = output.output.includes("ARGUS AUTO-REVIEW LAUNCHED")
    const skipped = output.output.includes("ARGUS AUTO-REVIEW SKIPPED")
    expect(launched || skipped).toBe(true)

    if (launched) {
      expect(launchMock).toHaveBeenCalledTimes(1)
      const launchArgs = launchMock.mock.calls[0]?.[0] as any
      expect(launchArgs.agent).toBe("argus")
      expect(launchArgs.parentSessionID).toBe(sessionID)
      expect(launchArgs.parentMessageID).toBe("call-123")
      expect(launchArgs.description.toLowerCase()).toContain("argus")
      expect(launchArgs.prompt).toContain("src/bar.ts")
      expect(output.output).toContain("bg_argus_123")
    }

    cleanupMessageStorage(sessionID)
  })

  test("should launch Argus review for committed fallback when no task-scoped changes detected", async () => {
    //#given
    const sessionID = `session-${randomUUID()}`
    setupMessageStorage(sessionID, "atlas")

    const launchMock = mock(async (input: any) => {
      return {
        id: "bg_argus_999",
        status: "pending",
        queuedAt: new Date(),
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
        parentSessionID: input.parentSessionID,
        parentMessageID: input.parentMessageID,
      }
    })

    const hook = createArgusAutoReviewHook(
      { directory: TEST_DIR } as any,
      { backgroundManager: { launch: launchMock } as any }
    )

    const output = {
      title: "Subagent Task",
      output: `## SUBAGENT WORK COMPLETED\n\n---\n\n**Subagent Response:**\n\nTask completed.`,
      metadata: {
        agent: "hephaestus",
        category: "quick",
        description: "Implement bar",
        run_in_background: false,
        sessionId: "ses_subagent_999",
        sync: true,
      },
    }

    //#when
    await hook["tool.execute.before"]?.(
      { tool: "delegate_task", sessionID, callID: "call-999" } as any,
      { args: { run_in_background: false } } as any
    )

    writeFileSync(join(TEST_DIR, "src", "bar.ts"), "export const bar = 2;\\n".repeat(3), "utf-8")
    execSync("git add src/bar.ts", { cwd: TEST_DIR })
    execSync("git commit -m \"add bar\"", { cwd: TEST_DIR })

    await hook["tool.execute.after"]?.(
      { tool: "delegate_task", sessionID, callID: "call-999" } as any,
      output as any
    )

    //#then
    expect(launchMock).toHaveBeenCalledTimes(1)
    const launchArgs = launchMock.mock.calls[0]?.[0] as any
    expect(launchArgs.agent).toBe("argus")
    expect(launchArgs.parentSessionID).toBe(sessionID)
    expect(launchArgs.prompt).toContain("committed range")
    expect(launchArgs.prompt).toContain("src/bar.ts")
    expect(output.output).toContain("Mode: committed fallback")

    cleanupMessageStorage(sessionID)
  })

  test("should not launch when caller is not Atlas", async () => {
    //#given
    const sessionID = `session-${randomUUID()}`
    setupMessageStorage(sessionID, "sisyphus")

    const launchMock = mock(async () => ({ id: "bg_argus_123" }))
    const hook = createArgusAutoReviewHook(
      { directory: TEST_DIR } as any,
      { backgroundManager: { launch: launchMock } as any }
    )

    const output = {
      title: "Subagent Task",
      output: "Task completed",
      metadata: {
        agent: "sisyphus-junior",
        description: "Implement foo",
        run_in_background: false,
      },
    }

    //#when
    await hook["tool.execute.after"]?.(
      { tool: "delegate_task", sessionID, callID: "call-123" } as any,
      output as any
    )

    //#then
    expect(launchMock).toHaveBeenCalledTimes(0)

    cleanupMessageStorage(sessionID)
  })

  test("should not launch when delegate_task used run_in_background=true", async () => {
    //#given
    const sessionID = `session-${randomUUID()}`
    setupMessageStorage(sessionID, "atlas")

    const launchMock = mock(async () => ({ id: "bg_argus_123" }))
    const hook = createArgusAutoReviewHook(
      { directory: TEST_DIR } as any,
      { backgroundManager: { launch: launchMock } as any }
    )

    const output = {
      title: "Subagent Task",
      output: "Background task launched.\n\nTask ID: bg_1",
      metadata: {
        agent: "sisyphus-junior",
        description: "Implement foo",
        run_in_background: true,
      },
    }

    //#when
    await hook["tool.execute.after"]?.(
      { tool: "delegate_task", sessionID, callID: "call-123" } as any,
      output as any
    )

    //#then
    expect(launchMock).toHaveBeenCalledTimes(0)

    cleanupMessageStorage(sessionID)
  })

  test("should launch Argus review after todowrite completion", async () => {
    //#given
    const sessionID = `session-${randomUUID()}`
    setupMessageStorage(sessionID, "atlas")

    const launchMock = mock(async (input: any) => {
      return {
        id: "bg_argus_456",
        status: "pending",
        queuedAt: new Date(),
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
        parentSessionID: input.parentSessionID,
        parentMessageID: input.parentMessageID,
      }
    })

    const hook = createArgusAutoReviewHook(
      { directory: TEST_DIR } as any,
      { backgroundManager: { launch: launchMock } as any }
    )

    writeFileSync(join(TEST_DIR, "src", "bar.ts"), "export const bar = 2;\\n".repeat(12), "utf-8")

    //#when
    await hook["tool.execute.before"]?.(
      { tool: "todowrite", sessionID, callID: "call-todo" } as any,
      { args: { todos: [{ id: "1", content: "done", status: "completed", priority: "high" }] } } as any
    )

    const output = {
      title: "Todos",
      output: "ok",
      metadata: {},
    }

    await hook["tool.execute.after"]?.(
      { tool: "todowrite", sessionID, callID: "call-todo" } as any,
      output as any
    )

    //#then
    if (output.output.includes("ARGUS AUTO-REVIEW LAUNCHED")) {
      expect(launchMock).toHaveBeenCalledTimes(1)
      const launchArgs = launchMock.mock.calls[0]?.[0] as any
      expect(launchArgs.agent).toBe("argus")
      expect(launchArgs.parentSessionID).toBe(sessionID)
    }

    cleanupMessageStorage(sessionID)
  })

  test("should launch Argus review after plan checkbox completion", async () => {
    //#given
    const sessionID = `session-${randomUUID()}`
    setupMessageStorage(sessionID, "atlas")

    const launchMock = mock(async (input: any) => {
      return {
        id: "bg_argus_789",
        status: "pending",
        queuedAt: new Date(),
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
        parentSessionID: input.parentSessionID,
        parentMessageID: input.parentMessageID,
      }
    })

    const hook = createArgusAutoReviewHook(
      { directory: TEST_DIR } as any,
      { backgroundManager: { launch: launchMock } as any }
    )

    const planDir = join(TEST_DIR, ".sisyphus", "plans")
    mkdirSync(planDir, { recursive: true })
    const planPath = join(planDir, "plan.md")
    writeFileSync(planPath, "- [ ] Task 1\\n", "utf-8")

    //#when
    await hook["tool.execute.before"]?.(
      { tool: "Write", sessionID, callID: "call-plan" } as any,
      { args: { filePath: ".sisyphus/plans/plan.md" } } as any
    )

    writeFileSync(planPath, "- [x] Task 1\\n", "utf-8")
    writeFileSync(join(TEST_DIR, "src", "baz.ts"), "export const baz = 3;\\n".repeat(12), "utf-8")

    const output = {
      title: "Write",
      output: "ok",
      metadata: {},
    }

    await hook["tool.execute.after"]?.(
      { tool: "Write", sessionID, callID: "call-plan" } as any,
      output as any
    )

    //#then
    if (output.output.includes("ARGUS AUTO-REVIEW LAUNCHED")) {
      expect(launchMock).toHaveBeenCalledTimes(1)
      const launchArgs = launchMock.mock.calls[0]?.[0] as any
      expect(launchArgs.agent).toBe("argus")
      expect(launchArgs.parentSessionID).toBe(sessionID)
    }

    cleanupMessageStorage(sessionID)
  })
})
