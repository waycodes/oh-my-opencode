import { createSisyphusAgent } from "./sisyphus"

describe("createSisyphusAgent", () => {
  test("should require automated verification and avoid manual verification wording", () => {
    //#given
    const agent = createSisyphusAgent("anthropic/claude-opus-4-5", [])

    //#when
    const prompt = agent.prompt

    //#then
    expect(prompt).toContain("Automated verification completed for the change type")
    expect(prompt).not.toContain("Manual verification completed for the change type")
  })
})
