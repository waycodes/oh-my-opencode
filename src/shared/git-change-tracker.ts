import { execSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"

export interface GitBaseline {
  dirtyFiles: Map<string, { hash: string | null }>
  headCommit?: string | null
}

export interface GitFileStat {
  path: string
  added: number
  removed: number
  status: "modified" | "added" | "deleted"
}

export interface TaskChangeSet {
  files: string[]
  stats: GitFileStat[]
  totalAdded: number
  totalRemoved: number
  diff: string
  isTrivial: boolean
  trivialReason?: string
}

const DEFAULT_TRIVIAL_MAX_LINES = 10
const MAX_DIFF_CHARS = 12000

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = (error as { stdout?: Buffer | string }).stdout
      if (stdout) return stdout.toString().trim()
    }
    return ""
  }
}

function getHeadCommit(directory: string): string | null {
  const head = safeExec("git rev-parse HEAD", directory)
  return head ? head.trim() : null
}

function hashFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  const stat = statSync(filePath)
  if (!stat.isFile()) return null
  const buf = readFileSync(filePath)
  return createHash("sha1").update(buf).digest("hex")
}

function parseStatus(cwd: string): Map<string, "modified" | "added" | "deleted"> {
  const statusOutput = safeExec("git status --porcelain", cwd)
  const statusMap = new Map<string, "modified" | "added" | "deleted">()
  if (!statusOutput) return statusMap

  const extractPath = (line: string): string => {
    let rawPath = line.slice(3)
    if (line.length > 2 && line[2] !== " ") {
      const parts = line.trim().split(/\s+/)
      rawPath = parts.slice(1).join(" ")
    }
    rawPath = rawPath.trim()
    return rawPath.includes(" -> ")
      ? rawPath.split(" -> ").pop()?.trim() ?? rawPath
      : rawPath
  }

  for (const line of statusOutput.split("\n")) {
    if (!line) continue
    const status = line.substring(0, 2).trim()
    const path = extractPath(line)

    if (!path) continue

    if (status === "A" || status === "??") {
      statusMap.set(path, "added")
    } else if (status === "D") {
      statusMap.set(path, "deleted")
    } else {
      statusMap.set(path, "modified")
    }
  }

  return statusMap
}

function parseCommitRangeStatus(cwd: string, commitRange: string): Map<string, "modified" | "added" | "deleted"> {
  const statusOutput = safeExec(`git diff --name-status ${commitRange}`, cwd)
  const statusMap = new Map<string, "modified" | "added" | "deleted">()
  if (!statusOutput) return statusMap

  for (const line of statusOutput.split("\n")) {
    if (!line) continue
    const parts = line.split("\t").map(p => p.trim()).filter(Boolean)
    if (parts.length < 2) continue
    const rawStatus = parts[0]
    const statusChar = rawStatus[0]
    let path = parts[1]
    if (statusChar === "R" && parts.length >= 3) {
      path = parts[2]
    }

    if (!path) continue
    if (statusChar === "A") {
      statusMap.set(path, "added")
    } else if (statusChar === "D") {
      statusMap.set(path, "deleted")
    } else {
      statusMap.set(path, "modified")
    }
  }

  return statusMap
}

function getDirtyFiles(cwd: string): string[] {
  const files = new Set<string>()
  const diff = safeExec("git diff --name-only HEAD", cwd)
  if (diff) {
    for (const line of diff.split("\n")) {
      const p = line.trim()
      if (p) files.add(p)
    }
  }

  const statusOutput = safeExec("git status --porcelain", cwd)
  if (statusOutput) {
    const extractPath = (line: string): string => {
      let rawPath = line.slice(3)
      if (line.length > 2 && line[2] !== " ") {
        const parts = line.trim().split(/\s+/)
        rawPath = parts.slice(1).join(" ")
      }
      rawPath = rawPath.trim()
      return rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop()?.trim() ?? rawPath
        : rawPath
    }
    for (const line of statusOutput.split("\n")) {
      if (!line) continue
      const path = extractPath(line)
      if (path) files.add(path)
    }
  }

  return Array.from(files)
}

function countFileLines(filePath: string): number {
  if (!existsSync(filePath)) return 0
  const stat = statSync(filePath)
  if (!stat.isFile()) return 0
  const content = readFileSync(filePath, "utf-8")
  if (content.length === 0) return 0
  return content.split(/\r?\n/).length
}

function getGitDiffStatsForFiles(cwd: string, files: string[], statusMap: Map<string, "modified" | "added" | "deleted">): GitFileStat[] {
  if (files.length === 0) return []

  const trackedFiles: string[] = []
  const untrackedFiles: string[] = []

  for (const file of files) {
    const status = statusMap.get(file)
    if (status === "added") {
      const tracked = safeExec(`git ls-files -- ${file}`, cwd)
      if (tracked) {
        trackedFiles.push(file)
      } else {
        untrackedFiles.push(file)
      }
    } else {
      trackedFiles.push(file)
    }
  }

  const statsMap = new Map<string, GitFileStat>()
  if (trackedFiles.length > 0) {
    const quoted = trackedFiles.map(f => `"${f.replace(/"/g, "\\\"")}"`).join(" ")
    let diffOutput = safeExec(`git diff --numstat HEAD -- ${quoted}`, cwd)
    if (!diffOutput) {
      diffOutput = safeExec(`git diff --numstat -- ${quoted}`, cwd)
    }
    if (diffOutput) {
      for (const line of diffOutput.split("\n")) {
        const parts = line.split("\t")
        if (parts.length < 3) continue
        const [addedStr, removedStr, path] = parts
        const added = addedStr === "-" ? 0 : parseInt(addedStr, 10)
        const removed = removedStr === "-" ? 0 : parseInt(removedStr, 10)
        const status = statusMap.get(path) ?? "modified"
        statsMap.set(path, { path, added, removed, status })
      }
    }
  }

  for (const file of files) {
    if (statsMap.has(file)) continue
    const status = statusMap.get(file) ?? "modified"
    if (status === "added") {
      const added = countFileLines(join(cwd, file))
      statsMap.set(file, { path: file, added, removed: 0, status })
    } else if (status === "deleted") {
      statsMap.set(file, { path: file, added: 0, removed: 0, status })
    } else {
      statsMap.set(file, { path: file, added: 0, removed: 0, status: "modified" })
    }
  }

  for (const file of untrackedFiles) {
    if (statsMap.has(file)) continue
    const added = countFileLines(join(cwd, file))
    statsMap.set(file, { path: file, added, removed: 0, status: "added" })
  }

  return Array.from(statsMap.values())
}

function buildDiffForFiles(cwd: string, files: string[], statusMap: Map<string, "modified" | "added" | "deleted">): string {
  if (files.length === 0) return ""

  const trackedFiles: string[] = []
  const untrackedFiles: string[] = []

  for (const file of files) {
    if (statusMap.get(file) === "added") {
      const fullPath = join(cwd, file)
      if (!existsSync(fullPath)) {
        trackedFiles.push(file)
      } else if (safeExec(`git ls-files -- ${file}`, cwd)) {
        trackedFiles.push(file)
      } else {
        untrackedFiles.push(file)
      }
    } else {
      trackedFiles.push(file)
    }
  }

  const diffParts: string[] = []

  if (trackedFiles.length > 0) {
    const quoted = trackedFiles.map(f => `"${f.replace(/"/g, "\\\"")}"`).join(" ")
    const diff = safeExec(`git diff --unified=3 -- ${quoted}`, cwd)
    if (diff) diffParts.push(diff)
  }

  for (const file of untrackedFiles) {
    const diff = safeExec(`git diff --no-index --unified=3 /dev/null "${file.replace(/"/g, "\\\"")}"`, cwd)
    if (diff) diffParts.push(diff)
  }

  const combined = diffParts.join("\n\n")
  if (combined.length <= MAX_DIFF_CHARS) return combined
  return combined.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated]"
}

function buildDiffForCommitRange(cwd: string, commitRange: string): string {
  const diff = safeExec(`git diff --unified=3 ${commitRange}`, cwd)
  if (!diff) return ""
  if (diff.length <= MAX_DIFF_CHARS) return diff
  return diff.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated]"
}

function isDocPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.startsWith("docs/") || lower.includes("/docs/") || lower.endsWith(".md") || lower.endsWith(".mdx") || lower.startsWith("readme")
}

export function captureGitBaseline(directory: string): GitBaseline {
  const dirtyFiles = new Map<string, { hash: string | null }>()
  const files = getDirtyFiles(directory)
  for (const file of files) {
    const fullPath = join(directory, file)
    dirtyFiles.set(file, { hash: hashFile(fullPath) })
  }
  return { dirtyFiles, headCommit: getHeadCommit(directory) }
}

export interface CommitRangeChangeSet extends TaskChangeSet {
  commitRange: string
  baseCommit: string
  headCommit: string
}

export function computeCommittedChangesSinceBaseline(
  directory: string,
  baseline: GitBaseline,
  options?: { maxLines?: number }
): CommitRangeChangeSet | null {
  const baseCommit = baseline.headCommit
  const headCommit = getHeadCommit(directory)
  if (!baseCommit || !headCommit) return null
  if (baseCommit === headCommit) return null

  const commitRange = `${baseCommit}..${headCommit}`
  const filesRaw = safeExec(`git diff --name-only ${commitRange}`, directory)
  const files = filesRaw
    ? filesRaw.split("\n").map(f => f.trim()).filter(Boolean)
    : []

  if (files.length === 0) return null

  const statusMap = parseCommitRangeStatus(directory, commitRange)
  const stats = (() => {
    const diffOutput = safeExec(`git diff --numstat ${commitRange}`, directory)
    const statsMap = new Map<string, GitFileStat>()
    if (diffOutput) {
      for (const line of diffOutput.split("\n")) {
        const parts = line.split("\t")
        if (parts.length < 3) continue
        const [addedStr, removedStr, ...pathParts] = parts
        const path = pathParts.join("\t").trim()
        if (!path) continue
        const added = addedStr === "-" ? 0 : parseInt(addedStr, 10)
        const removed = removedStr === "-" ? 0 : parseInt(removedStr, 10)
        const status = statusMap.get(path) ?? "modified"
        statsMap.set(path, { path, added, removed, status })
      }
    }

    for (const file of files) {
      if (statsMap.has(file)) continue
      const status = statusMap.get(file) ?? "modified"
      statsMap.set(file, { path: file, added: 0, removed: 0, status })
    }

    return Array.from(statsMap.values())
  })()

  const totalAdded = stats.reduce((sum, s) => sum + s.added, 0)
  const totalRemoved = stats.reduce((sum, s) => sum + s.removed, 0)
  const diff = buildDiffForCommitRange(directory, commitRange)

  const maxLines = options?.maxLines ?? DEFAULT_TRIVIAL_MAX_LINES
  const rawTotalChanged = totalAdded + totalRemoved
  const totalChanged = rawTotalChanged === 0 && files.length > 0
    ? maxLines + 1
    : rawTotalChanged

  return {
    files: files.sort(),
    stats,
    totalAdded,
    totalRemoved,
    diff,
    isTrivial: totalChanged <= 0,
    trivialReason: totalChanged <= 0 ? "No committed changes detected" : undefined,
    commitRange,
    baseCommit,
    headCommit,
  }
}

export function computeTaskScopedChanges(directory: string, baseline: GitBaseline, options?: { maxLines?: number }): TaskChangeSet {
  const currentDirty = getDirtyFiles(directory)
  const statusMap = parseStatus(directory)

  const changedFiles = currentDirty.filter((file) => {
    const baselineEntry = baseline.dirtyFiles.get(file)
    if (!baselineEntry) return true

    const currentHash = hashFile(join(directory, file))
    return baselineEntry.hash !== currentHash
  })

  const files = Array.from(new Set(changedFiles)).sort()
  const stats = getGitDiffStatsForFiles(directory, files, statusMap)
  const totalAdded = stats.reduce((sum, s) => sum + s.added, 0)
  const totalRemoved = stats.reduce((sum, s) => sum + s.removed, 0)

  const diff = buildDiffForFiles(directory, files, statusMap)

  const maxLines = options?.maxLines ?? DEFAULT_TRIVIAL_MAX_LINES
  const onlyDocsOrSisyphus = files.length > 0 && files.every((f) => f.startsWith(".sisyphus/") || isDocPath(f))
  const rawTotalChanged = totalAdded + totalRemoved
  const hasUnknownModified = stats.some(s => s.status === "modified" && s.added === 0 && s.removed === 0)
  const totalChanged = (rawTotalChanged === 0 && files.length > 0) || hasUnknownModified
    ? maxLines + 1
    : rawTotalChanged

  let isTrivial = false
  let trivialReason: string | undefined

  if (files.length === 0) {
    isTrivial = true
    trivialReason = "No task-scoped changes detected"
  } else if (onlyDocsOrSisyphus) {
    isTrivial = true
    trivialReason = "Docs-only or .sisyphus-only changes"
  } else if (totalChanged <= maxLines) {
    isTrivial = true
    trivialReason = `Small change (${totalChanged} lines)`
  }

  return {
    files,
    stats,
    totalAdded,
    totalRemoved,
    diff,
    isTrivial,
    trivialReason,
  }
}
