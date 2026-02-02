import { describe, expect, test } from "bun:test"
import {
  resetReviewGateForTest,
  registerArgusReview,
  setArgusReviewVerdict,
  getBlockingArgusReviews,
  registerPlanReview,
  setPlanReviewVerdict,
  isPlanApproved,
} from "./index"

describe("review-gate", () => {
  test("blocks until Argus approves", () => {
    //#given
    resetReviewGateForTest()
    registerArgusReview({
      taskId: "bg_argus_1",
      parentSessionId: "ses_1",
      description: "Review task",
      files: ["src/a.ts"],
    })

    //#when
    const pending = getBlockingArgusReviews("ses_1")

    //#then
    expect(pending.length).toBe(1)

    //#when
    setArgusReviewVerdict("bg_argus_1", "approved")

    //#then
    expect(getBlockingArgusReviews("ses_1").length).toBe(0)
  })

  test("tracks plan approval via Momus", () => {
    //#given
    resetReviewGateForTest()
    registerPlanReview({
      planPath: ".sisyphus/plans/plan.md",
      sessionId: "ses_1",
      taskId: "bg_momus_1",
    })

    //#then
    expect(isPlanApproved(".sisyphus/plans/plan.md")).toBe(false)

    //#when
    setPlanReviewVerdict({
      planPath: ".sisyphus/plans/plan.md",
      verdict: "approved",
      sessionId: "ses_1",
    })

    //#then
    expect(isPlanApproved(".sisyphus/plans/plan.md")).toBe(true)
  })
})
