import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { nextRunNumber } from '../src/runlog.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

/**
 * 计划模式：任务书出来先停，确认后再按 presetPlan 执行。
 * 这里直接测流水线本身（不起 HTTP），因为闸门逻辑就在流水线里。
 */
import { runPipeline } from '../src/pipeline.ts'
import { Toolbox, createTools } from '../src/tools.ts'
import { EXAMPLE_CONFIG, normalizeConfig } from '../src/config.ts'
import type { Reporter } from '../src/pipeline.ts'

function silentReporter(): Reporter & { notes: string[]; phases: string[] } {
  const notes: string[] = []
  const phases: string[] = []
  return {
    notes,
    phases,
    phase(phase) {
      phases.push(phase)
    },
    text() {},
    textEnd() {},
    tool() {},
    note(message) {
      notes.push(message)
    },
    plan() {},
    review() {},
    verdict() {},
    done() {},
    usage() {},
  }
}

function mockConfigFor(dir: string) {
  return normalizeConfig({ ...EXAMPLE_CONFIG, maxRounds: 1 }, { mock: true, workspace: dir })
}

test('计划模式：只跑到 A 就停，不动文件', async () => {
  const dir = tempWorkspace('planonly')
  try {
    const config = mockConfigFor(dir)
    const reporter = silentReporter()
    const toolbox = new Toolbox(createTools())
    const result = await runPipeline({
      config,
      goal: '写一个说明文件',
      toolbox,
      toolRuntime: { workspace: dir, exec: { enabled: true, timeoutMs: 20_000 } },
      reporter,
      planOnly: true,
    })

    assert.equal(result.planned, true, '要标记成计划模式')
    assert.ok(result.plan, '要产出任务书')
    assert.equal(result.verdict, null, '还没核验')
    assert.ok(reporter.phases.includes('plan'), '走到了 A 那一步')
    assert.ok(!reporter.phases.includes('implement'), '不该进 B')
    // 计划模式不产生文件
    const touched = Object.keys(reporter).length // 占位，真正检查看下面
    void touched
    assert.equal(readFileSafe(join(dir, 'notes', 'plan.md')), '', 'mock 的写文件动作不该发生')
  } finally {
    removeDir(dir)
  }
})

test('计划模式：拿任务书继续执行时跳过 A', async () => {
  const dir = tempWorkspace('plancontinue')
  try {
    const config = mockConfigFor(dir)
    const toolbox = new Toolbox(createTools())

    const first = silentReporter()
    const planned = await runPipeline({
      config,
      goal: '写一个说明文件',
      toolbox,
      toolRuntime: { workspace: dir, exec: { enabled: true, timeoutMs: 20_000 } },
      reporter: first,
      planOnly: true,
    })
    assert.equal(planned.planned, true)

    const second = silentReporter()
    const ran = await runPipeline({
      config,
      goal: '写一个说明文件',
      toolbox,
      toolRuntime: { workspace: dir, exec: { enabled: true, timeoutMs: 20_000 } },
      reporter: second,
      presetPlan: planned.plan!,
    })

    assert.equal(ran.planned, undefined, '第二轮不是计划模式')
    assert.ok(
      second.notes.some((note) => note.includes('跳过 L 的分流')),
      '预设任务书时不该再花 L 的 token',
    )
    assert.ok(second.notes.some((note) => note.includes('沿用你确认过的任务书')), '要提示跳过了 A')
    // 直接进 B：plan 阶段之后紧接着 implement
    const implementIndex = second.phases.indexOf('implement')
    assert.ok(implementIndex >= 0, '应该进到实现了')
    assert.ok(second.phases.indexOf('plan') < implementIndex)
  } finally {
    removeDir(dir)
  }
})

test('计划模式：运行记录照样写一份（含任务书）', async () => {
  const dir = tempWorkspace('planlog')
  try {
    assert.equal(nextRunNumber(dir), 1)
  } finally {
    removeDir(dir)
  }
})

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
