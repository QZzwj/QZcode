import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { nextRunNumber, renderRunLog, writeRunLog } from '../src/runlog.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

const events = [
  { t: 'run_start', runId: 'abcd1234' },
  { t: 'route', decision: { route: 'pipeline', why: '要写文件', difficulty: 'normal', hint: '单文件即可' } },
  { t: 'phase', phase: 'plan', round: 1 },
  { t: 'text', pane: 'planner', delta: '## 任务\n做一个倒计时页面。\n' },
  { t: 'plan', plan: { acceptance: ['单个 html', '数字每秒减一', '结束有提示'] } },
  { t: 'phase', phase: 'implement', round: 1 },
  { t: 'tool', pane: 'implementer', stage: 'end', name: 'write', ok: true, ms: 96, args: '{"path":"index.html"}' },
  { t: 'tool', pane: 'implementer', stage: 'end', name: 'browser', ok: true, ms: 812, args: '{"action":"open"}' },
  { t: 'patch', pane: 'implementer', path: 'index.html', added: 42, removed: 0 },
  { t: 'text', pane: 'implementer', delta: '写好了，用浏览器验证过。' },
  { t: 'phase', phase: 'verify', round: 1 },
  { t: 'tool', pane: 'verifier', stage: 'end', name: 'browser', ok: true, ms: 500 },
  { t: 'verdict', verdict: { pass: true, notes: '三个验收点都过了' } },
  { t: 'text', pane: 'verifier', delta: '倒计时正常递减。' },
  { t: 'note', message: '本轮记录已写入 .qzcode/run1.md' },
  { t: 'done', result: { ok: true, rounds: 1, elapsedMs: 18400, usage: { total: 6997, completion: 1797 } } },
]

test('运行记录：四段齐活，L/A/B/C 各自干了什么都写清楚', () => {
  const markdown = renderRunLog(
    {
      runId: 'abcd1234',
      goal: '做一个倒计时页面',
      startedAt: Date.now() - 18_400,
      status: 'passed',
      events: events as never,
      steps: [
        { role: 'planner', calls: 2, ms: 4000, completion: 800 },
        { role: 'implementer', calls: 3, ms: 6000, completion: 1200 },
        { role: 'verifier', calls: 1, ms: 2000, completion: 300 },
      ],
      touched: 1,
    },
    1,
  )

  // 标题与抬头
  assert.match(markdown, /^# run1 · 做一个倒计时页面/m, '标题带轮次和目标')
  assert.match(markdown, /- 结果：通过（1 轮）/)
  assert.match(markdown, /- 用量：6997 tok（其中输出 1797 tok）/)
  assert.match(markdown, /- 改动文件：1 个/)

  // 四段都在，顺序是 L → A → B → C
  const order = ['L · 调度', 'A · 任务书', 'B · 实现', 'C · 核验'].map((title) => markdown.indexOf(title))
  assert.ok(order.every((index) => index > 0), '四段标题都要有')
  assert.deepEqual([...order].sort((a, b) => a - b), order, '顺序必须是 L/A/B/C')

  // L 的决策
  assert.match(markdown, /- 决策：走流水线/)
  assert.match(markdown, /- 理由：要写文件/)
  assert.match(markdown, /- 派活提示：单文件即可/)

  // A 的验收
  assert.match(markdown, /验收标准（3 条）/)
  assert.match(markdown, /- 数字每秒减一/)

  // B 的工具与改动
  assert.match(markdown, /`index\.html` \+42 −0/)
  assert.match(markdown, /工具调用（2 次）/)
  assert.match(markdown, /- write OK 96ms/)
  assert.match(markdown, /- browser OK 812ms/)

  // C 的结论
  assert.match(markdown, /结论：通过/)
  assert.match(markdown, /倒计时正常递减/)

  // 各步骤用量
  assert.match(markdown, /## 各步骤用量/)
  assert.match(markdown, /B · 实现：3 次调用/)
})

test('运行记录：没调 L 的时候说明"关键词预筛"，不留空段', () => {
  const markdown = renderRunLog(
    { runId: 'x', goal: '写个页面', startedAt: Date.now(), status: 'passed', events: events.slice(2) as never },
    2,
  )
  assert.match(markdown, /这一轮没调 L（关键词预筛直接进流水线）/)
  assert.match(markdown, /^# run2 ·/m)
})

test('运行记录：文件编号接在已有的后面', () => {
  const dir = tempWorkspace('runlog-number')
  try {
    const logDir = join(dir, '.qzcode')
    mkdirSync(logDir, { recursive: true })
    assert.equal(nextRunNumber(dir), 1, '空目录从 1 开始')

    writeFileSync(join(logDir, 'run1.md'), 'x', 'utf8')
    writeFileSync(join(logDir, 'run2.md'), 'x', 'utf8')
    assert.equal(nextRunNumber(dir), 3, '已有 1、2 → 下一个是 3')

    // 不是 runN.md 的文件不影响编号
    writeFileSync(join(logDir, 'snapshots'), 'x', 'utf8')
    writeFileSync(join(logDir, 'notes.md'), 'x', 'utf8')
    assert.equal(nextRunNumber(dir), 3)
  } finally {
    removeDir(dir)
  }
})

test('运行记录：真的写到 .qzcode/run1.md', () => {
  const dir = tempWorkspace('runlog-write')
  try {
    const result = writeRunLog(dir, {
      runId: 'abcd1234',
      goal: '做一个倒计时页面',
      startedAt: Date.now(),
      status: 'passed',
      events: events as never,
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.index, 1)
    assert.ok(result.path && existsSync(result.path), '文件要真的存在')
    assert.ok(result.path?.endsWith(join('.qzcode', 'run1.md')), `路径不对：${result.path}`)
    assert.match(readFileSync(result.path!, 'utf8'), /^# run1 ·/m)

    // 第二次写到 run2.md
    const second = writeRunLog(dir, {
      runId: 'efgh5678',
      goal: '再跑一轮',
      startedAt: Date.now(),
      status: 'failed',
      events: events as never,
    })
    assert.equal(second.index, 2)
    assert.ok(second.path?.endsWith('run2.md'))
    assert.match(readFileSync(second.path!, 'utf8'), /- 结果：未通过/)
  } finally {
    removeDir(dir)
  }
})
