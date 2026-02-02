import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TEST_STORAGE_ROOT = join(tmpdir(), `argus-auto-review-message-storage-${randomUUID()}`)
const TEST_MESSAGE_STORAGE = join(TEST_STORAGE_ROOT, "message")
const TEST_PART_STORAGE = join(TEST_STORAGE_ROOT, "part")

mock.module("../../features/hook-message-injector/constants", () => ({
  OPENCODE_STORAGE: TEST_STORAGE_ROOT,
  MESSAGE_STORAGE: TEST_MESSAGE_STORAGE,
  PART_STORAGE: TEST_PART_STORAGE,
}))

const { createArgusAutoReviewHook } = await import("./index")
const { MESSAGE_STORAGE } = await import("../../features/hook-message-injector")

function setupMessageStorage(sessionID: string, agent: string): void {
  const messageDir = join(MESSAGE_STORAGE, sessionID)
  if (!existsSync(messageDir)) {
    mkdirSync(messageDir, { recursive: true })
  }
  const messageData = {
    agent,
    model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
  }
  writeFileSync(join(messageDir, "msg_test001.json"), JSON.stringify(messageData))
}

function cleanupMessageStorage(sessionID: string): void {
  const messageDir = join(MESSAGE_STORAGE, sessionID)
  if (existsSync(messageDir)) {
    rmSync(messageDir, { recursive: true, force: true })
  }
}

describe("argus-auto-review hook", () => {
  let TEST_DIR: string

  beforeEach(() => {
    TEST_DIR = join(tmpdir(), `argus-auto-review-test-${randomUUID()}`)
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true })
    }
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true })
  })

  test("should launch Argus review after sync sisyphus-junior completion from Atlas", async () => {
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
      output: `## SUBAGENT WORK COMPLETED\n\n[FILE CHANGES SUMMARY]\nModified files:\n  src/foo.ts  (+1, -0)\n  src/bar.ts  (+2, -1)\n\n---\n\n**Subagent Response:**\n\nTask completed.`,
      metadata: {
        agent: "sisyphus-junior",
        category: "quick",
        description: "Implement foo",
        run_in_background: false,
        sessionId: "ses_subagent_123",
        sync: true,
      },
    }

    //#when
    await hook["tool.execute.after"]?.(
      { tool: "delegate_task", sessionID, callID: "call-123" } as any,
      output as any
    )

    //#then
    expect(launchMock).toHaveBeenCalledTimes(1)
    const launchArgs = launchMock.mock.calls[0]?.[0] as any
    expect(launchArgs.agent).toBe("argus")
    expect(launchArgs.parentSessionID).toBe(sessionID)
    expect(launchArgs.parentMessageID).toBe("call-123")
    expect(launchArgs.description.toLowerCase()).toContain("argus")
    expect(launchArgs.prompt).toContain("src/foo.ts")
    expect(launchArgs.prompt).toContain("src/bar.ts")

    expect(output.output).toContain("ARGUS AUTO-REVIEW")
    expect(output.output).toContain("bg_argus_123")

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
})
