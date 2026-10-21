import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractJson,
  implementerBrief,
  parsePlan,
  parseReview,
  parseVerdict,
  workspaceSummary,
  describePlanProblem,
  planRetryNudge,
  parseRoute,
  prefilterWork,
} from '../src/roles.ts'
import { removeDir, tempWorkspace } from './helpers.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

test('extractJson handles fences, prose and nested braces', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('前缀 {"a":{"b":[1,2]}} 后缀'), { a: { b: [1, 2] } })
  assert.equal(extractJson('没有 JSON'), null)
  assert.deepEqual(extractJson('{"s":"含}花括号"}'), { s: '含}花括号' })
})

test('parsePlan reads the contract and degrades on prose', () => {
  const good = parsePlan(
    '我理解目标是修 bug。\n\n```json\n{"prompt":"改 a.ts","guidance":["先读文件"],"acceptance":["node --test 退出码 0"],"steps":["读","改"],"risks":["可能没有测试"]}\n```',
  )
  assert.equal(good.parsed, true)
  assert.equal(good.prompt, '改 a.ts')
  assert.deepEqual(good.acceptance, ['node --test 退出码 0'])
  assert.match(good.preamble, /我理解目标/)

  const prose = parsePlan('直接改就行，没有 JSON')
  assert.equal(prose.parsed, false)
  assert.match(prose.prompt, /直接改就行/)
  assert.deepEqual(prose.acceptance, [])
})

test('parseVerdict honours blockers and the pass flag', () => {
  const pass = parseVerdict('```json\n{"pass":true,"summary":"ok","issues":[],"evidence":["node --test"]}\n```')
  assert.equal(pass.pass, true)
  assert.deepEqual(pass.evidence, ['node --test'])

  const blocked = parseVerdict(
    '```json\n{"pass":true,"summary":"看起来行","issues":[{"severity":"blocker","where":"a.ts","problem":"崩溃","fix":"修它"}]}\n```',
  )
  assert.equal(blocked.pass, false, 'a blocker must override a careless pass:true')
  assert.equal(blocked.issues[0].severity, 'blocker')

  const minor = parseVerdict('{"pass":true,"issues":[{"severity":"nit","problem":"命名"}]}')
  assert.equal(minor.pass, true)
  assert.equal(minor.issues[0].severity, 'minor')
  assert.equal(minor.issues[0].fix, '')
})

test('parseVerdict without JSON falls back to a conservative judgement', () => {
  assert.equal(parseVerdict('结论：通过，测试全绿').pass, true)
  assert.equal(parseVerdict('我不确定，可能有问题').pass, false)
  const failed = parseVerdict('没给 JSON')
  assert.equal(failed.parsed, false)
  assert.equal(failed.issues[0].severity, 'major')
})

test('implementerBrief carries the acceptance criteria verbatim', () => {
  const plan = parsePlan(
    '```json\n{"prompt":"实现 foo","guidance":["先读"],"acceptance":["node --test 退出码 0"],"steps":["a"],"risks":["r"]}\n```',
  )
  const brief = implementerBrief(plan, '原始目标', 2)
  assert.match(brief, /实现 foo/)
  assert.match(brief, /node --test 退出码 0/)
  assert.match(brief, /第 2 轮/)
  assert.match(brief, /原始目标/)
})

test('workspaceSummary lists files and hides noise', () => {
  const dir = tempWorkspace('summary')
  try {
    writeFileSync(join(dir, 'a.txt'), 'x', 'utf8')
    writeFileSync(join(dir, '.hidden'), 'x', 'utf8')
    const summary = workspaceSummary(dir)
    assert.match(summary, /a\.txt/)
    assert.ok(!summary.includes('.hidden'))
  } finally {
    removeDir(dir)
  }
})

test('parseReview：跑偏要带修正词，给了修正词就不放行', () => {
  const off = parseReview(
    '理由略\n```json\n{"ok": false, "summary": "偏了", "drift": ["没跑测试"], "brief": "补 node --test 并把输出贴出来"}\n```',
  )
  assert.equal(off.ok, false)
  assert.deepEqual(off.drift, ['没跑测试'])
  assert.match(off.brief, /node --test/)

  const aligned = parseReview('```json\n{"ok": true, "summary": "对齐", "drift": [], "brief": ""}\n```')
  assert.equal(aligned.ok, true)
  assert.equal(aligned.brief, '')

  // 自相矛盾：说 ok 却给了修正词 → 按跑偏处理
  const contradictory = parseReview('```json\n{"ok": true, "brief": "还是改一下 a.ts"}\n```')
  assert.equal(contradictory.ok, false)

  // 解析不出来不要卡住流水线
  const garbage = parseReview('我觉得还行')
  assert.equal(garbage.ok, true)
  assert.equal(garbage.parsed, false)
})
test('describePlanProblem：空任务书必须被抓住', () => {
  const fence = '```'
  const empty = parsePlan('我想了一下，这个任务要动手做东西。')
  assert.ok(empty.prompt.length > 0, '纯散文也会被当成 prompt')
  assert.equal(empty.acceptance.length, 0)
  assert.match(describePlanProblem(empty), /acceptance 为空/)
  assert.match(describePlanProblem(empty), /没有按要求的/)

  const noPrompt = parsePlan(fence + 'json\n{"acceptance": ["跑起来"]}\n' + fence)
  assert.match(describePlanProblem(noPrompt), /prompt/)

  const longPrompt =
    '写一个 index.html，用 canvas 画一个方块，支持按住蓄力、松手后按抛物线起跳，落空即结束并显示得分与最高分'.repeat(2)
  const good = parsePlan(fence + 'json\n{"prompt": "' + longPrompt + '", "acceptance": ["文件存在且能打开"]}\n' + fence)
  assert.equal(describePlanProblem(good), '', '合格任务书不应报问题')
})

test('planRetryNudge 会点名缺什么', () => {
  const plan = parsePlan('随便说说')
  const nudge = planRetryNudge(plan, describePlanProblem(plan))
  assert.match(nudge, /acceptance/)
  assert.match(nudge, /json 代码块/)
  assert.match(nudge, /没有找到/)
})

test('parseRoute：direct 必须有答案，否则退回 work', () => {
  const fence = '```'
  const direct = parseRoute(
    '这是概念问答\n' + fence + 'json\n{"route":"direct","difficulty":"trivial","why":"问答","answer":"闭包是函数加它的词法环境","hint":""}\n' + fence,
  )
  assert.equal(direct.route, 'direct')
  assert.equal(direct.parsed, true)
  assert.match(direct.answer, /词法环境/)

  // 说 direct 却没给答案 → 不能把空气交给用户
  const empty = parseRoute(fence + 'json\n{"route":"direct","answer":""}\n' + fence)
  assert.equal(empty.route, 'work')

  const work = parseRoute(fence + 'json\n{"route":"work","difficulty":"hard","why":"要改文件","answer":"","hint":"单文件"}\n' + fence)
  assert.equal(work.route, 'work')
  assert.equal(work.difficulty, 'hard')
  assert.equal(work.hint, '单文件')

  // 解析失败 → 保守走流水线
  const garbage = parseRoute('我觉得这个问题可以直接答')
  assert.equal(garbage.route, 'work')
  assert.equal(garbage.parsed, false)
})

test('prefilterWork：要动手的目标绝不放过', () => {
  const keywords = ['写', '实现', 'html', '修复']
  assert.equal(prefilterWork('帮我制作一个跳一跳的html', keywords), true)
  assert.equal(prefilterWork('修复 provider 的 key 校验', keywords), true)
  assert.equal(prefilterWork('看下 src/app.ts 为什么报错', keywords), true)
  assert.equal(prefilterWork('```js\nconsole.log(1)\n```', keywords), true)
  assert.equal(prefilterWork('什么是闭包？', keywords), false)
  assert.equal(prefilterWork('解释一下 event loop', keywords), false)
})
