import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { lastRunContext, rememberRunContext } from '../src/web/server.ts'
import { SnapshotStore, restoreFromIndex } from '../src/snapshot.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

/** ⑤ 按文件回滚：只还原指定的路径，其它不动。 */
test('按文件回滚：只还原点名的文件，新建的会删掉，未点名的保持改动', () => {
  const dir = tempWorkspace('rollback-one')
  try {
    writeFileSync(join(dir, 'a.txt'), '原始 A\n', 'utf8')
    writeFileSync(join(dir, 'b.txt'), '原始 B\n', 'utf8')
    const store = new SnapshotStore('run1', dir)
    store.capture(join(dir, 'a.txt'))
    store.capture(join(dir, 'b.txt'))
    store.capture(join(dir, 'new.txt'))

    writeFileSync(join(dir, 'a.txt'), '改过的 A\n', 'utf8')
    writeFileSync(join(dir, 'b.txt'), '改过的 B\n', 'utf8')
    writeFileSync(join(dir, 'new.txt'), '新建的文件\n', 'utf8')

    const result = restoreFromIndex(dir, { runId: 'run1', workspace: dir, createdAt: Date.now(), entries: store.entries }, ['a.txt', 'new.txt'])

    assert.deepEqual(result.restored, ['a.txt'])
    assert.deepEqual(result.deleted, ['new.txt'])
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), '原始 A\n', 'a 要还原')
    assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), '改过的 B\n', 'b 没点名，保持改动')
    assert.equal(existsSync(join(dir, 'new.txt')), false, '新建的要点名后删掉')
  } finally {
    removeDir(dir)
  }
})

test('按文件回滚：不传路径就是全都还原', () => {
  const dir = tempWorkspace('rollback-all')
  try {
    writeFileSync(join(dir, 'a.txt'), '原始\n', 'utf8')
    const store = new SnapshotStore('run1', dir)
    store.capture(join(dir, 'a.txt'))
    writeFileSync(join(dir, 'a.txt'), '改过\n', 'utf8')

    const result = restoreFromIndex(dir, { runId: 'run1', workspace: dir, createdAt: Date.now(), entries: store.entries })
    assert.deepEqual(result.restored, ['a.txt'])
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), '原始\n')
  } finally {
    removeDir(dir)
  }
})

/** ② 多轮上下文：上一轮的目标/结论/改动/验收能带到下一轮。 */
test('多轮上下文：上一轮干了什么会被记住，并提供给下一轮', () => {
  const dir = tempWorkspace('run-context')
  try {
    assert.equal(lastRunContext(dir), undefined, '一开始没有上下文')

    const run = {
      id: 'abcd1234',
      goal: '做一个倒计时页面',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'passed',
      events: [
        { t: 'plan', plan: { acceptance: ['单个文件', '每秒减一'] } },
        { t: 'patch', pane: 'implementer', path: 'index.html' },
        { t: 'verdict', verdict: { pass: true, notes: '三个验收点都过了' } },
      ],
      seq: 3,
    }

    rememberRunContext(dir, run as never, 'passed', { usage: { total: 4321 } })
    const text = lastRunContext(dir)

    assert.ok(text, '要能取回上下文')
    assert.match(text!, /上一轮目标：做一个倒计时页面/)
    assert.match(text!, /上一轮结果：通过/)
    assert.match(text!, /改过的文件：index\.html/)
    assert.match(text!, /核验意见：三个验收点都过了/)
    assert.match(text!, /当时的验收标准：单个文件；每秒减一/)
    assert.match(text!, /上一轮用量：4321 tok/)
  } finally {
    removeDir(dir)
  }
})

test('多轮上下文：计划模式那一轮也记（只出了任务书）', () => {
  const dir = tempWorkspace('run-context-planned')
  try {
    const run = {
      id: 'plan1234',
      goal: '做一个抽奖转盘',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'planned',
      events: [{ t: 'plan', plan: { acceptance: ['能转', '能停'] } }],
      seq: 1,
    }
    rememberRunContext(dir, run as never, 'planned', null)
    assert.match(lastRunContext(dir) ?? '', /上一轮结果：只出了任务书/)
  } finally {
    removeDir(dir)
  }
})
