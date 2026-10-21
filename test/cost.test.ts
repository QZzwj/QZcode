import assert from 'node:assert/strict'
import test from 'node:test'
import { CostLedger, DEFAULT_COST, estimateCost, formatMoney, priceFor, runCost } from '../src/cost.ts'
import { normalizeConfig, EXAMPLE_CONFIG } from '../src/config.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

test('成本：按 token 和单价算钱，模型可以单独定价', () => {
  const config = { ...DEFAULT_COST, perMTokens: { input: 2, output: 8 } }
  // 1M 输入 + 1M 输出 = 2 + 8 = 10
  assert.equal(estimateCost({ prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 }, 'plain', config), 10)
  // 便宜的模型有单独单价
  const cheap = { ...config, models: { cheap: { input: 0.1, output: 0.4 } } }
  assert.equal(priceFor('cheap', cheap).input, 0.1)
  assert.equal(estimateCost({ prompt: 1_000_000, completion: 0, total: 1_000_000 }, 'cheap', cheap), 0.1)
  // 没配过的模型回落到默认
  assert.equal(priceFor('unknown', cheap).input, 2)
})

test('成本：按角色汇总，每个角色用自己模型的单价', () => {
  const config = { ...DEFAULT_COST, models: { expensive: { input: 10, output: 10 }, cheap: { input: 1, output: 1 } } }
  const cost = runCost(
    config,
    {
      leader: { prompt: 1_000_000, completion: 0, total: 1_000_000 },
      planner: { prompt: 0, completion: 1_000_000, total: 1_000_000 },
    },
    { leader: 'cheap', planner: 'expensive' },
  )
  assert.equal(cost.byRole.leader, 1)
  assert.equal(cost.byRole.planner, 10)
  assert.equal(cost.total, 11)
  assert.equal(cost.byModel.cheap, 1)
  assert.equal(cost.byModel.expensive, 10)
})

test('账本：按天累计、能算预算余量、只留最近 500 条', () => {
  const dir = tempWorkspace('cost-ledger')
  try {
    const ledger = new CostLedger(dir)
    ledger.record({ runId: 'a', goal: '第一个任务', total: 0.3, byRole: { planner: 0.2, implementer: 0.1 }, tokens: 1000 })
    ledger.record({ runId: 'b', goal: '第二个任务', total: 0.2, byRole: { verifier: 0.2 }, tokens: 800 })

    const config = { ...DEFAULT_COST, dailyBudget: 0 }
    const summary = ledger.summary(config, 1)
    assert.equal(summary.runs, 2)
    assert.equal(summary.today, 0.5)
    assert.equal(summary.budget, 1)
    assert.equal(summary.remaining, 0.5)
    assert.equal(summary.overBudget, false)
    assert.equal(summary.byRole.planner, 0.2)
    assert.equal(summary.recent[0].runId, 'b', '最近的排在最前')

    // 超预算
    ledger.record({ runId: 'c', goal: '第三个任务', total: 0.6, byRole: {}, tokens: 10 })
    const over = ledger.summary(config, 1)
    assert.equal(over.overBudget, true)
    assert.equal(over.remaining, -0.1)

    // 不限预算时不显示余量
    const noBudget = ledger.summary(config, 0)
    assert.equal(noBudget.remaining, null)
    assert.equal(noBudget.overBudget, false)

    // 超过 500 条只留尾巴
    for (let i = 0; i < 520; i++) ledger.record({ runId: `r${i}`, goal: 'x', total: 0, byRole: {}, tokens: 0 })
    assert.equal(ledger.read().entries.length, 500)
  } finally {
    removeDir(dir)
  }
})

test('配置：cost 字段有默认值，也能从 json 读出来', () => {
  const dir = tempWorkspace('cost-config')
  try {
    const defaults = normalizeConfig({ ...EXAMPLE_CONFIG }, { mock: true, workspace: dir })
    assert.equal(defaults.cost.currency, 'CNY')
    assert.ok(defaults.cost.perMTokens.input > 0)

    const custom = normalizeConfig(
      {
        ...EXAMPLE_CONFIG,
        cost: {
          currency: 'USD',
          perMTokens: { input: 0.5, output: 1.5 },
          models: { 'cn:auto': { input: 0.1, output: 0.2 } },
          dailyBudget: 5,
        },
      },
      { mock: true, workspace: dir },
    )
    assert.equal(custom.cost.currency, 'USD')
    assert.equal(custom.cost.perMTokens.input, 0.5)
    assert.equal(custom.cost.models['cn:auto'].output, 0.2)
    assert.equal(custom.cost.dailyBudget, 5)
  } finally {
    removeDir(dir)
  }
})

test('formatMoney：小额显示 4 位，大额 2 位', () => {
  assert.match(formatMoney(0.0123, 'CNY'), /¥0\.0123/)
  assert.match(formatMoney(3.456, 'CNY'), /¥3\.46/)
  assert.match(formatMoney(1.5, 'USD'), /\$1\.50/)
})

test('输出速度：只算 completion，prompt 再大也不许摊进去', () => {
  const dir = tempWorkspace('cost-speed')
  try {
    const ledger = new CostLedger(dir)
    // 输出 1000 token / 2s = 500 tok/s（prompt 故意设成 10 万，验证它不参与）
    ledger.record({ runId: 'a', goal: '快的一轮', total: 0.1, byRole: {}, tokens: 101000, prompt: 100000, completion: 1000, ms: 2000 })
    // 输出 300 token / 6s = 50 tok/s
    ledger.record({ runId: 'b', goal: '慢的一轮', total: 0.1, byRole: {}, tokens: 50300, prompt: 50000, completion: 300, ms: 6000 })

    const summary = ledger.summary({ ...DEFAULT_COST }, 0)
    // 平均 = (1000+300) / (2+6)s = 162.5
    assert.equal(summary.avgTokPerSec, 162.5, '平均值只按输出 token 算')
    assert.equal(summary.maxTokPerSec, 500, '峰值取最快那次')
    assert.equal(summary.speedSamples, 2)
    assert.equal(summary.avgRunMs, 4000)

    // 单个样本时不算峰值（一个数和自己的最大值没意义）
    const single = new CostLedger(tempWorkspace('cost-speed-one'))
    single.record({ runId: 'solo', goal: '只有一次', total: 0.1, byRole: {}, tokens: 5000, prompt: 4000, completion: 1000, ms: 2000 })
    const soloSummary = single.summary({ ...DEFAULT_COST }, 0)
    assert.equal(soloSummary.avgTokPerSec, 500)
    assert.equal(soloSummary.maxTokPerSec, 0, '只有一次运行时不报峰值')
  } finally {
    removeDir(dir)
  }
})

test('旧账本（没有 completion 字段）不参与输出速度，也不冒充数据', () => {
  const dir = tempWorkspace('cost-speed-legacy')
  try {
    const ledger = new CostLedger(dir)
    // 老格式：只有 tokens（prompt+completion 混在一起）
    ledger.record({ runId: 'old', goal: '老条目', total: 1.8, byRole: {}, tokens: 797524, ms: 323010 })
    const summary = ledger.summary({ ...DEFAULT_COST }, 0)
    assert.equal(summary.avgTokPerSec, 0, '老数据算不出输出速度就别显示')
    assert.equal(summary.speedSamples, 0)
    assert.equal(summary.avgRunMs, 323010, '耗时本身是真的，可以照常显示')
  } finally {
    removeDir(dir)
  }
})