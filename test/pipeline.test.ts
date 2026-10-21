import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createPlainReporter, runPipeline } from '../src/pipeline.ts'
import type { Reporter, RunResult } from '../src/pipeline.ts'
import { Toolbox, createTools } from '../src/tools.ts'
import { mockConfig, removeDir, tempWorkspace } from './helpers.ts'

process.env.QZCODE_MOCK_DELAY = '0'

function recordingReporter(): Reporter & { lines: string[]; verdicts: boolean[]; phases: string[] } {
  const lines: string[] = []
  const verdicts: boolean[] = []
  const phases: string[] = []
  return {
    lines,
    verdicts,
    phases,
    phase(next, round) {
      phases.push(`${next}:${round}`)
    },
    text(_pane, delta) {
      lines.push(delta)
    },
    textEnd() {},
    tool() {},
    note(message) {
      lines.push(`note:${message}`)
    },
    verdict(_round, verdict) {
      verdicts.push(verdict.pass)
    },
    usage() {},
    done() {},
  }
}

test('the repair loop runs A → B → C until C passes', async () => {
  const dir = tempWorkspace('pipeline')
  try {
    const config = mockConfig(dir, { maxRounds: 3 })
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const reporter = recordingReporter()
    const result: RunResult = await runPipeline({ config, goal: '写一个说明文件', toolbox, toolRuntime: runtime, reporter })

    assert.equal(result.ok, true)
    assert.equal(result.rounds, 2, 'mock verifier fails once, then passes')
    assert.deepEqual(reporter.verdicts, [false, true])
    assert.ok(existsSync(join(dir, 'notes', 'plan.md')), 'B actually wrote the file through the toolbox')
    assert.ok(reporter.phases.includes('plan:1'))
    assert.ok(reporter.phases.includes('implement:2'))
    assert.ok(reporter.phases.includes('verify:2'))
    assert.ok(result.usage.total > 0)
    assert.ok(result.plan?.acceptance.length)
  } finally {
    removeDir(dir)
  }
})

test('A 复核会把跑偏的实现退回 B 修正，再进 C', async () => {
  const dir = tempWorkspace('pipeline-review')
  try {
    const config = mockConfig(dir, { maxRounds: 3 })
    assert.equal(config.review.enabled, true)
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const reporter = recordingReporter()
    const reviews: { round: number; attempt: number; ok: boolean; brief: string }[] = []
    ;(reporter as unknown as Record<string, unknown>).review = (
      round: number,
      review: { ok: boolean; brief: string },
      attempt: number,
    ) => {
      reviews.push({ round, attempt, ok: review.ok, brief: review.brief })
    }
    const result = await runPipeline({ config, goal: '写一个说明文件', toolbox, toolRuntime: runtime, reporter })

    assert.ok(reporter.phases.includes('review:1'), '第 1 轮必须有 A 复核阶段')
    assert.equal(reviews[0]?.ok, false, 'mock 的第一次复核判为跑偏')
    assert.ok(reviews[0].brief.length > 0, '跑偏时必须给出修正词')
    assert.equal(reviews[1]?.ok, true, '修正后复核通过才允许进 C')
    assert.ok(result.reviews && result.reviews.length >= 2)
    assert.equal(result.reviews[0].review.drift.length > 0, true)
    // 退回修正意味着第 1 轮 B 执行了两次
    assert.equal(result.ok, true)
    assert.equal(result.rounds, 2)
  } finally {
    removeDir(dir)
  }
})

test('关掉复核就不插 A 的复核阶段', async () => {
  const dir = tempWorkspace('pipeline-noreview')
  try {
    const config = mockConfig(dir, { maxRounds: 3 })
    config.review.enabled = false
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const reporter = recordingReporter()
    const result = await runPipeline({ config, goal: '写一个说明文件', toolbox, toolRuntime: runtime, reporter })
    assert.equal(reporter.phases.some((phase) => phase.startsWith('review')), false)
    assert.equal(result.reviews?.length ?? 0, 0)
    assert.equal(result.ok, true)
  } finally {
    removeDir(dir)
  }
})

test('A 第一次写歪任务书会自动重写一次（不把空任务书交给 B）', async () => {
  const dir = tempWorkspace('pipeline-plan-retry')
  const previous = process.env.QZCODE_MOCK_PLAN
  process.env.QZCODE_MOCK_PLAN = 'empty-first'
  try {
    const config = mockConfig(dir, { maxRounds: 2 })
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const reporter = recordingReporter()
    const result = await runPipeline({ config, goal: '写一个说明文件', toolbox, toolRuntime: runtime, reporter })

    assert.equal(result.ok, true, '重写之后应该正常跑完')
    assert.ok(
      reporter.lines.some((line) => line.startsWith('note:') && line.includes('没给出可用任务书')),
      '要让用户看到"任务书重写"的提示',
    )
    assert.ok(result.plan?.acceptance.length, '最终任务书必须带验收标准')
  } finally {
    if (previous === undefined) delete process.env.QZCODE_MOCK_PLAN
    else process.env.QZCODE_MOCK_PLAN = previous
    removeDir(dir)
  }
})

test('A 连续两次写歪任务书要明确报错，而不是空跑 B/C', async () => {
  const dir = tempWorkspace('pipeline-plan-fail')
  const previous = process.env.QZCODE_MOCK_PLAN
  process.env.QZCODE_MOCK_PLAN = 'empty-always'
  try {
    const config = mockConfig(dir, { maxRounds: 2 })
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const reporter = recordingReporter()
    // 任务书拿不到时 runPipeline 直接抛错（调用方负责展示），不能静默空跑
    await assert.rejects(
      () => runPipeline({ config, goal: '写一个说明文件', toolbox, toolRuntime: runtime, reporter }),
      /没有给出可用的任务书/,
    )
    assert.equal(reporter.verdicts.length, 0, 'C 不该被叫起来')
    assert.equal(existsSync(join(dir, 'notes', 'plan.md')), false, 'B 不该动手写文件')
  } finally {
    if (previous === undefined) delete process.env.QZCODE_MOCK_PLAN
    else process.env.QZCODE_MOCK_PLAN = previous
    removeDir(dir)
  }
})

test('L 判定 direct 时直接交付答案，不开 A/B/C', async () => {
  const dir = tempWorkspace('pipeline-direct')
  const previous = process.env.QZCODE_MOCK_ROUTE
  process.env.QZCODE_MOCK_ROUTE = 'direct'
  try {
    const config = mockConfig(dir, { maxRounds: 2 })
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const reporter = recordingReporter()
    const result = await runPipeline({ config, goal: '什么是闭包？', toolbox, toolRuntime: runtime, reporter })

    assert.equal(result.ok, true)
    assert.equal(result.route?.route, 'direct')
    assert.ok(result.answer && result.answer.length > 8, '要有可直接交付的答案')
    assert.equal(result.rounds, 0, '零轮：没进 A/B/C')
    assert.equal(reporter.verdicts.length, 0, 'C 不该被叫起')
    assert.ok(reporter.phases.includes('route:1'), '要先经过分流阶段')
    assert.equal(existsSync(join(dir, 'notes', 'plan.md')), false, 'B 不该动手')
  } finally {
    if (previous === undefined) delete process.env.QZCODE_MOCK_ROUTE
    else process.env.QZCODE_MOCK_ROUTE = previous
    removeDir(dir)
  }
})

test('动手型目标会跳过 L 的问询直接进流水线（省一次调用）', async () => {
  const dir = tempWorkspace('pipeline-prefilter')
  try {
    const config = mockConfig(dir, { maxRounds: 2 })
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const reporter = recordingReporter()
    const result = await runPipeline({ config, goal: '制作一个跳一跳的html', toolbox, toolRuntime: runtime, reporter })
    assert.equal(result.route?.prefiltered, true, '关键词预筛命中，不花 token 问 L')
    assert.equal(result.route?.route, 'work')
    assert.ok(result.rounds >= 1, '照常走流水线')
  } finally {
    removeDir(dir)
  }
})

test('leader.enabled=false 时完全不分流', async () => {
  const dir = tempWorkspace('pipeline-noleader')
  try {
    const config = mockConfig(dir, { maxRounds: 2 })
    config.leader.enabled = false
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const reporter = recordingReporter()
    const result = await runPipeline({ config, goal: '什么是闭包？', toolbox, toolRuntime: runtime, reporter })
    assert.equal(reporter.phases.some((phase) => phase.startsWith('route')), false)
    assert.equal(result.route, undefined)
    assert.ok(result.rounds >= 1, '还是会走完整流水线')
  } finally {
    removeDir(dir)
  }
})

test('max rounds bounds the loop when C never passes', async () => {
  const dir = tempWorkspace('pipeline-fail')
  try {
    const config = mockConfig(dir, { maxRounds: 1 })
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const reporter = recordingReporter()
    const result = await runPipeline({ config, goal: '几乎做不到的事', toolbox, toolRuntime: runtime, reporter })
    assert.equal(result.ok, false)
    assert.equal(result.rounds, 1)
    assert.deepEqual(reporter.verdicts, [false])
    assert.equal(result.verdict?.pass, false)
  } finally {
    removeDir(dir)
  }
})

test('an aborted signal stops before the first phase', async () => {
  const dir = tempWorkspace('pipeline-abort')
  try {
    const config = mockConfig(dir)
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
    const controller = new AbortController()
    controller.abort()
    const reporter = recordingReporter()
    const result = await runPipeline({
      config,
      goal: '不会开始',
      toolbox,
      toolRuntime: runtime,
      reporter,
      signal: controller.signal,
    })
    assert.equal(result.ok, false)
    assert.equal(result.rounds, 0)
    assert.equal(reporter.verdicts.length, 0)
  } finally {
    removeDir(dir)
  }
})

test('plain reporter renders phases, tools and verdicts', () => {
  const out: string[] = []
  const reporter = createPlainReporter((line) => out.push(line))
  reporter.phase('plan', 1)
  reporter.text('planner', '第一行\n第二行\n')
  reporter.textEnd('planner')
  reporter.tool({ pane: 'implementer', stage: 'start', name: 'read', args: '{"path":"a"}' })
  reporter.tool({ pane: 'implementer', stage: 'end', name: 'read', ok: true, ms: 3 })
  reporter.note('注意')
  reporter.verdict(1, { pass: false, summary: '不行', issues: [{ severity: 'major', where: 'a', problem: 'p', fix: 'f' }], evidence: [], raw: '', parsed: true })
  reporter.done({ ok: true, rounds: 1, plan: null, verdict: null, usage: { prompt: 1, completion: 2, total: 3 }, elapsedMs: 1200, history: [], implementerReport: '' })
  const text = out.join('\n')
  assert.match(text, /\[plan\] round 1/)
  assert.match(text, /第一行/)
  assert.match(text, /B → read/)
  assert.match(text, /B ← read ok 3ms/)
  assert.match(text, /verdict round 1: FAIL/)
  assert.match(text, /✔ 通过/)
})
