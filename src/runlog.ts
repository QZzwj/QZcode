/**
 * 每轮运行的记录文件：`<工作区>/.qzcode/runN.md`
 *
 * 内容就是"这一轮 L / A / B / C 各自干了什么"：决策、任务书、工具调用、
 * 文件改动、核验结论，外加耗时和 token。数据全部来自 run.events，
 * 不做任何额外埋点——跑完之后现场就有。
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 与 server 里的 UiEvent 对齐（这里只声明用得上的字段，避免循环依赖）。 */
export interface RunLogEvent {
  t: string
  pane?: string
  delta?: string
  stage?: string
  name?: string
  args?: string
  ok?: boolean
  ms?: number
  message?: string
  level?: string
  status?: string
  path?: string
  added?: number
  removed?: number
  decision?: { route?: string; why?: string; difficulty?: string; hint?: string }
  plan?: { acceptance?: string[] }
  review?: { ok?: boolean; drift?: string[] }
  verdict?: { pass?: boolean; notes?: string }
  result?: { ok?: boolean; rounds?: number; elapsedMs?: number; usage?: { total?: number; completion?: number } }
  phase?: string
  round?: number
  touched?: number
}

export interface RunLogInput {
  runId: string
  goal: string
  startedAt: number
  status: string
  events: RunLogEvent[]
  /** 各步骤的模型耗时与输出 token（可能没有）。 */
  steps?: Array<{ role: string; calls: number; ms: number; completion: number }>
  touched?: number
}

const ROLE_TITLES: Record<string, string> = {
  leader: 'L · 调度',
  planner: 'A · 任务书',
  implementer: 'B · 实现',
  verifier: 'C · 核验',
}

const ROLE_ORDER = ['leader', 'planner', 'implementer', 'verifier']

/** 这一轮该写第几号文件：数一下已有的 runN.md，取最大值 +1。 */
export function nextRunNumber(workspace: string): number {
  const dir = join(workspace, '.qzcode')
  if (!existsSync(dir)) return 1
  let max = 0
  for (const name of readdirSync(dir)) {
    const match = name.match(/^run(\d+)\.md$/i)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`
}

function stamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 把事件按角色归拢。 */
function collect(events: RunLogEvent[]) {
  const text: Record<string, string> = {}
  const tools: Record<string, Array<{ name: string; ok: boolean; ms?: number; args?: string }>> = {}
  const patches: Record<string, Array<{ path: string; added: number; removed: number }>> = {}
  let route: RunLogEvent['decision'] = undefined
  let plan: string[] = []
  let review: RunLogEvent['review'] = undefined
  let verdict: RunLogEvent['verdict'] = undefined
  let done: RunLogEvent['result'] = undefined
  const notes: string[] = []

  for (const event of events) {
    switch (event.t) {
      case 'route':
        route = event.decision
        break
      case 'plan':
        plan = event.plan?.acceptance ?? []
        break
      case 'review':
        review = event.review
        break
      case 'verdict':
        verdict = event.verdict
        break
      case 'done':
        done = event.result
        break
      case 'note':
        if (event.message) notes.push(event.message)
        break
      case 'text':
        if (event.pane) text[event.pane] = (text[event.pane] ?? '') + (event.delta ?? '')
        break
      case 'tool':
        if (event.pane && event.stage === 'end' && event.name) {
          tools[event.pane] ??= []
          tools[event.pane].push({ name: event.name, ok: event.ok !== false, ms: event.ms, args: event.args })
        }
        break
      case 'patch':
        if (event.pane && event.path) {
          patches[event.pane] ??= []
          patches[event.pane].push({ path: event.path, added: event.added ?? 0, removed: event.removed ?? 0 })
        }
        break
      default:
        break
    }
  }

  return { text, tools, patches, route, plan, review, verdict, done, notes }
}

/** 生成 markdown。纯函数，方便测。 */
export function renderRunLog(input: RunLogInput, index: number): string {
  const { text, tools, patches, route, plan, review, verdict, done, notes } = collect(input.events)
  const lines: string[] = []

  const statusText =
    input.status === 'passed'
      ? '通过'
      : input.status === 'cancelled'
        ? '已取消'
        : input.status === 'running'
          ? '进行中'
          : '未通过'
  const elapsed = done?.elapsedMs ?? Date.now() - input.startedAt
  const total = done?.usage?.total ?? 0
  const output = done?.usage?.completion ?? 0

  lines.push(`# run${index} · ${input.goal.replace(/\s+/g, ' ').slice(0, 80)}`)
  lines.push('')
  lines.push(`- 运行：${stamp(input.startedAt)}（${formatDuration(elapsed)}）`)
  lines.push(`- 结果：${statusText}${done?.rounds ? `（${done.rounds} 轮）` : ''}`)
  lines.push(`- 用量：${total} tok（其中输出 ${output} tok）`)
  if (input.touched !== undefined) lines.push(`- 改动文件：${input.touched} 个`)
  lines.push(`- runId：\`${input.runId}\``)
  lines.push('')

  // L
  lines.push(`## ${ROLE_TITLES.leader}`)
  if (route) {
    lines.push(`- 决策：${route.route === 'direct' ? '直接回答（不动流水线）' : '走流水线'}`)
    if (route.why) lines.push(`- 理由：${route.why}`)
    if (route.difficulty) lines.push(`- 难度：${route.difficulty}`)
    if (route.hint) lines.push(`- 派活提示：${route.hint}`)
  } else {
    lines.push('- 这一轮没调 L（关键词预筛直接进流水线）')
  }
  lines.push('')

  // A
  lines.push(`## ${ROLE_TITLES.planner}`)
  if (plan.length > 0) {
    lines.push(`验收标准（${plan.length} 条）：`)
    for (const item of plan) lines.push(`- ${item}`)
    lines.push('')
  }
  if (text.planner) lines.push(text.planner.trim(), '')
  if (review) {
    lines.push(`复核：${review.ok ? '对齐' : '退回修正'}`)
    for (const item of (review.drift ?? []).slice(0, 5)) lines.push(`- 偏差：${item}`)
    lines.push('')
  }
  if (!text.planner && plan.length === 0 && !review) lines.push('（这一轮 A 没有产出）', '')

  // 通用：B / C 的小节
  for (const role of ['implementer', 'verifier'] as const) {
    lines.push(`## ${ROLE_TITLES[role]}`)

    const rolePatches = patches[role] ?? []
    if (rolePatches.length > 0) {
      lines.push('文件改动：')
      for (const patch of rolePatches) lines.push(`- \`${patch.path}\` +${patch.added} −${patch.removed}`)
      lines.push('')
    }

    const roleTools = tools[role] ?? []
    if (roleTools.length > 0) {
      lines.push(`工具调用（${roleTools.length} 次）：`)
      for (const tool of roleTools) {
        const state = tool.ok ? 'OK' : 'ERR'
        const ms = tool.ms !== undefined ? ` ${formatDuration(tool.ms)}` : ''
        const args = tool.args ? ` · ${String(tool.args).replace(/\s+/g, ' ').slice(0, 70)}` : ''
        lines.push(`- ${tool.name} ${state}${ms}${args}`)
      }
      lines.push('')
    }

    if (role === 'verifier' && verdict) {
      lines.push(`结论：${verdict.pass ? '通过' : '未通过'}`)
      if (verdict.notes) lines.push(verdict.notes.trim())
      lines.push('')
    }

    if (text[role]) lines.push(text[role].trim(), '')
    if (rolePatches.length === 0 && roleTools.length === 0 && !text[role]) {
      lines.push('（这一轮没有动作）', '')
    }
  }

  // 各步骤速度（有就写，让这一轮的记录能对账）
  const steps = (input.steps ?? []).filter((step) => step.calls > 0)
  if (steps.length > 0) {
    lines.push('## 各步骤用量')
    for (const role of ROLE_ORDER) {
      const step = steps.find((item) => item.role === role)
      if (!step) continue
      const seconds = step.ms / 1000
      const speed = seconds > 0 ? (step.completion / seconds).toFixed(1) : '—'
      lines.push(
        `- ${ROLE_TITLES[role]}：${step.calls} 次调用 · ${formatDuration(step.ms)} · 输出 ${step.completion} tok · ${speed} tok/s`,
      )
    }
    lines.push('')
  }

  if (notes.length > 0) {
    lines.push('## 备注')
    for (const note of notes.slice(0, 20)) lines.push(`- ${note}`)
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

export interface RunLogResult {
  ok: boolean
  path?: string
  index?: number
  error?: string
}

/** 写到 `<工作区>/.qzcode/runN.md`。失败不抛错——记录写不成不能把运行搞崩。 */
export function writeRunLog(workspace: string, input: RunLogInput): RunLogResult {
  try {
    const dir = join(workspace, '.qzcode')
    mkdirSync(dir, { recursive: true })
    const index = nextRunNumber(workspace)
    const file = join(dir, `run${index}.md`)
    writeFileSync(file, renderRunLog(input, index), 'utf8')
    return { ok: true, path: file, index }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}
