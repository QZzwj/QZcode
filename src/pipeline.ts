import type { AgentHooks, ToolCallRecord } from './agent.ts'
import type { AppConfig, RoleName } from './config.ts'
import type { ChatMessage, Usage } from './llm.ts'
import { addUsage, createClient } from './llm.ts'
import { runCost } from './cost.ts'
import type { Plan, Review, RouteDecision, Verdict } from './roles.ts'
import {
  correctionBrief,
  implementStep,
  issuesToPrompt,
  leaderStep,
  planStep,
  reviewStep,
  verifyStep,
} from './roles.ts'
import type { ToolRuntime, Toolbox } from './tools.ts'

export type PaneId = 'planner' | 'implementer' | 'verifier' | 'system'
export type Phase = 'route' | 'plan' | 'implement' | 'review' | 'verify' | 'done' | 'idle'

export interface ToolEvent {
  pane: PaneId
  stage: 'start' | 'end'
  name: string
  args?: string
  ok?: boolean
  output?: string
  ms?: number
}

export interface Reporter {
  phase(phase: Phase, round: number): void
  text(pane: PaneId, delta: string): void
  textEnd(pane: PaneId): void
  tool(event: ToolEvent): void
  note(message: string, level?: 'info' | 'warn' | 'error'): void
  verdict(round: number, verdict: Verdict): void
  usage(pane: PaneId, usage: Usage): void
  done(result: RunResult): void
  /** Structured plan as soon as A produced it (GUI renders it as a card). */
  plan?(round: number, plan: Plan): void
  /** A 对 B 产出的复核结论（跑偏 / 对齐）。 */
  review?(round: number, review: Review, attempt: number): void
}

export interface ReviewAttempt {
  round: number
  attempt: number
  review: Review
}

export interface RunResult {
  /** 计划模式：只出了任务书，还没动手。 */
  planned?: boolean
  ok: boolean
  rounds: number
  plan: Plan | null
  verdict: Verdict | null
  usage: Usage
  elapsedMs: number
  history: { round: number; verdict: Verdict }[]
  implementerReport: string
  /** A 的每一次复核（含被判跑偏退回的）。 */
  reviews?: ReviewAttempt[]
  /** L 的分流结论。 */
  route?: RouteDecision
  /** route=direct 时，直接交付给用户的回答（不走 B/C）。 */
  answer?: string
  /** 这次运行花了多少钱（按角色/模型算）。 */
  cost?: ReturnType<typeof runCost>
}

export interface PipelineOptions {
  config: AppConfig
  goal: string
  toolbox: Toolbox
  toolRuntime: ToolRuntime
  reporter: Reporter
  signal?: AbortSignal
  /** Lets a host or a plugin swap a role's client (e.g. a router role variant). */
  clients?: Partial<
    Record<'leader' | 'planner' | 'implementer' | 'verifier', ReturnType<typeof createClient>>
  >
  /** Kernel event sink: extensions observe the run through these events. */
  emit?: (event: string, payload?: unknown) => void
  /**
   * 计划模式：只跑到 A 出任务书就停，把任务书交给用户确认。
   * 用户点头后再用 presetPlan 起一轮真正的执行。
   */
  planOnly?: boolean
  /** 已经确认过的任务书：跳过 L 和 A，直接进 B（顺带省掉这两步的 token）。 */
  presetPlan?: Plan
  /** 上一轮留下的上下文（目标/结论/改动清单），避免每轮从零开始。 */
  previousContext?: string
  /** 用户用 @文件 指定的参考文件内容（已拼好的 markdown 片段）。 */
  reference?: string
}

function hooksFor(reporter: Reporter, pane: PaneId): AgentHooks {
  return {
    onText(delta) {
      reporter.text(pane, delta)
    },
    onTextEnd() {
      reporter.textEnd(pane)
    },
    onToolStart(call) {
      reporter.tool({ pane, stage: 'start', name: call.name, args: call.args })
    },
    onToolEnd(record: ToolCallRecord) {
      reporter.tool({
        pane,
        stage: 'end',
        name: record.name,
        ok: record.ok,
        output: record.output,
        ms: record.ms,
      })
    },
    onUsage(usage) {
      reporter.usage(pane, usage)
    },
    onNote(message, level) {
      reporter.note(message, level ?? 'info')
    },
  }
}

/**
 * A 出提示词与验收标准 → B 实现 → C 核验 → 不通过则带着 C 的意见回到 A。
 * The only loop the product needs, and the only place that owns policy.
 */
export async function runPipeline(options: PipelineOptions): Promise<RunResult> {
  const { config, goal, reporter, toolbox, toolRuntime, signal } = options
  const clients = {
    leader: options.clients?.leader ?? createClient(config.roles.leader),
    planner: options.clients?.planner ?? createClient(config.roles.planner),
    implementer: options.clients?.implementer ?? createClient(config.roles.implementer),
    verifier: options.clients?.verifier ?? createClient(config.roles.verifier),
  }
  const startedAt = Date.now()
  const modelByRole: Record<string, string> = {
    leader: config.roles.leader.model,
    planner: config.roles.planner.model,
    implementer: config.roles.implementer.model,
    verifier: config.roles.verifier.model,
  }
  /** 累加总 usage，同时按角色记账（成本面板要用）。 */
  const trackUsage = (role: string, delta: Usage): void => {
    usage = addUsage(usage, delta)
    usageByRole[role] = addUsage(
      usageByRole[role] ?? { prompt: 0, completion: 0, total: 0 },
      delta,
    )
  }
  const emit = options.emit ?? (() => {})
  let usage: Usage = { prompt: 0, completion: 0, total: 0 }
  const usageByRole: Record<string, Usage> = {}
  let plan: Plan | null = null
  let verdict: Verdict | null = null
  let implementerReport = ''
  const implementerMessages: ChatMessage[] = []
  const history: { round: number; verdict: Verdict }[] = []
  const reviews: ReviewAttempt[] = []

  emit('session_start', { goal })

  const inRole = async <T>(role: RoleName, round: number, run: () => Promise<T>): Promise<T> => {
    emit('agent_start', { role, round })
    try {
      return await run()
    } finally {
      emit('agent_end', { role, round })
    }
  }

  const finish = (result: RunResult): RunResult => {
    reporter.done(result)
    emit('session_end', { ok: result.ok, rounds: result.rounds })
    return result
  }

  // 已经取消了就别再花 token 问 L
  if (signal?.aborted) {
    reporter.phase('done', 0)
    return finish({
    cost: runCost(config.cost, usageByRole, modelByRole),
      ok: false,
      rounds: 0,
      plan: null,
      verdict: null,
      usage,
      elapsedMs: Date.now() - startedAt,
      history: [],
      implementerReport: '',
    })
  }

  // ---------------------------------------------------------------- L 分流
  let route: RouteDecision | undefined
  if (config.leader.enabled && options.presetPlan) {
    // 任务书是用户确认过的：怎么走已经定了，不用再问 L（省一次调用）
    reporter.note('沿用你确认过的任务书，跳过 L 的分流。', 'info')
  } else if (config.leader.enabled) {
    reporter.phase('route', 1)
    const routed = await leaderStep(
      { client: clients.leader, toolbox, toolRuntime, config, signal },
      { goal, round: 1 },
      hooksFor(reporter, 'system'),
    )
    trackUsage('leader', routed.usage)
    route = routed.decision
    const label = route.prefiltered
      ? 'L 预筛'
      : route.route === 'direct'
        ? 'L 判定：直接回答'
        : 'L 判定：走流水线'
    reporter.note(`${label} — ${route.why || '(无说明)'}`, route.route === 'direct' ? 'info' : 'info')

    if (route.route === 'direct' && route.answer) {
      reporter.phase('done', 0)
      return finish({
        cost: runCost(config.cost, usageByRole, modelByRole),
        ok: true,
        rounds: 0,
        plan: null,
        verdict: null,
        usage,
        elapsedMs: Date.now() - startedAt,
        history: [],
        implementerReport: '',
        // 直接把 L 的答案作为交付物
        answer: route.answer,
        route,
      })
    }
  }

  for (let round = 1; round <= config.maxRounds; round++) {
    if (signal?.aborted) break

    let currentPlan: Plan
    if (options.presetPlan && round === 1) {
      // 用户已经确认过任务书：直接用它，不再花 A 的 token
      currentPlan = options.presetPlan
      reporter.phase('plan', round)
      reporter.note('沿用你确认过的任务书，跳过 A。', 'info')
      reporter.plan?.(round, currentPlan)
    } else {
      reporter.phase('plan', round)
      const planned = await inRole('planner', round, () =>
        planStep(
          { client: clients.planner, toolbox, toolRuntime, config, signal },
          {
            goal,
            round,
            workspace: toolRuntime.workspace,
            previousIssues: verdict?.issues,
            previousSummary: verdict?.summary,
            previousContext: options.previousContext,
            reference: options.reference,
          },
          hooksFor(reporter, 'planner'),
        ),
      )
      trackUsage('planner', planned.usage)
      currentPlan = planned.plan
      reporter.plan?.(round, currentPlan)
      if (!planned.plan.parsed) {
        reporter.note('A 没有按要求输出 JSON，已降级用全文作为任务书（验收标准可能缺失）。', 'warn')
      }
      if (planned.plan.acceptance.length === 0) {
        reporter.note('A 没给验收标准，C 会把这记为 major。', 'warn')
      }
    }
    plan = currentPlan

    // 计划模式：任务书出来了就停，等用户确认
    if (options.planOnly === true) {
      reporter.phase('done', round)
      return finish({
        cost: runCost(config.cost, usageByRole, modelByRole),
        ok: true,
        planned: true,
        rounds: round,
        plan,
        verdict: null,
        usage,
        elapsedMs: Date.now() - startedAt,
        history: [],
        implementerReport: '',
      })
    }

    if (signal?.aborted) break
    reporter.phase('implement', round)
    let implemented = await inRole('implementer', round, () =>
      implementStep(
        { client: clients.implementer, toolbox, toolRuntime, config, signal },
        { plan: currentPlan, goal, round, messages: implementerMessages },
        hooksFor(reporter, 'implementer'),
      ),
    )
    trackUsage('implementer', implemented.usage)
    implementerReport = implemented.finalText

    // A 复核：B 跑偏就退回修正，没问题才进 C
    if (config.review.enabled && config.review.maxCorrections > 0 && !signal?.aborted) {
      for (let attempt = 1; attempt <= config.review.maxCorrections; attempt++) {
        if (signal?.aborted) break
        reporter.phase('review', round)
        const reviewed = await inRole('planner', round, () =>
          reviewStep(
            { client: clients.planner, toolbox, toolRuntime, config, signal },
            {
              goal,
              plan: currentPlan,
              round,
              attempt,
              implementerReport,
              implementerMessages: implemented.messages,
            },
            hooksFor(reporter, 'planner'),
          ),
        )
        trackUsage('planner', reviewed.usage)
        reviews.push({ round, attempt, review: reviewed.review })
        reporter.review?.(round, reviewed.review, attempt)

        if (reviewed.review.ok) {
          reporter.note(`A 复核：与任务书对齐（第 ${round} 轮第 ${attempt} 次）`)
          break
        }
        if (!reviewed.review.brief.trim() && reviewed.review.drift.length === 0) {
          reporter.note('A 判为跑偏但没给修正词，跳过退回以免空转。', 'warn')
          break
        }

        reporter.note(
          `A 复核：跑偏 ${reviewed.review.drift.length} 处，退回 B 修正 —— ${reviewed.review.summary}`,
          'warn',
        )
        if (attempt === config.review.maxCorrections) {
          reporter.note('修正预算用完，带着现状进核验。', 'warn')
          break
        }

        reporter.phase('implement', round)
        const corrected = await inRole('implementer', round, () =>
          implementStep(
            { client: clients.implementer, toolbox, toolRuntime, config, signal },
            {
              plan: currentPlan,
              goal,
              round: attempt + 1,
              messages: [
                ...implemented.messages,
                { role: 'user' as const, content: correctionBrief(reviewed.review, currentPlan, round, attempt) },
              ],
            },
            hooksFor(reporter, 'implementer'),
          ),
        )
        trackUsage('implementer', corrected.usage)
        implemented = corrected
        implementerReport = corrected.finalText
      }
    }

    if (signal?.aborted) break
    reporter.phase('verify', round)
    const verified = await inRole('verifier', round, () =>
      verifyStep(
        { client: clients.verifier, toolbox, toolRuntime, config, signal },
        {
          plan: currentPlan,
          goal,
          round,
          implementerReport,
          implementerMessages: implemented.messages,
        },
        hooksFor(reporter, 'verifier'),
      ),
    )
    trackUsage('verifier', verified.usage)
    verdict = verified.verdict
    history.push({ round, verdict })
    reporter.verdict(round, verdict)

    if (verdict.pass) {
      reporter.phase('done', round)
      return finish({
        cost: runCost(config.cost, usageByRole, modelByRole),
        ok: true,
        rounds: round,
        plan,
        verdict,
        usage,
        elapsedMs: Date.now() - startedAt,
        history,
        implementerReport,
        reviews,
        route,
      })
    }

    if (round < config.maxRounds) {
      reporter.note(
        `第 ${round} 轮未通过：${issuesToPrompt(verdict.issues).slice(0, 400) || verdict.summary}`,
        'warn',
      )
    }
  }

  reporter.phase('done', history.length)
  return finish({
    cost: runCost(config.cost, usageByRole, modelByRole),
    ok: false,
    rounds: history.length,
    plan,
    verdict,
    usage,
    elapsedMs: Date.now() - startedAt,
    history,
    implementerReport,
    reviews,
    route,
  })
}

/** Plain-text reporter used by `qzcode run` and by the tests. */
export function createPlainReporter(write: (line: string) => void): Reporter {
  let phase: Phase = 'idle'
  let round = 0
  const labels: Record<PaneId, string> = {
    planner: 'A',
    implementer: 'B',
    verifier: 'C',
    system: '·',
  }
  let buffer = ''
  const flush = () => {
    if (buffer.trim()) write(buffer.trimEnd())
    buffer = ''
  }
  return {
    phase(next, nextRound) {
      if (phase === next && round === nextRound) return
      flush()
      phase = next
      round = nextRound
      if (next !== 'idle') write(`\n── [${next}] round ${nextRound} ──`)
    },
    text(_pane, delta) {
      buffer += delta
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) write(line)
    },
    textEnd(pane) {
      void pane
      flush()
    },
    tool(event) {
      flush()
      const label = labels[event.pane]
      if (event.stage === 'start') write(`  ${label} → ${event.name} ${shortenArgs(event.args)}`)
      else write(`  ${label} ← ${event.name} ${event.ok ? 'ok' : 'FAIL'} ${event.ms ?? 0}ms`)
    },
    note(message, level = 'info') {
      flush()
      write(`  [${level}] ${message}`)
    },
    verdict(nextRound, next) {
      flush()
      const issues = next.issues
        .map((issue) => `     - [${issue.severity}] ${issue.where}: ${issue.problem}`)
        .join('\n')
      write(`  verdict round ${nextRound}: ${next.pass ? 'PASS' : 'FAIL'} — ${next.summary}${issues ? `\n${issues}` : ''}`)
    },
    usage(pane, next) {
      void pane
      void next
    },
    done(result) {
      flush()
      const seconds = (result.elapsedMs / 1000).toFixed(1)
      write(
        `\n${result.ok ? '✔ 通过' : '✘ 未通过'} 轮次 ${result.rounds} 用时 ${seconds}s tokens ${result.usage.total}`,
      )
    },
  }
}

function shortenArgs(args?: string): string {
  if (!args) return ''
  const compact = args.replace(/\s+/g, ' ')
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact
}
