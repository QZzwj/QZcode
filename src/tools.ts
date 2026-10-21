import { spawn } from 'node:child_process'
import { browserAvailability, browserSession, closeSharedBrowser } from './browser.ts'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ExecConfig } from './config.ts'
import type { ToolDef } from './llm.ts'

export interface ToolResult {
  ok: boolean
  output: string
}

export interface ToolRuntime {
  workspace: string
  exec: ExecConfig
  /** 取消信号：工具内部能中断的都要接上（命令、浏览器等待）。 */
  signal?: AbortSignal
  /**
   * 看图：截图之后把图片交给视觉模型，取回文字描述。
   * C 是纯文本模型时，靠这个"双模型"配合。
   */
  vision?: (file: string) => Promise<{ ok: boolean; description: string; error?: string }>
  /** 文件被修改/覆盖之前调用一次（宿主用它做快照，回滚用）。 */
  snapshot?: (absPath: string) => void
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Read-only tools are the only ones offered to the verifier. */
  readOnly: boolean
  run(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolResult> | ToolResult
}

const MAX_OUTPUT = 40_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__'])

// ------------------------------------------------------------------ shell glue

interface Shell {
  file: string
  argv(command: string): string[]
}

function which(bin: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        // unreadable PATH entry, keep looking
      }
    }
  }
  return null
}

let cachedShell: Shell | null = null

/**
 * Picks a shell that actually exists. `pwsh` is not installed everywhere (it is
 * missing on plenty of Windows boxes), and an overridden QZCODE_SHELL always wins.
 */
export function resolveShell(): Shell {
  if (cachedShell) return cachedShell
  const override = process.env.QZCODE_SHELL
  if (process.platform === 'win32') {
    // Windows 上模型写的多半是 POSIX 命令，所以 git bash 优先；没有才退回 PowerShell。
    const gitBash = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ].find((candidate) => existsSync(candidate))
    const candidates = [override, gitBash, which('bash'), 'pwsh', 'powershell', 'cmd'].filter(
      Boolean,
    ) as string[]
    for (const candidate of candidates) {
      const file = which(candidate) ?? (existsSync(candidate) ? candidate : null)
      if (!file) continue
      const isCmd = /cmd(\.exe)?$/i.test(file)
      const isBash = /bash(\.exe)?$/i.test(file)
      cachedShell = {
        file,
        argv: (command) =>
          isBash
            ? ['-lc', command]
            : isCmd
              ? ['/d', '/s', '/c', command]
              : [
                  '-NoLogo',
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  // PowerShell 默认输出 GBK，模型看到的是乱码；强制 UTF-8
                  `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ${command}`,
                ],
      }
      return cachedShell
    }
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    cachedShell = { file: comspec, argv: (command) => ['/d', '/s', '/c', command] }
    return cachedShell
  }
  const sh = override ?? which('bash') ?? '/bin/sh'
  cachedShell = { file: sh, argv: (command) => ['-lc', command] }
  return cachedShell
}

interface SpawnOptions {
  cwd: string
  timeoutMs: number
  /** 'pipe' can be blocked by sandboxes (EPERM); 'file' is the fallback. */
  mode: 'pipe' | 'file'
  /** 停止运行时传进来：一 abort 就把子进程（含子进程树）掐掉。 */
  signal?: AbortSignal
}

/**
 * 杀掉整棵进程树。Windows 上 child.kill() 只杀 shell，孙子进程会活下来
 * （npm/node 起的服务最典型），所以优先用 taskkill /T /F。
 */
/** 取消信号已经 abort 就立刻抛 AbortError（工具内部用）。 */
function throwAbortIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('已取消')
    error.name = 'AbortError'
    throw error
  }
}

/** 可中断的等待：取消时立刻返回，不等满。 */
async function cancellableWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return
  }
  throwAbortIfCancelled(signal)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
  throwAbortIfCancelled(signal)
}

function killTree(child: { pid?: number; kill: () => boolean }): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    }
    child.kill()
  } catch {
    try {
      child.kill()
    } catch {
      // 已经没了
    }
  }
}

async function spawnShell(shell: Shell, command: string, options: SpawnOptions): Promise<ToolResult> {
  return await new Promise<ToolResult>((resolvePromise) => {
    let outPath = ''
    let errPath = ''
    let outFd = -1
    let errFd = -1
    let stdio: Array<'ignore' | 'pipe' | number>
    if (options.mode === 'file') {
      const tmpDir = join(options.cwd, '.qzcode', 'tmp')
      mkdirSync(tmpDir, { recursive: true })
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      outPath = join(tmpDir, `out-${stamp}.log`)
      errPath = join(tmpDir, `err-${stamp}.log`)
      outFd = openSync(outPath, 'w')
      errFd = openSync(errPath, 'w')
      stdio = ['ignore', outFd, errFd]
    } else {
      stdio = ['ignore', 'pipe', 'pipe']
    }

    let stdout = ''
    let stderr = ''
    let child: import('node:child_process').ChildProcess

    const cleanup = () => {
      if (outFd >= 0) {
        try {
          closeSync(outFd)
        } catch {
          // already closed
        }
      }
      if (errFd >= 0) {
        try {
          closeSync(errFd)
        } catch {
          // already closed
        }
      }
    }

    const readFiles = () => {
      if (options.mode !== 'file') return
      try {
        stdout += readFileSync(outPath, 'utf8')
      } catch {
        // no output file
      }
      try {
        stderr += readFileSync(errPath, 'utf8')
      } catch {
        // no output file
      }
      try {
        unlinkSync(outPath)
        unlinkSync(errPath)
      } catch {
        // best effort
      }
    }

    try {
      // spawn() throws synchronously for EPERM/EINVAL, so this try is load-bearing.
      child = spawn(shell.file, shell.argv(command), {
        cwd: options.cwd,
        env: { ...process.env, QZCODE_ACTOR: 'agent' },
        windowsHide: true,
        stdio: stdio as never,
      })
    } catch (error) {
      cleanup()
      if ((error as NodeJS.ErrnoException).code === 'EPERM' && options.mode === 'pipe') {
        // Piped stdio is refused by the sandbox: reject so the caller retries with files.
        throw error
      }
      resolvePromise({ ok: false, output: `[无法启动 shell ${shell.file}: ${(error as Error).message}]` })
      return
    }

    let settled = false
    const finish = (ok: boolean, note = '') => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      cleanup()
      readFiles()
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
      resolvePromise({ ok, output: clip((out || '(无输出)') + (note ? `\n${note}` : '')) })
    }

    const timer = setTimeout(() => {
      killTree(child)
      finish(false, `[超时 ${options.timeoutMs}ms，进程已终止]`)
    }, options.timeoutMs)

    // 硬中断：停止按钮一按就掐掉正在跑的命令，不等它自然结束
    const onAbort = () => {
      killTree(child)
      finish(false, '[已取消：命令被中断]')
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
      if (stdout.length > MAX_OUTPUT * 2) stdout = stdout.slice(-MAX_OUTPUT)
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      finish(false, `[无法启动 shell: ${error.code ?? error.message}]`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code === 0, code === 0 ? '' : `[退出码 ${code}]`)
    })
  })
}

/**
 * Runs a command through the resolved shell. Piped stdio is tried first because
 * it streams; if the sandbox refuses the pipe (EPERM) we fall back to temporary
 * files inside the workspace, which are allowed even in confined modes.
 */
export async function execShell(command: string, options: SpawnOptions): Promise<ToolResult> {
  const shell = resolveShell()
  if (options.mode === 'pipe') {
    try {
      return await spawnShell(shell, command, options)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  }
  return await spawnShell(shell, command, { ...options, mode: 'file' })
}


export function clip(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
  return `${head}\n… [输出被截断，共 ${text.length} 字符]`
}

export function resolveInside(workspace: string, target: string): string {
  const base = resolve(workspace)
  const full = isAbsolute(target) ? resolve(target) : resolve(base, target)
  const rel = relative(base, full)
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new Error(`路径越界: ${target} 不在工作区 ${base} 之内`)
  }
  return full
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`参数 "${key}" 必须是非空字符串`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function walk(root: string, limit: number): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= limit) break
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  return out
}

/** Minimal glob: `*`, `?`, `**`, and `{a,b}` alternation. */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          out += '(?:[^/]*/)*'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '{') {
      const end = pattern.indexOf('}', i)
      if (end > i) {
        const options = pattern.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        out += `(?:${options.join('|')})`
        i = end
      } else {
        out += '\\{'
      }
    } else if ('.+^$()|[]\\'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`^${out}$`)
}

function matchesGlob(relPath: string, pattern: string): boolean {
  const normalized = relPath.split(sep).join('/')
  const regex = globToRegExp(pattern)
  if (regex.test(normalized)) return true
  if (!pattern.includes('/')) {
    const base = normalized.split('/').pop() ?? ''
    return globToRegExp(pattern).test(base)
  }
  return false
}

export function createTools(): ToolSpec[] {
  const ls: ToolSpec = {
    name: 'ls',
    description: '列出目录内容（相对工作区）。按字母排序，目录带 "/" 后缀，包含点文件，跳过 .git/node_modules。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录（默认当前工作区）' },
        limit: { type: 'number', description: '最多返回条数，默认 500' },
      },
    },
    run(args, runtime) {
      const target = resolveInside(runtime.workspace, optionalString(args, 'path') ?? '.')
      const limit = Math.max(1, Math.min(2000, Math.trunc(optionalNumber(args, 'limit') ?? 500)))
      if (!existsSync(target)) return { ok: false, output: `目录不存在: ${target}` }
      let entries: import('node:fs').Dirent[]
      try {
        entries = readdirSync(target, { withFileTypes: true })
      } catch (error) {
        return { ok: false, output: `无法读取目录: ${(error as Error).message}` }
      }
      const lines = entries
        .filter((entry) => !SKIP_DIRS.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      const truncated = entries.length > limit ? `\n… 还有 ${entries.length - limit} 项` : ''
      return { ok: true, output: clip((lines.join('\n') || '(空目录)') + truncated) }
    },
  }

  const read: ToolSpec = {
    name: 'read',
    description: '读取文本文件，返回带行号的内容。用 offset/limit 分段读大文件。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作区）' },
        offset: { type: 'number', description: '起始行号，1 起（默认 1）' },
        limit: { type: 'number', description: '最多读取行数（默认 800）' },
      },
      required: ['path'],
    },
    run(args, runtime) {
      const target = resolveInside(runtime.workspace, requireString(args, 'path'))
      if (!existsSync(target)) return { ok: false, output: `文件不存在: ${target}` }
      const stat = statSync(target)
      if (stat.isDirectory()) return { ok: false, output: `这是一个目录，请用 ls: ${target}` }
      if (stat.size > 2_000_000) return { ok: false, output: `文件过大 (${stat.size}B)，请用 grep 定位片段` }
      const text = readFileSync(target, 'utf8')
      const offset = Math.max(1, Math.trunc(optionalNumber(args, 'offset') ?? 1))
      const limit = Math.max(1, Math.trunc(optionalNumber(args, 'limit') ?? 800))
      const lines = text.split(/\r?\n/)
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = slice.map((line, index) => `${String(offset + index).padStart(5)}  ${line}`).join('\n')
      const remaining = lines.length - (offset - 1 + limit)
      const suffix = remaining > 0 ? `\n… 还有 ${remaining} 行，用 offset=${offset + limit} 继续` : ''
      return { ok: true, output: clip(body + suffix) }
    },
  }

  const write: ToolSpec = {
    name: 'write',
    description: '写入（覆盖）文件。父目录不存在时会创建。',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作区）' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
    run(args, runtime) {
      const target = resolveInside(runtime.workspace, requireString(args, 'path'))
      // 覆盖之前先存一份原件（宿主用它做回滚）
      runtime.snapshot?.(target)
      const content = typeof args.content === 'string' ? args.content : ''
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return { ok: true, output: `已写入 ${relative(runtime.workspace, target)} (${content.length} 字符)` }
    },
  }

  const edit: ToolSpec = {
    name: 'edit',
    description:
      '精确替换文件中的文本。支持两种形式：{path, oldText, newText} 或 {path, edits:[{oldText,newText}, …]}。' +
      '每段 oldText 必须在原文件中唯一出现，多个 edits 不能重叠；任一失败则整体不生效。',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作区）' },
        oldText: { type: 'string', description: '要被替换的原文，必须在文件中唯一' },
        newText: { type: 'string', description: '替换后的文本' },
        edits: {
          type: 'array',
          description: '多处替换（与 oldText/newText 二选一）',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path'],
    },
    run(args, runtime) {
      const target = resolveInside(runtime.workspace, requireString(args, 'path'))
      runtime.snapshot?.(target)
      if (!existsSync(target)) return { ok: false, output: `文件不存在: ${target}` }
      const original = readFileSync(target, 'utf8')

      const rawEdits: { oldText: string; newText: string }[] = []
      if (Array.isArray(args.edits) && args.edits.length > 0) {
        for (const item of args.edits) {
          const entry = (item ?? {}) as Record<string, unknown>
          if (typeof entry.oldText !== 'string' || entry.oldText.length === 0) {
            return { ok: false, output: 'edits[].oldText 必须是非空字符串' }
          }
          rawEdits.push({ oldText: entry.oldText, newText: typeof entry.newText === 'string' ? entry.newText : '' })
        }
      } else {
        const oldText = requireString(args, 'oldText')
        rawEdits.push({ oldText, newText: typeof args.newText === 'string' ? args.newText : '' })
      }

      // Resolve every edit against the ORIGINAL text so edits cannot shift each other.
      const resolved: { start: number; end: number; newText: string }[] = []
      for (const [index, entry] of rawEdits.entries()) {
        const first = original.indexOf(entry.oldText)
        if (first < 0) {
          return { ok: false, output: `第 ${index + 1} 处 oldText 未找到（空白与换行需完全一致）` }
        }
        if (original.indexOf(entry.oldText, first + 1) >= 0) {
          return { ok: false, output: `第 ${index + 1} 处 oldText 出现了多次，请提供更长的唯一片段` }
        }
        resolved.push({ start: first, end: first + entry.oldText.length, newText: entry.newText })
      }
      resolved.sort((a, b) => a.start - b.start)
      for (let i = 1; i < resolved.length; i++) {
        if (resolved[i].start < resolved[i - 1].end) {
          return { ok: false, output: `第 ${i} 与第 ${i + 1} 处编辑区间重叠，请合并成一次替换` }
        }
      }
      let out = ''
      let cursor = 0
      for (const chunk of resolved) {
        out += original.slice(cursor, chunk.start) + chunk.newText
        cursor = chunk.end
      }
      out += original.slice(cursor)
      writeFileSync(target, out, 'utf8')
      const label = relative(runtime.workspace, target)
      return {
        ok: true,
        output: `已替换 ${label} 的 ${resolved.length} 处（${original.length} → ${out.length} 字符）`,
      }
    },
  }

  const find: ToolSpec = {
    name: 'find',
    description: '按 glob 模式查找文件，例如 "*.ts"、"src/**/*.json"。返回相对搜索目录的路径。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式' },
        path: { type: 'string', description: '搜索目录（默认工作区）' },
        limit: { type: 'number', description: '最多返回条数，默认 200' },
      },
      required: ['pattern'],
    },
    run(args, runtime) {
      const pattern = requireString(args, 'pattern')
      const base = resolveInside(runtime.workspace, optionalString(args, 'path') ?? '.')
      const limit = Math.max(1, Math.min(1000, Math.trunc(optionalNumber(args, 'limit') ?? 200)))
      const hits = walk(base, 8000)
        .map((file) => relative(base, file))
        .filter((rel) => matchesGlob(rel, pattern))
        .slice(0, limit)
      const suffix = hits.length >= limit ? `\n… 结果被截断到 ${limit} 条` : ''
      return {
        ok: true,
        output: hits.length > 0 ? hits.join('\n') + suffix : `没有匹配 ${pattern} 的文件`,
      }
    },
  }

  const grep: ToolSpec = {
    name: 'grep',
    description: '在文件内容里搜索，返回 文件:行号: 内容。pattern 默认按正则解析（literal:true 则按字面量）。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则或字面量' },
        path: { type: 'string', description: '目录或文件（默认工作区）' },
        glob: { type: 'string', description: '只搜匹配该 glob 的文件，例如 "*.ts"' },
        ignoreCase: { type: 'boolean', description: '忽略大小写，默认 false' },
        literal: { type: 'boolean', description: '按字面量搜索，默认 false' },
        limit: { type: 'number', description: '最多返回条数，默认 80' },
      },
      required: ['pattern'],
    },
    run(args, runtime) {
      const pattern = requireString(args, 'pattern')
      const literal = args.literal === true
      const ignoreCase = args.ignoreCase === true
      let regex: RegExp
      try {
        const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern
        regex = new RegExp(source, ignoreCase && !/\(\?[-a-z]*i/.test(source) ? 'i' : '')
      } catch (error) {
        return { ok: false, output: `正则无效: ${(error as Error).message}` }
      }
      const target = resolveInside(runtime.workspace, optionalString(args, 'path') ?? '.')
      const globFilter = optionalString(args, 'glob') ?? optionalString(args, 'include')
      const limit = Math.max(1, Math.min(400, Math.trunc(optionalNumber(args, 'limit') ?? 80)))

      let files: string[]
      try {
        files = statSync(target).isDirectory() ? walk(target, 6000) : [target]
      } catch {
        return { ok: false, output: `路径不存在: ${target}` }
      }

      const hits: string[] = []
      for (const file of files) {
        if (hits.length >= limit) break
        const rel = relative(runtime.workspace, file)
        if (globFilter && !matchesGlob(rel, globFilter)) continue
        let text: string
        try {
          if (statSync(file).size > 1_000_000) continue
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        if (!regex.test(text)) continue
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (regex.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 240)}`)
        }
      }
      const suffix = hits.length >= limit ? `\n… 结果被截断到 ${limit} 条` : ''
      return {
        ok: true,
        output: hits.length > 0 ? clip(hits.join('\n') + suffix) : `没有匹配 ${pattern} 的内容`,
      }
    },
  }

  const bash: ToolSpec = {
    name: 'bash',
    description: '在工作区执行一条 shell 命令，返回 stdout 与 stderr。timeout 单位为秒。',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', description: '超时（秒），默认取配置' },
      },
      required: ['command'],
    },
    async run(args, runtime) {
      const command = requireString(args, 'command')
      if (!runtime.exec.enabled) {
        return { ok: false, output: '命令执行已被禁用（--no-exec 或 exec.enabled=false）' }
      }
      const seconds = optionalNumber(args, 'timeout')
      const timeoutMs =
        seconds !== undefined
          ? Math.max(1000, Math.trunc(seconds * 1000))
          : Math.max(1000, Math.trunc(optionalNumber(args, 'timeoutMs') ?? runtime.exec.timeoutMs))
      const result = await execShell(command, {
        cwd: runtime.workspace,
        timeoutMs,
        mode: 'pipe',
        signal: runtime.signal,
      })
      if (result.ok) return result
      // 失败时把"为什么"说清楚，省得模型反复试同一条命令
      const output = String(result.output ?? '')
      const hints: string[] = []
      if (/退出码 1\b/.test(output) || /退出码 2\b/.test(output)) {
        hints.push('常见原因：路径/文件不存在、命令不存在、权限不足（stderr 关掉时看不到具体原因，别用 2>/dev/null 遮挡错误）')
      }
      if (/not found|command not found|No such file or directory/i.test(output)) {
        hints.push('这条命令在这个 shell 里不存在：先用 which/command -v 确认，或者换成等价的工具')
      }
      if (/^\s*(ls|find|cat|head|tail|grep)\b/.test(command)) {
        hints.push('只是看文件的话，优先用 read / ls / grep 工具（不计入命令失败、输出更好读）')
      }
      if (hints.length === 0) return result
      return { ...result, output: `${output}\n[提示] ${hints.join('；')}` }
    },
  }

  /**
   * 浏览器验证：真开浏览器点按钮、按住蓄力、截图、读 DOM。
   * 只读工具（只会往 .qzcode/shots 写截图），所以 C 也能用。
   */
  const browser: ToolSpec = {
    name: 'browser',
    description:
      '用真实浏览器验证网页/游戏，不用另装依赖。' +
      'action=open 打开网址或本地 html（target 可传相对工作区的路径）；' +
      'eval 执行 JS 表达式并返回结果（断言 DOM 就靠它）；' +
      'click 点坐标；hold 按住一段毫秒再松开（蓄力类交互），可传 key 改成按住键盘；' +
      'touch 模拟触屏按住松开；viewport 改视口（查响应式）；screenshot 截图存到 .qzcode/shots；' +
      'wait 等待；close 关掉浏览器。坐标是 CSS 像素，可以用 eval 拿 getBoundingClientRect 算。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'eval', 'click', 'hold', 'touch', 'viewport', 'screenshot', 'wait', 'close', 'status'],
          description: '要做的操作',
        },
        target: { type: 'string', description: 'open 用：网址或本地 html 路径' },
        expression: { type: 'string', description: 'eval 用：要在页面里执行的 JS 表达式' },
        x: { type: 'number', description: '坐标 x（CSS 像素）' },
        y: { type: 'number', description: '坐标 y（CSS 像素）' },
        ms: { type: 'number', description: 'hold/touch/wait 的毫秒数' },
        key: { type: 'string', description: 'hold 时改按键盘，比如 Space / Enter / ArrowUp' },
        width: { type: 'number', description: 'viewport/open 用：宽度' },
        height: { type: 'number', description: 'viewport/open 用：高度' },
        mobile: { type: 'boolean', description: 'viewport/open 用：是否移动端' },
        name: { type: 'string', description: 'screenshot 用的文件名' },
      },
      required: ['action'],
    },
    async run(args, runtime) {
      const action = requireString(args, 'action')
      const session = browserSession()
      const shotsDir = join(runtime.workspace, '.qzcode', 'shots')

      if (action === 'status') {
        const available = browserAvailability()
        const status = session.status()
        return {
          ok: true,
          output: available.ok
            ? `浏览器：${available.path}（来源 ${available.source}）` +
              (status.running ? `；已在跑，当前页面 ${status.url}` : '；还没打开页面')
            : '这台机器上没找到可用的 Chromium（装 Chrome/Edge，或 npx playwright install chromium）',
        }
      }

      if (action === 'close') {
        closeSharedBrowser()
        return { ok: true, output: '浏览器已关闭' }
      }

      try {
        if (action === 'open') {
          const target = requireString(args, 'target')
          const opened = await session.open({
            target,
            width: optionalNumber(args, 'width'),
            height: optionalNumber(args, 'height'),
            mobile: typeof args.mobile === 'boolean' ? args.mobile : undefined,
          })
          return {
            ok: true,
            output: `已打开 ${opened.url}\n标题：${opened.title}\n视口：${opened.viewport}` +
              '\n[提示] 断言就用 eval（例如匹配元素文本、scrollWidth 检查横向溢出）；截图是给人看的，文本模型读不到像素。',
          }
        }

        if (action === 'eval') {
          const expression = requireString(args, 'expression')
          const value = await session.evaluate(expression)
          const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
          return { ok: true, output: (text ?? 'undefined').slice(0, 4000) }
        }

        if (action === 'click') {
          await session.click(optionalNumber(args, 'x') ?? 0, optionalNumber(args, 'y') ?? 0)
          return { ok: true, output: '已点击' }
        }

        if (action === 'hold') {
          const ms = optionalNumber(args, 'ms') ?? 600
          await session.hold(ms, {
            x: optionalNumber(args, 'x'),
            y: optionalNumber(args, 'y'),
            key: optionalString(args, 'key'),
          })
          return { ok: true, output: `已按住 ${ms}ms 后松开` }
        }

        if (action === 'touch') {
          const ms = optionalNumber(args, 'ms') ?? 600
          await session.touchHold(ms, optionalNumber(args, 'x'), optionalNumber(args, 'y'))
          return { ok: true, output: `已模拟触屏按住 ${ms}ms 后松开` }
        }

        if (action === 'viewport') {
          const width = optionalNumber(args, 'width') ?? 1280
          const height = optionalNumber(args, 'height') ?? 800
          await session.setViewport(width, height, args.mobile === true)
          return { ok: true, output: `视口已改成 ${width}x${height}${args.mobile === true ? '（移动端）' : ''}` }
        }

        if (action === 'screenshot') {
          const file = await session.screenshot(optionalString(args, 'name') ?? 'shot', shotsDir)
          const saved = `截图已保存：${file}`
          if (!runtime.vision) return { ok: true, output: saved }

          // 双模型：纯文本模型看不了图，交给视觉模型看完转述
          const seen = await runtime.vision(file)
          if (!seen.ok) {
            return { ok: true, output: `${saved}\n[视觉模型没能看图：${seen.error ?? '未知原因'}]` }
          }
          return {
            ok: true,
            output: `${saved}\n[视觉模型看到的内容]\n${seen.description}`,
          }
        }

        if (action === 'wait') {
          await session.wait(optionalNumber(args, 'ms') ?? 500)
          return { ok: true, output: '等待完成' }
        }

        return { ok: false, output: `未知 action: ${action}` }
      } catch (error) {
        return { ok: false, output: `浏览器操作失败：${(error as Error).message}` }
      }
    },
  }

  return [read, bash, edit, write, grep, find, ls, browser]
}

/**
 * Extension hook points, mirroring pi's `tool_call` / `tool_result` events.
 * `before` may block a call; `after` may replace the text the model sees.
 */
export interface ToolCallEvent {
  toolName: string
  input: Record<string, unknown>
}

export interface ToolResultEvent {
  toolName: string
  input: Record<string, unknown>
  ok: boolean
  output: string
}

export interface ToolHooks {
  before?(event: ToolCallEvent): Promise<{ block?: boolean; reason?: string } | void> | { block?: boolean; reason?: string } | void
  after?(event: ToolResultEvent): Promise<{ output?: string } | void> | { output?: string } | void
}

export class Toolbox {
  private readonly specs = new Map<string, ToolSpec>()
  /** Set by the host when extensions register tool guards. */
  hooks: ToolHooks | null = null

  constructor(tools: ToolSpec[] = createTools()) {
    for (const tool of tools) this.specs.set(tool.name, tool)
  }

  register(tool: ToolSpec): void {
    this.specs.set(tool.name, tool)
  }

  get(name: string): ToolSpec | undefined {
    return this.specs.get(name)
  }

  list(options: { readOnly?: boolean; names?: string[] } = {}): ToolSpec[] {
    let tools = [...this.specs.values()]
    if (options.readOnly) tools = tools.filter((tool) => tool.readOnly)
    if (options.names) tools = tools.filter((tool) => options.names?.includes(tool.name))
    return tools
  }

  defs(options: { readOnly?: boolean; names?: string[] } = {}): ToolDef[] {
    return this.list(options).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  async call(name: string, rawArgs: string, runtime: ToolRuntime): Promise<ToolResult> {
    const tool = this.specs.get(name)
    if (!tool) return { ok: false, output: `未知工具: ${name}` }
    let args: Record<string, unknown> = {}
    if (rawArgs && rawArgs.trim() !== '') {
      try {
        const parsed = JSON.parse(rawArgs)
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
      } catch (error) {
        const looksTruncated = !rawArgs.trimEnd().endsWith('}')
        return {
          ok: false,
          output:
            `参数不是合法 JSON: ${(error as Error).message}` +
            (looksTruncated
              ? '\n[提示] 参数看起来被截断了（没有闭合的 }）——多半是输出超过 max_tokens。' +
                '把该角色的 maxTokens 调大后重试；或者分批写文件（先写骨架，再用 edit 补内容）。'
              : '') +
            `\n收到: ${rawArgs.slice(0, 300)}`,
        }
      }
    }

    try {
      const decision = await this.hooks?.before?.({ toolName: name, input: args })
      if (decision?.block) {
        return { ok: false, output: `被扩展阻止：${decision.reason ?? '没有给出原因'}` }
      }
    } catch (error) {
      return { ok: false, output: `扩展的 tool_call 钩子出错，已阻止该调用：${(error as Error).message}` }
    }

    let outcome: ToolResult
    try {
      outcome = await tool.run(args, runtime)
    } catch (error) {
      outcome = { ok: false, output: `工具执行失败: ${(error as Error).message}` }
    }

    try {
      const replacement = await this.hooks?.after?.({
        toolName: name,
        input: args,
        ok: outcome.ok,
        output: outcome.output,
      })
      if (replacement && typeof replacement.output === 'string') {
        return { ok: outcome.ok, output: replacement.output }
      }
    } catch {
      // A failing observer must not swallow a real result.
    }
    return outcome
  }
}
