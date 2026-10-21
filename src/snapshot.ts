import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/**
 * 快照 / 回滚 / diff。
 *
 * 时机：B（或任何角色）第一次要动的文件，在**被修改之前**存一份原件。
 * 结果：`.qzcode/snapshots/<runId>/` 下有 index.json + 每个文件的原始副本，
 *       外加 created 列表（这些文件是本次新建的，回滚时要删掉）。
 */

export interface SnapshotEntry {
  /** 相对工作区的路径（统一用 /）。 */
  path: string
  /** 快照文件在快照目录里的名字；null = 本次新建的文件（回滚时删除）。 */
  file: string | null
  bytes: number
}

export interface SnapshotIndex {
  runId: string
  workspace: string
  createdAt: number
  entries: SnapshotEntry[]
}

const SNAP_ROOT = '.qzcode/snapshots'

function normalize(relativePath: string): string {
  return relativePath.split(sep).join('/')
}

export class SnapshotStore {
  readonly runId: string
  readonly workspace: string
  readonly dir: string
  private index: SnapshotIndex
  private seen = new Set<string>()

  constructor(runId: string, workspace: string) {
    this.runId = runId
    this.workspace = workspace
    this.dir = join(workspace, SNAP_ROOT, runId)
    this.index = { runId, workspace, createdAt: Date.now(), entries: [] }
  }

  /** 在文件被修改之前调用：把原件存一份（同一个文件只存第一次）。 */
  capture(absPath: string): void {
    const rel = normalize(relative(this.workspace, absPath))
    if (rel.startsWith('..') || this.seen.has(rel)) return
    // 不给自己做快照（避免把 .qzcode 里的东西卷进来）
    if (rel.startsWith('.qzcode/')) return
    this.seen.add(rel)

    try {
      if (!existsSync(absPath)) {
        // 新建的文件：回滚时删掉它，所以这里也要落盘
        this.index.entries.push({ path: rel, file: null, bytes: 0 })
        this.persist()
        return
      }
      if (!statSync(absPath).isFile()) return
      const target = join(this.dir, rel.replace(/\//g, '__'))
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(absPath, target)
      this.index.entries.push({ path: rel, file: rel.replace(/\//g, '__'), bytes: statSync(absPath).size })
      this.persist()
    } catch {
      // 快照失败不该影响正常写入
    }
  }

  persist(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(join(this.dir, 'index.json'), JSON.stringify(this.index, null, 2), 'utf8')
    } catch {
      // 忽略
    }
  }

  get entries(): SnapshotEntry[] {
    return [...this.index.entries]
  }

  get touched(): number {
    return this.index.entries.length
  }

  /** 回滚：把原件写回去，删掉本次新建的文件。 */
  restore(): { restored: string[]; deleted: string[]; failed: { path: string; error: string }[] } {
    const restored: string[] = []
    const deleted: string[] = []
    const failed: { path: string; error: string }[] = []

    for (const entry of this.index.entries) {
      const abs = join(this.workspace, entry.path)
      try {
        if (entry.file === null) {
          if (existsSync(abs)) {
            rmSync(abs, { force: true })
            deleted.push(entry.path)
          }
          continue
        }
        const source = join(this.dir, entry.file)
        if (!existsSync(source)) {
          failed.push({ path: entry.path, error: '快照副本丢失' })
          continue
        }
        mkdirSync(dirname(abs), { recursive: true })
        copyFileSync(source, abs)
        restored.push(entry.path)
      } catch (error) {
        failed.push({ path: entry.path, error: (error as Error).message })
      }
    }
    return { restored, deleted, failed }
  }
}

/** 用磁盘上的 index 回滚（不依赖内存里的 store）。 */
export function restoreFromIndex(
  workspace: string,
  index: SnapshotIndex,
): { restored: string[]; deleted: string[]; failed: { path: string; error: string }[] } {
  const restored: string[] = []
  const deleted: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const entry of index.entries) {
    const abs = join(workspace, entry.path)
    try {
      if (entry.file === null) {
        if (existsSync(abs)) {
          rmSync(abs, { force: true })
          deleted.push(entry.path)
        }
        continue
      }
      const source = join(workspace, SNAP_ROOT, index.runId, entry.file)
      if (!existsSync(source)) {
        failed.push({ path: entry.path, error: '快照副本丢失' })
        continue
      }
      mkdirSync(dirname(abs), { recursive: true })
      copyFileSync(source, abs)
      restored.push(entry.path)
    } catch (error) {
      failed.push({ path: entry.path, error: (error as Error).message })
    }
  }
  return { restored, deleted, failed }
}

/** 读一个已存在的快照（按 runId）。 */
export function loadSnapshot(workspace: string, runId: string): SnapshotIndex | null {
  const file = join(workspace, SNAP_ROOT, runId, 'index.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SnapshotIndex
  } catch {
    return null
  }
}

/** 列出这个工作区里所有快照（新的在前）。 */
export function listSnapshots(workspace: string): { runId: string; createdAt: number; count: number }[] {
  const root = join(workspace, SNAP_ROOT)
  if (!existsSync(root)) return []
  try {
    return readdirSync(root)
      .map((name) => {
        const index = loadSnapshot(workspace, name)
        return index ? { runId: index.runId, createdAt: index.createdAt, count: index.entries.length } : null
      })
      .filter((item): item is { runId: string; createdAt: number; count: number } => item !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ 行级 diff

/** 极简 LCS：返回两个字符串数组的最长公共子序列长度表。 */
function lcsMatrix(a: string[], b: string[]): number[][] {
  const matrix: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1])
    }
  }
  return matrix
}

/** 生成统一格式的 diff（就够在 UI 里看）。 */
export function unifiedDiff(before: string, after: string, label: string, context = 2): string {
  const a = before.split('\n')
  const b = after.split('\n')
  if (before === after) return ''
  const matrix = lcsMatrix(a, b)
  const ops: { type: ' ' | '-' | '+'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] })
      i++
      j++
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      ops.push({ type: '-', text: a[i] })
      i++
    } else {
      ops.push({ type: '+', text: b[j] })
      j++
    }
  }
  while (i < a.length) ops.push({ type: '-', text: a[i++] })
  while (j < b.length) ops.push({ type: '+', text: b[j++] })

  // 只保留有改动的窗口（前后各 context 行）
  const keep = new Array(ops.length).fill(false)
  ops.forEach((op, index) => {
    if (op.type === ' ') return
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = true
  })

  const lines: string[] = []
  let oldLine = 1
  let newLine = 1
  let lastKept = -2
  ops.forEach((op, index) => {
    if (!keep[index]) {
      if (op.type !== '+') oldLine++
      if (op.type !== '-') newLine++
      return
    }
    if (index !== lastKept + 1) {
      lines.push(`@@ 约第 ${oldLine} 行 @@`)
    }
    lastKept = index
    lines.push(`${op.type}${op.text}`)
    if (op.type !== '+') oldLine++
    if (op.type !== '-') newLine++
  })
  return [`--- ${label}（改动前）`, `+++ ${label}（改动后）`, ...lines].join('\n')
}

export interface FileDiff {
  path: string
  status: 'created' | 'modified' | 'deleted'
  added: number
  removed: number
  diff: string
}

/** 拿快照和现状对比，产出每个文件的 diff。 */
export function diffSnapshot(workspace: string, index: SnapshotIndex): FileDiff[] {
  const out: FileDiff[] = []
  for (const entry of index.entries) {
    const abs = join(workspace, entry.path)
    const exists = existsSync(abs)
    const current = exists ? readFileSync(abs, 'utf8') : ''
    const before = entry.file ? readFileSync(join(workspace, SNAP_ROOT, index.runId, entry.file), 'utf8') : ''

    if (entry.file === null) {
      if (!exists) continue
      out.push({
        path: entry.path,
        status: 'created',
        added: current.split('\n').length,
        removed: 0,
        diff: unifiedDiff('', current, `新建 ${entry.path}`),
      })
      continue
    }
    if (!exists) {
      out.push({
        path: entry.path,
        status: 'deleted',
        added: 0,
        removed: before.split('\n').length,
        diff: unifiedDiff(before, '', `已删除 ${entry.path}`),
      })
      continue
    }
    if (before === current) continue
    const diff = unifiedDiff(before, current, entry.path)
    const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
    const removed = diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length
    out.push({ path: entry.path, status: 'modified', added, removed, diff })
  }
  return out
}
