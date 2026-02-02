import { describe, test, expect } from "bun:test"
import { createArgusAgent, ARGUS_SYSTEM_PROMPT, argusPromptMetadata } from "./argus"

describe("createArgusAgent", () => {
  //#given
  const testModel = "openai/gpt-5.2"
  const testAnthropicModel = "anthropic/claude-sonnet-4-5"

  test("should create agent with correct mode (subagent)", () => {
    //#when
    const agent = createArgusAgent(testModel)

    //#then
    expect(agent.mode).toBe("subagent")
    expect(createArgusAgent.mode).toBe("subagent")
  })

  test("should create agent with low temperature for code review precision", () => {
    //#when
    const agent = createArgusAgent(testModel)

    //#then
    expect(agent.temperature).toBe(0.1)
  })

  test("should restrict write/edit tools (read-only reviewer)", () => {
    //#when
    const agent = createArgusAgent(testModel) as { permission?: Record<string, string> }

    //#then
    expect(agent.permission?.write).toBe("deny")
    expect(agent.permission?.edit).toBe("deny")
    expect(agent.permission?.task).toBe("deny")
    expect(agent.permission?.delegate_task).toBe("deny")
  })

  test("should configure GPT models with high reasoning effort", () => {
    //#when
    const agent = createArgusAgent(testModel) as { reasoningEffort?: string }

    //#then
    expect(agent.reasoningEffort).toBe("high")
  })

  test("should configure Anthropic models with extended thinking", () => {
    //#when
    const agent = createArgusAgent(testAnthropicModel) as { thinking?: { type: string; budgetTokens: number } }

    //#then
    expect(agent.thinking?.type).toBe("enabled")
    expect(agent.thinking?.budgetTokens).toBe(32000)
  })

  test("should include description for agent registry", () => {
    //#when
    const agent = createArgusAgent(testModel)

    //#then
    expect(agent.description).toContain("code reviewer")
    expect(agent.description).toContain("Argus")
  })
})

describe("ARGUS_SYSTEM_PROMPT", () => {
  //#given
  const prompt = ARGUS_SYSTEM_PROMPT

  test("should have strict bias (reject by default)", () => {
    //#then
    expect(prompt.toLowerCase()).toMatch(/strict.*bias|reject.*default|when in doubt.*reject/i)
  })

  test("should require type safety checks", () => {
    //#then
    expect(prompt.toLowerCase()).toContain("type safety")
    expect(prompt).toContain("any")
    expect(prompt).toContain("@ts-ignore")
  })

  test("should require lsp_diagnostics usage", () => {
    //#then
    expect(prompt).toContain("lsp_diagnostics")
  })

  test("should define severity levels (CRITICAL/MAJOR/MINOR)", () => {
    //#then
    expect(prompt).toContain("CRITICAL")
    expect(prompt).toContain("MAJOR")
    expect(prompt).toContain("MINOR")
  })

  test("should require specific actionable feedback", () => {
    //#then
    expect(prompt.toLowerCase()).toMatch(/specific.*actionable|actionable.*feedback/i)
  })

  test("should output APPROVE or REJECT verdict", () => {
    //#then
    expect(prompt).toContain("[APPROVE]")
    expect(prompt).toContain("[REJECT]")
  })
})

describe("argusPromptMetadata", () => {
  test("should be classified as advisor category", () => {
    //#then
    expect(argusPromptMetadata.category).toBe("advisor")
  })

  test("should be marked as EXPENSIVE cost", () => {
    //#then
    expect(argusPromptMetadata.cost).toBe("EXPENSIVE")
  })

  test("should have code review triggers", () => {
    //#then
    expect(argusPromptMetadata.triggers.length).toBeGreaterThan(0)
    const triggerText = argusPromptMetadata.triggers.map(t => t.domain + t.trigger).join(" ")
    expect(triggerText.toLowerCase()).toContain("code review")
  })

  test("should have useWhen guidance for task completion", () => {
    //#then
    expect(argusPromptMetadata.useWhen).toBeDefined()
    const useWhenText = argusPromptMetadata.useWhen?.join(" ") ?? ""
    expect(useWhenText.toLowerCase()).toMatch(/complet|finish|done/i)
  })

  test("should have keyTrigger for Sisyphus prompt", () => {
    //#then
    expect(argusPromptMetadata.keyTrigger).toBeDefined()
    expect(argusPromptMetadata.keyTrigger?.toLowerCase()).toContain("review")
  })
})
