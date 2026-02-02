import { parseAnthropicTokenLimitError } from "./parser"

describe("parseAnthropicTokenLimitError", () => {
  test("detects empty content errors with message index", () => {
    //#given
    const err = "The content field in the Message object at messages.3 is empty. Add a ContentBlock object."

    //#when
    const parsed = parseAnthropicTokenLimitError(err)

    //#then
    expect(parsed).toEqual(
      expect.objectContaining({
        errorType: "non-empty content",
        messageIndex: 3,
      }),
    )
  })
})
