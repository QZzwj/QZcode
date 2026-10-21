import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RoleName } from './config.ts'
import type { StepStat } from './steps.ts'
import { mergeStepStats, type StepSummary } from './steps.ts'

/**
 * 成本：把 token 换算成钱。
 *
 * 价格来源优先级：配置里的 models[模型] → 全局 perMTokens → 内置默认。
 * 账本写在 <configDir>/.qzcode/cost.json，按天累计，用来做预算告警。
 */

export interface Price {
  /** 每百万输入 token 的价格。 */
  input: number
  /** 每百万输出 token 的价格。 */
  output: number
}

export interface CostConfig {
  currency: string
  perMTokens: Price
  /** 按模型覆盖价格（模型名 → 单价）。 */
  models: Record<string, Price>
  /** 每日预算（同一货币），0 = 不限。 */
  dailyBudget: number
}

/** 少于这个耗时的运行不参与 tok/s 统计（否则瞬间完成的任务会算出天文数字）。 */
export const MIN_SPEED_SAMPLE_MS = 1000

export const DEFAULT_COST: CostConfig = {
  currency: 'CNY',
  perMTokens: { input: 2, output: 8 },
  models: {},
  dailyBudget: 0,
}

export interface UsageLike {
  prompt: number
  completion: number
  total: number
}

export interface CostBreakdown {
  currency: string
  total: number
  byRole: Record<string, number>
  byModel: Record<string, number>
  prompt: number
  completion: number
}

export function priceFor(model: string, config: CostConfig): Price {
  return config.models[model] ?? config.perMTokens ?? DEFAULT_COST.perMTokens
}

/** 按 token 用量算钱（保留 4 位小数，避免浮点噪音）。 */
export function estimateCost(usage: UsageLike, model: string, config: CostConfig): number {
  const price = priceFor(model, config)
  const input = (usage.prompt / 1_000_000) * price.input
  const output = (usage.completion / 1_000_000) * price.output
  return Math.round((input + output) * 10_000) / 10_000
}

export interface LedgerEntry {
  runId: string
  date: string
  at: number
  goal: string
  total: number
  byRole: Record<string, number>
  tokens: number
  /** prompt（输入）token 数：不会被"生成"，算速度时要排除。 */
  prompt?: number
  /** completion（输出）token 数：这才是模型真正生成的量。 */
  completion?: number
  /** 这次运行花了多少毫秒（用来算输出速度）。 */
  ms?: number
  /** 各步骤（L/A/B/C）的模型耗时与输出 token。 */
  steps?: StepStat[]
  /** 各步骤里最快的那一次（输出 token/秒）。 */
  bestSteps?: Array<{ role: RoleName; tokPerSec: number }>
}

export interface Ledger {
  currency: string
  entries: LedgerEntry[]
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export class CostLedger {
  readonly path: string
  /** 工作区根目录（账本放在它的 .qzcode/ 下）。 */
  readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.path = join(baseDir, '.qzcode', 'cost.json')
  }

  read(): Ledger {
    try {
      if (!existsSync(this.path)) return { currency: DEFAULT_COST.currency, entries: [] }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Ledger
      if (!Array.isArray(parsed.entries)) return { currency: DEFAULT_COST.currency, entries: [] }
      return { currency: parsed.currency ?? DEFAULT_COST.currency, entries: parsed.entries }
    } catch {
      return { currency: DEFAULT_COST.currency, entries: [] }
    }
  }

  record(entry: Omit<LedgerEntry, 'date' | 'at' | 'ms'> & { at?: number; ms?: number }): Ledger {
    const ledger = this.read()
    ledger.entries.push({ ...entry, date: today(), at: entry.at ?? Date.now() })
    // 只留最近 500 条，别让账本无限长
    if (ledger.entries.length > 500) ledger.entries = ledger.entries.slice(-500)
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(ledger, null, 2), 'utf8')
    } catch {
      // 记不下账不影响运行
    }
    return ledger
  }

  summary(config: CostConfig, budget = config.dailyBudget): {
    currency: string
    today: number
    total: number
    runs: number
    budget: number
    remaining: number | null
    overBudget: boolean
    byRole: Record<string, number>
    recent: LedgerEntry[]
    /** 所有记账运行的平均吞吐（token/秒）。 */
    avgTokPerSec: number
    /** 单次运行里最高的输出速度（样本 ≥2 才有意义，否则为 0）。 */
    maxTokPerSec: number
    /** 参与统计的运行数（老账本没有 completion，样本会是 0）。 */
    speedSamples: number
    /** 按步骤（L/A/B/C）拆开的速度与耗时。 */
    steps: StepSummary[]
    /** 平均每次运行耗时（毫秒）。 */
    avgRunMs: number
  } {
    const ledger = this.read()
    const day = today()
    const todayEntries = ledger.entries.filter((entry) => entry.date === day)
    const byRole: Record<string, number> = {}
    for (const entry of ledger.entries) {
      for (const [role, amount] of Object.entries(entry.byRole)) {
        byRole[role] = Math.round(((byRole[role] ?? 0) + amount) * 10_000) / 10_000
      }
    }
    const todayTotal = Math.round(todayEntries.reduce((sum, entry) => sum + entry.total, 0) * 10_000) / 10_000
    const total = Math.round(ledger.entries.reduce((sum, entry) => sum + entry.total, 0) * 10_000) / 10_000
    // 输出速度：只算 completion（模型真正生成的 token），
    // 绝不能把 prompt 算进来——上下文几万 token 的输入根本没被"生成"。
    // 旧条目没有 completion 字段，直接排除，不拿老数据糊弄人。
    const timed = ledger.entries.filter(
      (entry) =>
        typeof entry.ms === 'number' &&
        entry.ms >= MIN_SPEED_SAMPLE_MS &&
        typeof entry.completion === 'number' &&
        entry.completion > 0,
    )
    const totalMs = timed.reduce((sum, entry) => sum + (entry.ms ?? 0), 0)
    const totalCompletion = timed.reduce((sum, entry) => sum + (entry.completion ?? 0), 0)
    const rates = timed.map((entry) => (entry.completion ?? 0) / ((entry.ms ?? 1) / 1000)).filter((rate) => Number.isFinite(rate))
    const avgTokPerSec = totalMs > 0 ? Math.round((totalCompletion / (totalMs / 1000)) * 10) / 10 : 0
    const maxTokPerSec = rates.length > 1 ? Math.round(Math.max(...rates) * 10) / 10 : 0
    const speedSamples = timed.length
    // 平均耗时另算：只要记了耗时就算，老条目也一样（耗时不依赖 completion）
    const withMs = ledger.entries.filter((entry) => typeof entry.ms === 'number' && entry.ms >= MIN_SPEED_SAMPLE_MS)
    const totalRunMs = withMs.reduce((sum, entry) => sum + (entry.ms ?? 0), 0)
    const avgRunMs = withMs.length > 0 ? Math.round(totalRunMs / withMs.length) : 0

    return {
      currency: config.currency,
      today: todayTotal,
      total,
      runs: ledger.entries.length,
      budget,
      remaining: budget > 0 ? Math.round((budget - todayTotal) * 10_000) / 10_000 : null,
      overBudget: budget > 0 && todayTotal >= budget,
      byRole,
      recent: ledger.entries.slice(-10).reverse(),
      avgTokPerSec,
      maxTokPerSec,
      speedSamples,
      steps: mergeStepStats(ledger.entries),
      avgRunMs,
    }
  }
}

/** 汇总一次运行的花费（按角色，用每个角色的模型单价）。 */
export function runCost(
  config: CostConfig,
  usageByRole: Record<string, UsageLike>,
  modelByRole: Record<string, string>,
): CostBreakdown {
  const byRole: Record<string, number> = {}
  const byModel: Record<string, number> = {}
  let prompt = 0
  let completion = 0
  let total = 0
  for (const [role, usage] of Object.entries(usageByRole)) {
    const model = modelByRole[role] ?? ''
    const amount = estimateCost(usage, model, config)
    byRole[role] = amount
    byModel[model || role] = Math.round(((byModel[model || role] ?? 0) + amount) * 10_000) / 10_000
    total += amount
    prompt += usage.prompt
    completion += usage.completion
  }
  return {
    currency: config.currency,
    total: Math.round(total * 10_000) / 10_000,
    byRole,
    byModel,
    prompt,
    completion,
  }
}

export function formatMoney(amount: number, currency: string): string {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
  const digits = amount >= 1 ? 2 : 4
  return `${symbol}${amount.toFixed(digits)}${symbol ? '' : ' ' + currency}`
}

export type { RoleName }
