/**
 * `@文件` 引用：目标里写 `@src/utils.ts`，就把那个文件的内容附给 A。
 *
 * 为什么放在后端解析：webview 碰不到文件系统，前端只能把 `@路径` 原样发过来，
 * 由后端判断"这个路径在工作区里存不存在、能不能读、该不该截断"。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export interface FileRef {
  /** 用户写的那个 token（不含 @） */
  raw: string
  /** 相对工作区的路径（统一 /） */
  path: string
  ok: boolean
  reason?: string
  chars?: number
}

const MAX_FILES = 4
const MAX_CHARS_PER_FILE = 6000
const MAX_BYTES = 256 * 1024
const BINARY_HINT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|exe|dll|so|dylib|mp4|mp3|woff2?|ttf)$/i

/** 从目标文本里抓 `@路径`（路径里允许空格以外的字符，允许 `/` 和 `\`）。 */
export function extractFileRefs(goal: string): string[] {
  const found: string[] = []
  // @ 前面必须有空白或标点（开头也算），否则 me@example.com 这种会被误判
  const pattern = /(^|[\s（(、，,：:])@([^\s@，。；、"'（）()]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(goal)) !== null) {
    const raw = match[2].replace(/[.,;:]+$/, '')
    if (raw && !found.includes(raw)) found.push(raw)
  }
  return found
}

/** 把 `@路径` 解析成工作区里的真实文件，并把内容读出来（带各种兜底）。 */
export function readFileRefs(workspace: string, refs: string[]): FileRef[] {
  const base = resolve(workspace)
  const out: FileRef[] = []

  for (const raw of refs.slice(0, MAX_FILES)) {
    const full = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
    const rel = relative(base, full).split('\\').join('/')

    if (rel.startsWith('..') || isAbsolute(rel)) {
      out.push({ raw, path: raw, ok: false, reason: '不在工作区内' })
      continue
    }
    if (BINARY_HINT.test(raw)) {
      out.push({ raw, path: rel, ok: false, reason: '二进制文件，跳过了' })
      continue
    }
    if (!existsSync(full)) {
      out.push({ raw, path: rel, ok: false, reason: '文件不存在' })
      continue
    }
    try {
      const size = statSync(full).size
      if (size > MAX_BYTES) {
        out.push({ raw, path: rel, ok: false, reason: `文件太大（${Math.round(size / 1024)}KB）` })
        continue
      }
      const text = readFileSync(full, 'utf8')
      out.push({ raw, path: rel, ok: true, chars: text.length })
    } catch (error) {
      out.push({ raw, path: rel, ok: false, reason: (error as Error).message })
    }
  }

  return out
}

/** 拼成给 A 看的"参考文件"段落；一个都读不到就返回空串。 */
export function buildReferenceBlock(workspace: string, refs: string[]): { block: string; files: FileRef[] } {
  const files = readFileRefs(workspace, refs)
  const usable = files.filter((file) => file.ok)
  if (usable.length === 0) return { block: '', files }

  const base = resolve(workspace)
  const parts: string[] = ['## 参考文件（用户用 @ 指定的，已附上原文）']

  for (const file of usable) {
    const full = resolve(base, file.path)
    let text = ''
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const clipped = text.length > MAX_CHARS_PER_FILE ? `${text.slice(0, MAX_CHARS_PER_FILE)}\n… [已截断]` : text
    parts.push(`### ${file.path}`, '```', clipped.trimEnd(), '```')
  }

  const skipped = files.filter((file) => !file.ok)
  if (skipped.length > 0) {
    parts.push(
      `（以下引用没用上：${skipped.map((file) => `${file.raw} —— ${file.reason}`).join('；')}）`,
    )
  }

  return { block: parts.join('\n'), files }
}
