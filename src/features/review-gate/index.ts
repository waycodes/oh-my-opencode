export type ReviewVerdict = "pending" | "approved" | "rejected" | "failed"

export interface ArgusReviewRecord {
  taskId: string
  parentSessionId: string
  subagentSessionId?: string
  description?: string
  files?: string[]
  diff?: string
  verdict: ReviewVerdict
  createdAt: Date
  updatedAt: Date
}

export interface PlanReviewRecord {
  planPath: string
  sessionId: string
  taskId?: string
  verdict: ReviewVerdict
  createdAt: Date
  updatedAt: Date
}

const argusByTask = new Map<string, ArgusReviewRecord>()
const argusBySession = new Map<string, Set<string>>()
const planReviews = new Map<string, PlanReviewRecord>()

export function registerArgusReview(input: {
  taskId: string
  parentSessionId: string
  subagentSessionId?: string
  description?: string
  files?: string[]
  diff?: string
}): ArgusReviewRecord {
  const now = new Date()
  const record: ArgusReviewRecord = {
    taskId: input.taskId,
    parentSessionId: input.parentSessionId,
    subagentSessionId: input.subagentSessionId,
    description: input.description,
    files: input.files,
    diff: input.diff,
    verdict: "pending",
    createdAt: now,
    updatedAt: now,
  }

  argusByTask.set(record.taskId, record)
  const set = argusBySession.get(record.parentSessionId) ?? new Set()
  set.add(record.taskId)
  argusBySession.set(record.parentSessionId, set)

  return record
}

export function setArgusReviewVerdict(taskId: string, verdict: ReviewVerdict): void {
  const record = argusByTask.get(taskId)
  if (!record) return
  record.verdict = verdict
  record.updatedAt = new Date()
}

export function getBlockingArgusReviews(sessionId: string): ArgusReviewRecord[] {
  const ids = argusBySession.get(sessionId)
  if (!ids) return []
  const records: ArgusReviewRecord[] = []
  for (const id of ids) {
    const rec = argusByTask.get(id)
    if (!rec) continue
    if (rec.verdict !== "approved") {
      records.push(rec)
    }
  }
  return records
}

export function getArgusReview(taskId: string): ArgusReviewRecord | undefined {
  return argusByTask.get(taskId)
}

export function registerPlanReview(input: {
  planPath: string
  sessionId: string
  taskId?: string
}): PlanReviewRecord {
  const now = new Date()
  const record: PlanReviewRecord = {
    planPath: input.planPath,
    sessionId: input.sessionId,
    taskId: input.taskId,
    verdict: "pending",
    createdAt: now,
    updatedAt: now,
  }
  planReviews.set(input.planPath, record)
  return record
}

export function getPlanReview(planPath: string): PlanReviewRecord | undefined {
  return planReviews.get(planPath)
}

export function setPlanReviewVerdict(input: {
  planPath: string
  verdict: ReviewVerdict
  sessionId: string
  taskId?: string
}): void {
  const now = new Date()
  const existing = planReviews.get(input.planPath)
  if (existing) {
    existing.verdict = input.verdict
    existing.updatedAt = now
    existing.sessionId = input.sessionId
    if (input.taskId) existing.taskId = input.taskId
    return
  }

  planReviews.set(input.planPath, {
    planPath: input.planPath,
    sessionId: input.sessionId,
    taskId: input.taskId,
    verdict: input.verdict,
    createdAt: now,
    updatedAt: now,
  })
}

export function isPlanApproved(planPath: string): boolean {
  const record = planReviews.get(planPath)
  return record?.verdict === "approved"
}

export function extractArgusVerdict(text: string): ReviewVerdict | null {
  const normalized = text.toUpperCase()
  if (normalized.includes("[APPROVE]")) return "approved"
  if (normalized.includes("[REJECT]")) return "rejected"
  return null
}

export function extractMomusVerdict(text: string): ReviewVerdict | null {
  const normalized = text.toUpperCase()
  if (normalized.includes("[OKAY]")) return "approved"
  if (normalized.includes("[REJECT]")) return "rejected"
  return null
}

export function extractPlanPath(text: string): string | null {
  const match = text.match(/\.sisyphus[\\/]plans[\\/][^\s"')]+\.md/)
  return match?.[0] ?? null
}

export function resetReviewGateForTest(): void {
  argusByTask.clear()
  argusBySession.clear()
  planReviews.clear()
}
