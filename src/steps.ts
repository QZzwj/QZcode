/** 每个步骤花了多少时间、输出了多少 token、速度多少。 */

import type { LlmClient, ChatRequest, ChatResult } from './llm.ts'
import type { RoleName } from './config.ts'

export interface StepStat {
  /** 步骤名：leader / planner / implementer / verifier */
  role: RoleName
  /** 这一步里调了几次模型 */
  calls: number
  /** 这一步总共花了多少毫秒（模型时间，不含工具） */
  ms: number
  /** 输入 token */
  prompt: number
  /** 输出 token */
  completion: number
}

/** 单个步骤的速度：只算输出 token。 */
export function stepSpeeds(stat: StepStat): { tokPerSec: number; msPerCall: number } {
  const seconds = stat.ms / 1000
  return {
    tokPerSec: seconds > 0 ? Math.round((stat.completion / seconds) * 10) / 10 : 0,
    msPerCall: stat.calls > 0 ? Math.round(stat.ms / stat.calls) : 0,
  }
}

/**
 * 给每个角色的 LLM 客户端套一层计时。
 * 只看"模型时间"，工具跑多久不算——那是 B 在用 bash/browser 干活，不是模型在生成。
 */
export function createStepMeter() {
  const stats = new Map<RoleName, StepStat>()
  /** 单次调用里最快的一次（用于"最高速度"） */
  const best = new Map<RoleName, { tokPerSec: number; ms: number; completion: number }>()

  const record = (role: RoleName, ms: number, prompt: number, completion: number): void => {
    const current = stats.get(role) ?? { role, calls: 0, ms: 0, prompt: 0, completion: 0 }
    current.calls += 1
    current.ms += ms
    current.prompt += prompt
    current.completion += completion
    stats.set(role, current)

    const seconds = ms / 1000
    const rate = seconds > 0 ? completion / seconds : 0
    const previous = best.get(role)
    if (!previous || rate > previous.tokPerSec) best.set(role, { tokPerSec: rate, ms, completion })
  }

  const wrap = (client: LlmClient, role: RoleName): LlmClient => ({
    role,
    model: client.model,
    mock: client.mock,
    async chat(request: ChatRequest): Promise<ChatResult> {
      const startedAt = Date.now()
      try {
        const result = await client.chat(request)
        const usage = result.usage
        record(role, Date.now() - startedAt, usage?.prompt ?? 0, usage?.completion ?? 0)
        return result
      } catch (error) {
        // 失败的调用也占了时间，记下来（completion 记 0）
        record(role, Date.now() - startedAt, 0, 0)
        throw error
      }
    },
  })

  return {
    wrap,
    /** 这一步里最快的一次（输出 token / 秒） */
    bestOf(role: RoleName): number {
      const entry = best.get(role)
      return entry ? Math.round(entry.tokPerSec * 10) / 10 : 0
    },
    snapshot(): StepStat[] {
      return [...stats.values()].map((item) => ({ ...item }))
    },
  }
}

export type StepMeter = ReturnType<typeof createStepMeter>

/** 把多次运行的步骤统计合并成一份（成本页用）。 */
export interface StepSummary extends StepStat {
  /** 这一步的平均输出速度 */
  tokPerSec: number
  /** 这一步里最快的一次 */
  maxTokPerSec: number
  /** 平均每次调用耗时 */
  msPerCall: number
}

export function mergeStepStats(
  entries: Array<{ steps?: StepStat[]; bestSteps?: Array<{ role: RoleName; tokPerSec: number }> }>,
): StepSummary[] {
  const merged = new Map<RoleName, StepSummary>()
  for (const entry of entries) {
    for (const stat of entry.steps ?? []) {
      const current =
        merged.get(stat.role) ??
        ({
          role: stat.role,
          calls: 0,
          ms: 0,
          prompt: 0,
          completion: 0,
          tokPerSec: 0,
          maxTokPerSec: 0,
          msPerCall: 0,
        } satisfies StepSummary)
      current.calls += stat.calls
      current.ms += stat.ms
      current.prompt += stat.prompt
      current.completion += stat.completion
      merged.set(stat.role, current)
    }
    for (const item of entry.bestSteps ?? []) {
      const current = merged.get(item.role)
      if (current && item.tokPerSec > current.maxTokPerSec) current.maxTokPerSec = item.tokPerSec
    }
  }
  const result = [...merged.values()]
  for (const item of result) {
    const speeds = stepSpeeds(item)
    item.tokPerSec = speeds.tokPerSec
    item.msPerCall = speeds.msPerCall
    if (item.maxTokPerSec === 0) item.maxTokPerSec = speeds.tokPerSec
  }
  return result.sort((a, b) => order(a.role) - order(b.role))
}

const ORDER: RoleName[] = ['leader', 'planner', 'implementer', 'verifier']
function order(role: RoleName): number {
  const index = ORDER.indexOf(role)
  return index < 0 ? ORDER.length : index
}
