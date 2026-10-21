import type { AppConfig } from '../config.ts'
import { ROLE_SHORT, ROLE_TITLES } from '../config.ts'
import type { CommandRegistry } from '../commands.ts'
import type { PluginRecord } from '../kernel.ts'
import type { Usage } from '../llm.ts'
import { addUsage } from '../llm.ts'
import type { Phase, PaneId, Reporter, RunResult, ToolEvent } from '../pipeline.ts'
import { runPipeline } from '../pipeline.ts'
import type { ToolRuntime, Toolbox } from '../tools.ts'
import { parseKeys } from './keys.ts'
import type { Key } from './keys.ts'
import { Screen, fit, measure, plainText, wrap } from './screen.ts'
import type { Line, Span, Style } from './screen.ts'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const THEME = {
  accent: 'cyan',
  planner: 'magenta',
  implementer: 'green',
  verifier: 'yellow',
  system: 'blue',
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  rule: 8 as const,
}

const MUTED: Style = { fg: 8, dim: true }

const PHASE_LABEL: Record<Phase, string> = {
  idle: '待机',
  route: 'L 分流',
  plan: 'A 规划',
  implement: 'B 实现',
  review: 'A 复核',
  verify: 'C 核验',
  done: '结束',
}

const PHASE_PANE: Record<Phase, PaneId> = {
  idle: 'system',
  route: 'system',
  plan: 'planner',
  implement: 'implementer',
  review: 'planner',
  verify: 'verifier',
  done: 'system',
}

export interface TuiInputStream {
  isTTY?: boolean
  setRawMode?(mode: boolean): void
  setEncoding(encoding: BufferEncoding): void
  resume(): void
  pause(): void
  on(event: 'data', listener: (chunk: string) => void): unknown
  off(event: 'data', listener: (chunk: string) => void): unknown
}

export interface TuiOutputStream {
  columns?: number
  rows?: number
  write(chunk: string): unknown
  on(event: 'resize', listener: () => void): unknown
  off(event: 'resize', listener: () => void): unknown
}

export interface TuiOptions {
  config: AppConfig
  toolbox: Toolbox
  toolRuntime: ToolRuntime
  plugins: PluginRecord[]
  /** Extension-registered `/commands`. */
  commands?: CommandRegistry
  /** Kernel event sink so extensions can observe runs. */
  emit?: (event: string, payload?: unknown) => void
  goal?: string
  autoStart?: boolean
  /** Startup notes collected before the TUI took over (config warnings, plugin notices). */
  notices?: string[]
  /** Injectable streams: lets tests drive the real layout without a TTY. */
  out?: TuiOutputStream
  input?: TuiInputStream
}

interface PaneState {
  id: PaneId
  title: string
  spans: Span[]
  version: number
  scroll: number
  usage: Usage
  cache: { version: number; width: number; lines: Line[] } | null
}

function createPane(id: PaneId, title: string): PaneState {
  return {
    id,
    title,
    spans: [],
    version: 0,
    scroll: 0,
    usage: { prompt: 0, completion: 0, total: 0 },
    cache: null,
  }
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

function clipLine(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** Light markdown flavour: fences, headings, bullets, numbered steps. */
function decorate(lines: Line[], accent: Style['fg']): Line[] {
  const out: Line[] = []
  let inCode = false
  for (const line of lines) {
    const text = plainText(line)
    if (line.some((span) => span.style)) {
      out.push(line)
      continue
    }
    const trimmed = text.trimEnd()
    if (/^\s*```/.test(trimmed)) {
      inCode = !inCode
      out.push([{ text: trimmed, style: MUTED }])
      continue
    }
    if (inCode) {
      out.push([{ text: trimmed, style: { fg: 'green', dim: true } }])
      continue
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      out.push([
        { text: `${heading[1]} `, style: { fg: accent, bold: true } },
        { text: heading[2], style: { bold: true } },
      ])
      continue
    }
    const bullet = trimmed.match(/^(\s*)([-*+])\s+(.*)$/)
    if (bullet) {
      out.push([
        { text: bullet[1] },
        { text: `${bullet[2]} `, style: { fg: accent, bold: true } },
        { text: bullet[3] },
      ])
      continue
    }
    const numbered = trimmed.match(/^(\s*)(\d+[.)])\s+(.*)$/)
    if (numbered) {
      out.push([
        { text: numbered[1] },
        { text: `${numbered[2]} `, style: { fg: accent } },
        { text: numbered[3] },
      ])
      continue
    }
    out.push(line)
  }
  return out
}

function accentFor(id: PaneId): Style['fg'] {
  if (id === 'planner') return THEME.planner
  if (id === 'implementer') return THEME.implementer
  if (id === 'verifier') return THEME.verifier
  return THEME.system
}

export async function runTui(options: TuiOptions): Promise<void> {
  const { config, toolbox, toolRuntime } = options
  const out: TuiOutputStream = options.out ?? process.stdout
  const input: TuiInputStream = options.input ?? process.stdin
  const screen = new Screen(out)

  const panes: Record<PaneId, PaneState> = {
    planner: createPane('planner', ROLE_TITLES.planner),
    implementer: createPane('implementer', ROLE_TITLES.implementer),
    verifier: createPane('verifier', ROLE_TITLES.verifier),
    system: createPane('system', '日志'),
  }

  let buffer = options.goal ?? ''
  let cursor = buffer.length
  let history: string[] = []
  let historyIndex = -1
  let focus: PaneId = 'planner'
  let running = false
  let phase: Phase = 'idle'
  let round = 0
  let abort: AbortController | null = null
  let currentGoal = ''
  let startedAt = 0
  let finishedAt = 0
  let tick = 0
  let dirty = true
  let quit = false
  let resolveQuit: (() => void) | null = null
  let pending = ''
  let notice = ''
  let noticeLevel: 'info' | 'warn' | 'error' = 'info'
  let noticeUntil = 0
  const totals: Usage = { prompt: 0, completion: 0, total: 0 }

  const markDirty = () => {
    dirty = true
  }

  const setNotice = (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
    notice = message
    noticeLevel = level
    noticeUntil = Date.now() + 8000
    markDirty()
  }

  /** Single place that ends the UI, whether from a key, a command or a signal. */
  const requestQuit = () => {
    if (quit) return
    quit = true
    resolveQuit?.()
  }
  // ------------------------------------------------------------- pane writing

  const append = (id: PaneId, text: string, style?: Style) => {
    if (!text) return
    const pane = panes[id]
    const last = pane.spans[pane.spans.length - 1]
    const same =
      last !== undefined &&
      (style === undefined
        ? last.style === undefined
        : last.style !== undefined &&
          last.style.fg === style.fg &&
          !!last.style.dim === !!style.dim &&
          !!last.style.bold === !!style.bold)
    if (last && same) last.text += text
    else pane.spans.push({ text, style })
    const size = pane.spans.reduce((sum, span) => sum + span.text.length, 0)
    if (size > 400_000) {
      pane.spans = [{ text: '…（历史输出过长，已截断较早内容）\n', style: MUTED }, ...pane.spans.slice(-40)]
    }
    pane.version += 1
    if (pane.scroll === 0) markDirty()
  }

  const appendLine = (id: PaneId, text: string, style?: Style) => {
    append(id, text.endsWith('\n') ? text : `${text}\n`, style)
  }

  // ------------------------------------------------------------- pipeline sink

  const reporter: Reporter = {
    phase(next, nextRound) {
      phase = next
      round = nextRound
      if (next === 'plan' || next === 'implement' || next === 'verify') {
        const id = PHASE_PANE[next]
        appendLine(id, `\n── 第 ${nextRound} 轮 · ${PHASE_LABEL[next]} ──\n`, {
          fg: accentFor(id),
          bold: true,
        })
      }
      markDirty()
    },
    text(id, delta) {
      append(id, delta)
    },
    textEnd(id) {
      append(id, '\n')
    },
    tool(event) {
      const pane = panes[event.pane]
      if (event.stage === 'start') {
        appendLine(pane.id, `  → ${event.name} ${clipLine(event.args ?? '', 140)}`, MUTED)
        return
      }
      const color = event.ok ? THEME.ok : THEME.error
      const first = clipLine(
        (event.output ?? '').split(/\r?\n/).find((line) => line.trim()) ?? '',
        160,
      )
      appendLine(pane.id, `  ← ${event.name} ${event.ok ? 'ok' : 'FAIL'} ${event.ms ?? 0}ms  ${first}`, {
        fg: color,
        dim: true,
      })
    },
    note(message, level = 'info') {
      const color = level === 'error' ? THEME.error : level === 'warn' ? THEME.warn : THEME.system
      appendLine('system', `· ${message}`, { fg: color })
      setNotice(message, level)
    },
    verdict(nextRound, verdict) {
      const color = verdict.pass ? THEME.ok : THEME.error
      appendLine(
        panes.verifier.id,
        `\n判定（第 ${nextRound} 轮）：${verdict.pass ? '通过' : '未通过'} — ${verdict.summary}`,
        { fg: color, bold: true },
      )
      for (const issue of verdict.issues) {
        appendLine(panes.verifier.id, `  [${issue.severity}] ${issue.where}: ${issue.problem}`, {
          fg: issue.severity === 'blocker' ? THEME.error : THEME.warn,
        })
      }
    },
    usage(id, usage) {
      panes[id].usage = addUsage(panes[id].usage, usage)
      totals.prompt += usage.prompt
      totals.completion += usage.completion
      totals.total += usage.total
      markDirty()
    },
    done(result) {
      finishedAt = Date.now()
      const seconds = (result.elapsedMs / 1000).toFixed(1)
      appendLine(
        'system',
        result.ok
          ? `✔ 通过：${result.rounds} 轮，${seconds}s，tokens ${formatTokens(result.usage.total)}`
          : `✘ 未通过：${result.rounds} 轮，${seconds}s，tokens ${formatTokens(result.usage.total)}`,
        { fg: result.ok ? THEME.ok : THEME.error, bold: true },
      )
      setNotice(result.ok ? '完成：C 判定通过' : '结束：仍有未通过项', result.ok ? 'info' : 'warn')
    },
  }

  // --------------------------------------------------------------- task runs

  const startTask = async (goal: string) => {
    const trimmed = goal.trim()
    if (!trimmed) return
    if (running) {
      setNotice('正在运行中，Ctrl+C 先取消', 'warn')
      return
    }
    running = true
    currentGoal = trimmed
    startedAt = Date.now()
    finishedAt = 0
    round = 0
    abort = new AbortController()
    markDirty()
    try {
      await runPipeline({
        config,
        goal: trimmed,
        toolbox,
        toolRuntime,
        reporter,
        signal: abort.signal,
        emit: options.emit,
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        appendLine('system', '· 已取消', { fg: THEME.warn })
        setNotice('已取消', 'warn')
      } else {
        appendLine('system', `· 运行失败：${(error as Error).message}`, { fg: THEME.error })
        setNotice((error as Error).message, 'error')
      }
    } finally {
      running = false
      abort = null
      phase = 'done'
      finishedAt = Date.now()
      markDirty()
    }
  }

  // ------------------------------------------------------------------ commands

  const commands: Record<string, { run: (args: string) => void }> = {
    '/help': {
      run() {
        const extensionCommands = options.commands?.list() ?? []
        appendLine(
          'system',
          [
            '命令：',
            '  /help            显示帮助          /clear  清空面板',
            '  /mock            切换 mock 模型    /demo   用 mock 跑演示',
            '  /exec on|off     允许/禁止执行命令  /rounds <n>  最大轮次',
            '  /config          显示角色与端点      /plugins     已加载插件',
            '  /quit            退出',
            ...(extensionCommands.length > 0
              ? ['扩展命令：', ...extensionCommands.map((command) => `  /${command.name.padEnd(15)} ${command.description}`)]
              : []),
            '快捷键：Enter 运行 · Ctrl+C 取消/退出 · Tab 切面板 · Alt+1/2/3 定位 · PgUp/PgDn 滚动 · ↑/↓ 历史',
          ].join('\n'),
          { fg: THEME.system },
        )
      },
    },
    '/clear': {
      run() {
        for (const pane of Object.values(panes)) {
          pane.spans = []
          pane.version += 1
          pane.scroll = 0
        }
        totals.prompt = 0
        totals.completion = 0
        totals.total = 0
        setNotice('已清空')
      },
    },
    '/mock': {
      run() {
        const next = !config.roles.planner.mock
        for (const role of Object.values(config.roles)) role.mock = next
        setNotice(next ? '已切换到 mock 模型（不联网）' : '已切换到真实模型')
        appendLine('system', `· mock = ${next}`, { fg: THEME.system })
      },
    },
    '/exec': {
      run(args) {
        const value = args.trim().toLowerCase()
        if (value === 'on' || value === 'off') {
          config.exec.enabled = value === 'on'
          setNotice(`命令执行：${value}`)
        } else {
          setNotice('用法：/exec on|off', 'warn')
        }
      },
    },
    '/rounds': {
      run(args) {
        const value = Number.parseInt(args.trim(), 10)
        if (Number.isFinite(value) && value >= 1 && value <= 10) {
          config.maxRounds = value
          setNotice(`最大轮次 = ${value}`)
        } else {
          setNotice('用法：/rounds 1..10', 'warn')
        }
      },
    },
    '/config': {
      run() {
        const lines = [
          `配置文件: ${config.path || '(未找到，使用内置默认值)'}`,
          `工作区:   ${config.workspace}`,
          `轮次:     ${config.maxRounds}   步骤: ${config.maxSteps}   执行: ${config.exec.enabled ? 'on' : 'off'}`,
          ...Object.values(config.roles).map(
            (role) =>
              `${ROLE_SHORT[role.role]} ${role.role.padEnd(11)} ${role.model}  ${role.baseUrl}  ${
                role.mock ? '(mock)' : role.apiKey ? 'key✓' : 'key✗'
              }  temp=${role.temperature}`,
          ),
        ]
        appendLine('system', lines.join('\n'), { fg: THEME.system })
      },
    },
    '/plugins': {
      run() {
        if (options.plugins.length === 0) {
          appendLine('system', '· 没有加载插件（在配置 plugins[] 里加路径）', MUTED)
          return
        }
        const lines = options.plugins.map(
          (record) =>
            `  ${record.status === 'active' ? '✔' : record.status === 'skipped' ? '○' : '✘'} ${record.name}  ${record.source}${
              record.detail ? `  — ${record.detail}` : ''
            }`,
        )
        appendLine('system', ['插件：', ...lines].join('\n'), { fg: THEME.system })
      },
    },
    '/demo': {
      run() {
        for (const role of Object.values(config.roles)) role.mock = true
        void startTask('演示：在工作区写下 notes/plan.md，记录目标、策略与验证方式')
      },
    },
    '/quit': {
      run() {
        requestQuit()
      },
    },
  }

  const submit = () => {
    const value = buffer.trim()
    if (!value) return
    buffer = ''
    cursor = 0
    if (value.startsWith('/')) {
      const [name, ...rest] = value.split(/\s+/)
      const command = commands[name]
      if (!command) {
        const extension = options.commands?.get(name)
        if (!extension) {
          setNotice(`未知命令 ${name}，/help 查看`, 'warn')
          return
        }
        history = [...history, value].slice(-100)
        historyIndex = -1
        const args = rest.join(' ')
        void Promise.resolve()
          .then(() =>
            extension.handler(args, {
              notify: (message, level) => setNotice(message, level ?? 'info'),
              config,
            }),
          )
          .catch((error: unknown) => {
            setNotice(`/${extension.name} 执行失败：${(error as Error).message}`, 'error')
          })
        markDirty()
        return
      }
      command.run(rest.join(' '))
      history = [...history, value].slice(-100)
      historyIndex = -1
      markDirty()
      return
    }
    history = [...history, value].slice(-100)
    historyIndex = -1
    void startTask(value)
  }

  const cycleFocus = (delta: number) => {
    const order: PaneId[] = ['planner', 'implementer', 'verifier']
    const index = order.indexOf(focus === 'system' ? 'verifier' : focus)
    focus = order[(index + delta + order.length) % order.length]
    markDirty()
  }

  const scrollPane = (id: PaneId, delta: number) => {
    const pane = panes[id]
    const bodyHeight = Math.max(1, paneBodyHeight())
    const lines = wrappedLines(pane, contentWidth() - 1)
    const maxScroll = Math.max(0, lines.length - bodyHeight)
    pane.scroll = Math.min(maxScroll, Math.max(0, pane.scroll + delta))
    markDirty()
  }

  /** `ctrl+home` jumps to the oldest line, `ctrl+end` resumes following the tail. */
  const paneScrollToEdge = (edge: 'top' | 'bottom') => {
    if (edge === 'bottom') {
      panes[focus].scroll = 0
      markDirty()
      return
    }
    const pane = panes[focus]
    const bodyHeight = Math.max(1, paneBodyHeight())
    const lines = wrappedLines(pane, contentWidth() - 1)
    pane.scroll = Math.max(0, lines.length - bodyHeight)
    markDirty()
  }

  // ------------------------------------------------------------------ layout

  const columnsMode = (): boolean => (config.tui.columns === 'stack' ? false : screen.width >= 96)

  const contentWidth = (): number => {
    if (columnsMode()) return Math.max(12, Math.floor((screen.width - 6) / 3))
    return Math.max(12, screen.width)
  }

  const overheadRows = (): number => {
    const h = screen.height
    // title + goal? + rule + console(rule + 2 rows) + input + hint?
    return 1 + (h >= 14 ? 1 : 0) + 1 + 3 + 1 + (h >= 10 ? 1 : 0)
  }

  const paneBodyHeight = (): number => {
    const paneTotal = Math.max(3, screen.height - overheadRows())
    if (columnsMode()) return Math.max(1, paneTotal - 1)
    const block = Math.max(2, Math.floor((paneTotal - 2) / 3))
    return Math.max(1, block - 1)
  }

  function wrappedLines(pane: PaneState, width: number): Line[] {
    if (pane.cache && pane.cache.version === pane.version && pane.cache.width === width) {
      return pane.cache.lines
    }
    const lines = decorate(wrap(pane.spans, width), accentFor(pane.id))
    pane.cache = { version: pane.version, width, lines }
    return lines
  }

  function paneBlock(pane: PaneState, width: number, height: number): Line[] {
    const accent = accentFor(pane.id)
    const focused = focus === pane.id
    const lines = wrappedLines(pane, width - 1)
    const bodyHeight = Math.max(0, height - 1)
    const maxScroll = Math.max(0, lines.length - bodyHeight)
    if (pane.scroll > maxScroll) pane.scroll = maxScroll
    const start = Math.max(0, lines.length - bodyHeight - pane.scroll)
    const visible = lines.slice(start, start + bodyHeight)

    const busy = running && PHASE_PANE[phase] === pane.id
    const title: Line = [
      { text: focused ? '▌' : ' ', style: { fg: accent, bold: true } },
      { text: ` ${pane.title}`, style: { fg: accent, bold: focused } },
    ]
    if (busy) title.push({ text: ` ${SPINNER[tick % SPINNER.length]}`, style: { fg: accent } })
    const right: string[] = []
    if (pane.scroll > 0) right.push(`↑${pane.scroll}`)
    if (config.tui.showTokens && pane.usage.total > 0) right.push(formatTokens(pane.usage.total))
    if (right.length > 0) {
      const label = `${right.join(' · ')} `
      const used = measure(plainText(title)) + measure(label)
      if (used < width) title.push({ text: ' '.repeat(width - used) + label, style: MUTED })
    }

    const block: Line[] = [fit(title, width, MUTED)]
    for (let i = 0; i < bodyHeight; i++) block.push(visible[i] ?? [])
    while (block.length < height) block.push([])
    return block.slice(0, height)
  }

  function composePaneRows(width: number, height: number): Line[] {
    const ids: PaneId[] = ['planner', 'implementer', 'verifier']
    if (columnsMode()) {
      const colWidth = Math.max(10, Math.floor((width - 6) / 3))
      const contentRows = Math.max(1, height - 1)
      const blocks = ids.map((id) => paneBlock(panes[id], colWidth, contentRows))
      const rows: Line[] = []
      for (let row = 0; row < contentRows; row++) {
        const line: Line = []
        ids.forEach((id, index) => {
          if (index > 0) line.push({ text: '│', style: { fg: THEME.rule, dim: true } })
          line.push(...fit(blocks[index][row] ?? [], colWidth))
        })
        rows.push(fit(line, width))
      }
      rows.push([{ text: '─'.repeat(width), style: { fg: THEME.rule, dim: true } }])
      return rows
    }

    const blockHeight = Math.max(2, Math.floor((height - 2) / 3))
    const rows: Line[] = []
    ids.forEach((id, index) => {
      for (const row of paneBlock(panes[id], width, blockHeight)) rows.push(fit(row, width))
      if (index < ids.length - 1) {
        rows.push([{ text: '─'.repeat(width), style: { fg: THEME.rule, dim: true } }])
      }
    })
    // Three equal blocks rarely divide the region evenly; pad so the input line
    // stays glued to the bottom instead of drifting up a row or two.
    while (rows.length < height) rows.push([])
    return rows.slice(0, height)
  }

  function renderFrame(): { rows: Line[]; inputRow: number } {
    const width = screen.width
    const height = screen.height
    const showGoal = height >= 14
    const showHints = height >= 10
    const paneHeight = Math.max(3, height - overheadRows())
    const rows: Line[] = []

    // ---- title bar
    const elapsed = running || finishedAt > startedAt ? ((finishedAt || Date.now()) - startedAt) / 1000 : 0
    const bits = [`${PHASE_LABEL[phase]}${round > 0 ? ` ${round}/${config.maxRounds}` : ''}`]
    if (elapsed > 0) bits.push(`${elapsed.toFixed(1)}s`)
    if (totals.total > 0) bits.push(`${formatTokens(totals.total)} tok`)
    if (running) bits.push(SPINNER[tick % SPINNER.length])
    const status = `${bits.join(' · ')} `
    const titleLine: Line = [
      { text: ' QZcode ', style: { fg: 'black', bg: THEME.accent, bold: true } },
      { text: ' A 规划 → B 实现 → C 核验 ', style: { fg: THEME.accent, bold: true } },
    ]
    if (config.roles.planner.mock) titleLine.push({ text: 'mock ', style: { fg: THEME.warn, bold: true } })
    const usedWidth = measure(plainText(titleLine)) + measure(status)
    if (usedWidth < width - 1) titleLine.push({ text: ' '.repeat(width - 1 - usedWidth) })
    titleLine.push({ text: status, style: { ...MUTED, bold: true } })
    rows.push(fit(titleLine, width))

    // ---- goal line
    if (showGoal) {
      const goalText = currentGoal
        ? `目标：${clipLine(currentGoal, width - 8)}`
        : '输入目标后回车：A 拆提示词与验收标准，B 动手实现，C 独立核验。 /help 查看命令'
      rows.push(
        fit(
          [{ text: ' ' }, { text: clipLine(goalText, width - 2), style: currentGoal ? undefined : MUTED }],
          width,
        ),
      )
    }

    rows.push([{ text: '─'.repeat(width), style: { fg: THEME.rule, dim: true } }])

    // ---- panes
    for (const row of composePaneRows(width, paneHeight)) rows.push(row)

    // ---- console strip (system pane tail)
    const consoleWidth = Math.max(8, width - 2)
    const systemLines = wrappedLines(panes.system, consoleWidth)
    const consoleRows = 2
    const tail = systemLines.slice(Math.max(0, systemLines.length - consoleRows))
    const ruleLabel = '─ 日志 '
    rows.push(
      fit(
        [
          { text: ruleLabel, style: { fg: THEME.system, bold: true } },
          { text: '─'.repeat(Math.max(0, width - measure(ruleLabel))), style: { fg: THEME.rule, dim: true } },
        ],
        width,
      ),
    )
    for (let i = 0; i < consoleRows; i++) {
      rows.push(fit([{ text: ' ' }, ...(tail[i] ?? [])], width))
    }

    // ---- input
    const inputRow = rows.length + 1
    const available = Math.max(8, width - 3)
    let shownBuffer = buffer
    if (measure(shownBuffer) > available) {
      const headWidth = measure(buffer.slice(0, cursor))
      const start = headWidth > available ? Math.max(0, cursor - 12) : 0
      shownBuffer = buffer.slice(start)
    }
    rows.push(
      fit(
        [
          { text: running ? '⏸ ' : '› ', style: { fg: running ? THEME.warn : THEME.accent, bold: true } },
          { text: shownBuffer },
        ],
        width,
      ),
    )

    // ---- hint / notice
    if (showHints) {
      const active = notice.length > 0 && Date.now() < noticeUntil
      const text = active
        ? notice
        : running
          ? 'Ctrl+C 取消 · Tab 切面板 · PgUp/PgDn 滚动'
          : 'Enter 运行 · /help 命令 · Tab 切面板 · Alt+1/2/3 定位 · PgUp/PgDn 滚动 · Ctrl+C 退出'
      const color = active
        ? noticeLevel === 'error'
          ? THEME.error
          : noticeLevel === 'warn'
            ? THEME.warn
            : THEME.accent
        : 8
      rows.push(fit([{ text: clipLine(text, width - 1), style: { fg: color, dim: !active } }], width))
    }

    return { rows: rows.slice(0, height), inputRow }
  }

  function cursorPosition(inputRow: number): { row: number; col: number } {
    const prefix = measure(buffer.slice(0, cursor))
    const col = Math.max(1, Math.min(screen.width, 3 + prefix))
    return { row: Math.max(1, Math.min(screen.height, inputRow)), col }
  }

  // ------------------------------------------------------------------- input

  const insertAtCursor = (text: string) => {
    buffer = buffer.slice(0, cursor) + text + buffer.slice(cursor)
    cursor += text.length
    markDirty()
  }

  const handleKey = (key: Key): void => {
    if (key.type === 'text' || key.type === 'paste') {
      insertAtCursor(key.text.replace(/[\r\n\t]+/g, ' '))
      return
    }
    switch (key.type) {
      case 'enter':
        submit()
        return
      case 'backspace':
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor)
          cursor -= 1
        }
        break
      case 'delete':
        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1)
        break
      case 'tab':
        cycleFocus(key.shift ? -1 : 1)
        break
      case 'home':
        // ctrl+home = jump to the top of the pane (pi's tui.altScreen.top)
        if (key.ctrl) paneScrollToEdge('top')
        else cursor = 0
        break
      case 'end':
        // ctrl+end = jump back to the tail and follow new output (pi's bottom)
        if (key.ctrl) paneScrollToEdge('bottom')
        else cursor = buffer.length
        break
      case 'pageup':
        scrollPane(focus, Math.max(1, paneBodyHeight() - 2))
        break
      case 'pagedown':
        scrollPane(focus, -Math.max(1, paneBodyHeight() - 2))
        break
      case 'escape':
        if (running) abort?.abort()
        else {
          buffer = ''
          cursor = 0
        }
        break
      case 'alt':
        if (key.char === '1') focus = 'planner'
        else if (key.char === '2') focus = 'implementer'
        else if (key.char === '3') focus = 'verifier'
        break
      case 'ctrl':
        switch (key.char) {
          case 'c':
            if (running) {
              abort?.abort()
              setNotice('已请求取消…', 'warn')
            } else if (buffer.length > 0) {
              buffer = ''
              cursor = 0
            } else {
              requestQuit()
            }
            break
          case 'd':
            if (buffer.length === 0) requestQuit()
            break
          case 'a':
            cursor = 0
            break
          case 'e':
            cursor = buffer.length
            break
          case 'u':
            buffer = buffer.slice(cursor)
            cursor = 0
            break
          case 'k':
            buffer = buffer.slice(0, cursor)
            break
          case 'w': {
            const head = buffer.slice(0, cursor).replace(/\S+\s*$/, '')
            buffer = head + buffer.slice(cursor)
            cursor = head.length
            break
          }
          case 'l':
            for (const pane of Object.values(panes)) pane.scroll = 0
            break
          default:
            break
        }
        break
      case 'arrow':
        if (key.dir === 'up' || key.dir === 'down') {
          if (key.alt || key.shift) {
            scrollPane(focus, key.dir === 'up' ? 1 : -1)
          } else if (history.length > 0) {
            const next = key.dir === 'up' ? historyIndex + 1 : historyIndex - 1
            if (next >= 0 && next < history.length) {
              historyIndex = next
              buffer = history[history.length - 1 - next]
              cursor = buffer.length
            } else if (next < 0) {
              historyIndex = -1
              buffer = ''
              cursor = 0
            }
          }
        } else if (key.ctrl || key.alt) {
          cycleFocus(key.dir === 'left' ? -1 : 1)
        } else {
          cursor = Math.max(0, Math.min(buffer.length, cursor + (key.dir === 'left' ? -1 : 1)))
        }
        break
      default:
        break
    }
    markDirty()
  }

  // ------------------------------------------------------------------- wiring

  const onData = (chunk: string) => {
    const parsed = parseKeys(pending + chunk)
    pending = parsed.rest
    for (const key of parsed.keys) {
      handleKey(key)
      if (quit) break
    }
  }

  const onResize = () => {
    screen.refreshSize()
    screen.invalidate()
    for (const pane of Object.values(panes)) pane.cache = null
    markDirty()
  }

  let timer: NodeJS.Timeout | null = null

  const cleanup = () => {
    if (timer) clearInterval(timer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    out.off('resize', onResize)
    input.off('data', onData)
    if (input.isTTY) input.setRawMode?.(false)
    input.pause()
    out.write('\x1b[?2004l')
    screen.leave()
  }

  const onSignal = () => {
    if (running && abort) {
      abort.abort()
      return
    }
    requestQuit()
  }

  screen.enter()
  out.write('\x1b[?2004h')
  if (input.isTTY) input.setRawMode?.(true)
  input.setEncoding('utf8')
  input.resume()
  input.on('data', onData)
  out.on('resize', onResize)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  appendLine(
    'system',
    [
      `QZcode · 工作区 ${toolRuntime.workspace}`,
      config.roles.planner.mock
        ? 'mock 模式：不联网，用脚本化模型跑通 A→B→C。输入 /mock 切到真实模型。'
        : 'A 出提示词与验收标准 → B 带工具实现 → C 只读核验。输入目标回车开始。',
      options.plugins.length > 0
        ? `已加载插件 ${options.plugins.filter((p) => p.status === 'active').length} 个（/plugins 查看）`
        : '',
      ...(options.notices ?? []).map((note) => `· ${note}`),
    ]
      .filter(Boolean)
      .join('\n'),
    { fg: THEME.system },
  )

  timer = setInterval(() => {
    tick += 1
    if (!dirty && tick % 25 !== 0) return
    dirty = false
    const frame = renderFrame()
    screen.draw(frame.rows, cursorPosition(frame.inputRow))
  }, 40)
  // A leaked UI must never hold the process open; stdin keeps it alive in real use.
  timer.unref?.()

  if (options.autoStart && buffer.trim()) {
    const goal = buffer
    buffer = ''
    cursor = 0
    setTimeout(() => void startTask(goal), 150)
  }

  await new Promise<void>((resolve) => {
    resolveQuit = resolve
    if (quit) resolve()
  })

  cleanup()
}
