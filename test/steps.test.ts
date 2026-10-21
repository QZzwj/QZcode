import assert from 'node:assert/strict'
import test from 'node:test'
import { createStepMeter, mergeStepStats, stepSpeeds } from '../src/steps.ts'
import type { ChatResult, LlmClient } from '../src/llm.ts'

function fakeClient(role: 'leader' | 'planner', delayMs: number, completion: number, prompt = 1000): LlmClient {
  return {
    role,
    model: `${role}-test`,
    mock: false,
    async chat(): Promise<ChatResult> {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return {
        content: 'ok',
        reasoning: '',
        toolCalls: [],
        usage: { prompt, completion, total: prompt + completion },
        finishReason: 'stop',
        model: `${role}-test`,
      }
    },
  }
}

test('步骤统计：速度按"这一步的输出 token ÷ 这一步耗时"算', async () => {
  const meter = createStepMeter()
  // 300ms 输出 100 token → 约 333 tok/s
  const fast = meter.wrap(fakeClient('planner', 300, 100), 'planner')
  await fast.chat({ messages: [], maxTokens: 10 })
  // 再一次，300ms 输出 100 token
  await fast.chat({ messages: [], maxTokens: 10 })

  const [stat] = meter.snapshot()
  assert.equal(stat.role, 'planner')
  assert.equal(stat.calls, 2)
  assert.equal(stat.completion, 200)
  assert.ok(stat.ms >= 500, `两次调用约 600ms，实际 ${stat.ms}ms`)
  // 平均速度 = 200 token / 约 0.6s ≈ 333（只算输出，输入 2000 token 不参与）
  const speeds = stepSpeeds(stat)
  assert.ok(speeds.tokPerSec > 200 && speeds.tokPerSec < 500, `平均速度应在这个量级，实际 ${speeds.tokPerSec}`)
  // 最快那次是单次调用：100 token / 300ms ≈ 333
  assert.ok(meter.bestOf('planner') > 250 && meter.bestOf('planner') < 450, `最快应在 333 左右，实际 ${meter.bestOf('planner')}`)
})

test('步骤统计：不同角色分开记，互不混淆', async () => {
  const meter = createStepMeter()
  await meter.wrap(fakeClient('leader', 50, 20), 'leader').chat({ messages: [], maxTokens: 5 })
  await meter.wrap(fakeClient('planner', 50, 200), 'planner').chat({ messages: [], maxTokens: 5 })
  const stats = meter.snapshot()
  assert.equal(stats.length, 2)
  const leader = stats.find((item) => item.role === 'leader')
  const planner = stats.find((item) => item.role === 'planner')
  assert.equal(leader?.completion, 20)
  assert.equal(planner?.completion, 200)
})

test('步骤统计：失败调用也计时，但不虚报输出', async () => {
  const meter = createStepMeter()
  const boom: LlmClient = {
    role: 'verifier',
    model: 'x',
    mock: false,
    async chat() {
      await new Promise((resolve) => setTimeout(resolve, 60))
      throw new Error('网络炸了')
    },
  }
  await assert.rejects(async () => {
    await meter.wrap(boom, 'verifier').chat({ messages: [], maxTokens: 5 })
  })
  const [stat] = meter.snapshot()
  assert.equal(stat.calls, 1)
  assert.equal(stat.completion, 0, '失败不该记输出 token')
  assert.ok(stat.ms >= 50, '耗时要记下来')
})

test('合并多次运行：最快取历史最大值，平均按总量算', () => {
  const merged = mergeStepStats([
    {
      steps: [{ role: 'implementer', calls: 1, ms: 2000, prompt: 5000, completion: 1000 }],
      bestSteps: [{ role: 'implementer', tokPerSec: 500 }],
    },
    {
      steps: [{ role: 'implementer', calls: 1, ms: 2000, prompt: 5000, completion: 400 }],
      bestSteps: [{ role: 'implementer', tokPerSec: 120 }],
    },
  ])
  assert.equal(merged.length, 1)
  const [step] = merged
  assert.equal(step.completion, 1400)
  assert.equal(step.ms, 4000)
  assert.equal(step.tokPerSec, 350, '1400 token / 4s = 350')
  assert.equal(step.maxTokPerSec, 500, '最快取历史最高')
  assert.equal(step.msPerCall, 2000)
})

test('合并：顺序按 L→A→B→C 排', () => {
  const merged = mergeStepStats([
    {
      steps: [
        { role: 'verifier', calls: 1, ms: 1000, prompt: 1, completion: 10 },
        { role: 'leader', calls: 1, ms: 1000, prompt: 1, completion: 10 },
        { role: 'implementer', calls: 1, ms: 1000, prompt: 1, completion: 10 },
        { role: 'planner', calls: 1, ms: 1000, prompt: 1, completion: 10 },
      ],
    },
  ])
  assert.deepEqual(
    merged.map((item) => item.role),
    ['leader', 'planner', 'implementer', 'verifier'],
  )
})
