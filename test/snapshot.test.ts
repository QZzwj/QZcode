import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { diffSnapshot, listSnapshots, loadSnapshot, restoreFromIndex, SnapshotStore, unifiedDiff } from '../src/snapshot.ts'
import { Toolbox, createTools } from '../src/tools.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

test('快照：改之前存原件，回滚能还原', () => {
  const dir = tempWorkspace('snap-restore')
  try {
    const file = join(dir, 'a.txt')
    writeFileSync(file, '原来的内容\n第二行\n', 'utf8')

    const store = new SnapshotStore('run1', dir)
    store.capture(file)
    writeFileSync(file, '被 B 改掉了\n', 'utf8')

    // 新建的文件也要记下来（回滚时删掉）
    const created = join(dir, 'b.txt')
    store.capture(created)
    writeFileSync(created, '新文件', 'utf8')

    const index = loadSnapshot(dir, 'run1')
    assert.equal(index?.entries.length, 2)

    const result = restoreFromIndex(dir, index!)
    assert.deepEqual(result.restored, ['a.txt'])
    assert.deepEqual(result.deleted, ['b.txt'])
    assert.equal(readFileSync(file, 'utf8'), '原来的内容\n第二行\n', '内容要还原')
    assert.equal(existsSync(created), false, '新建的文件要被删掉')
  } finally {
    removeDir(dir)
  }
})

test('快照：同一个文件只存第一次（多轮修改不会覆盖原件）', () => {
  const dir = tempWorkspace('snap-once')
  try {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'v1', 'utf8')
    const store = new SnapshotStore('run2', dir)
    store.capture(file)
    writeFileSync(file, 'v2', 'utf8')
    store.capture(file)
    writeFileSync(file, 'v3', 'utf8')
    assert.equal(store.touched, 1, '同一个文件只记一次')
    restoreFromIndex(dir, loadSnapshot(dir, 'run2')!)
    assert.equal(readFileSync(file, 'utf8'), 'v1', '回到最初的样子')
  } finally {
    removeDir(dir)
  }
})

test('快照：不碰 .qzcode 目录，也不碰工作区外的路径', () => {
  const dir = tempWorkspace('snap-skip')
  try {
    const store = new SnapshotStore('run3', dir)
    store.capture(join(dir, '.qzcode', 'snapshots', 'x', 'index.json'))
    store.capture(join(dir, '..', 'outside.txt'))
    assert.equal(store.touched, 0)
  } finally {
    removeDir(dir)
  }
})

test('diff：能分清新增 / 修改 / 删除，并给出增删行数', () => {
  const dir = tempWorkspace('snap-diff')
  try {
    const modified = join(dir, 'm.txt')
    const removed = join(dir, 'd.txt')
    writeFileSync(modified, 'line1\nline2\nline3\n', 'utf8')
    writeFileSync(removed, 'will be gone\n', 'utf8')

    const store = new SnapshotStore('run4', dir)
    store.capture(modified)
    store.capture(removed)
    store.capture(join(dir, 'new.txt'))

    writeFileSync(modified, 'line1\nline2 changed\nline3\nline4\n', 'utf8')
    writeFileSync(join(dir, 'new.txt'), 'brand new\n', 'utf8')
    rmSync(removed) // 真的删掉才能验证 deleted 分支

    const files = diffSnapshot(dir, loadSnapshot(dir, 'run4')!)
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
    assert.equal(byPath['m.txt']?.status, 'modified')
    assert.ok((byPath['m.txt']?.added ?? 0) >= 1, '要有新增行')
    assert.ok((byPath['m.txt']?.removed ?? 0) >= 1, '要有删除行')
    assert.equal(byPath['new.txt']?.status, 'created')
    assert.equal(byPath['d.txt']?.status, 'deleted')
    assert.match(byPath['m.txt']?.diff ?? '', /line2 changed/)

    // 什么都没改时 diff 为空
    writeFileSync(modified, 'line1\nline2\nline3\n', 'utf8')
    writeFileSync(join(dir, 'new.txt'), '', 'utf8')
  } finally {
    removeDir(dir)
  }
})

test('unifiedDiff：相同内容返回空', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'x'), '')
  assert.match(unifiedDiff('a\n', 'b\n', 'x'), /--- x/)
})

test('工具层：write / edit 真的会触发快照 hook', async () => {
  const dir = tempWorkspace('snap-tools')
  try {
    const toolbox = new Toolbox(createTools())
    const captured: string[] = []
    const runtime = {
      workspace: dir,
      exec: { enabled: false, timeoutMs: 1000 },
      snapshot: (absPath: string) => captured.push(absPath),
    }

    writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8')
    await toolbox.call('write', JSON.stringify({ path: 'a.txt', content: 'hello world\n' }), runtime)
    await toolbox.call('write', JSON.stringify({ path: 'b.txt', content: 'new\n' }), runtime)
    await toolbox.call('edit', JSON.stringify({ path: 'a.txt', oldText: 'world', newText: 'there' }), runtime)

    assert.equal(captured.length, 3, 'write/write/edit 各触发一次')
    assert.ok(captured.every((absPath) => absPath.startsWith(dir)))
  } finally {
    removeDir(dir)
  }
})
