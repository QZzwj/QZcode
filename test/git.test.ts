import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { commitPaths, headShort, isGitRepo } from '../src/git.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

const run = promisify(execFile)

async function makeRepo(dir: string): Promise<boolean> {
  try {
    await run('git', ['init', '-q'], { cwd: dir, windowsHide: true })
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, windowsHide: true })
    await run('git', ['config', 'user.name', 'QZcode Test'], { cwd: dir, windowsHide: true })
    return true
  } catch {
    return false
  }
}

test('git：不是仓库时先 git init 再提交（不然开关等于没用）', async () => {
  const dir = tempWorkspace('git-norepo')
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8')
    assert.equal(await isGitRepo(dir), false, '起始状态不该是仓库')

    const result = await commitPaths(dir, ['a.txt'], 'qzcode: 第一次提交')
    assert.equal(result.ok, true, result.error)
    assert.equal(result.repo, true, '提交完后就是仓库了')
    assert.equal(result.initialized, true, '要标记出"这次新建了仓库"')
    assert.ok(result.commit, '应该有提交号')
    assert.equal(await isGitRepo(dir), true)

    // 第二次提交就不该再 init
    writeFileSync(join(dir, 'a.txt'), 'hello again\n', 'utf8')
    const again = await commitPaths(dir, ['a.txt'], 'qzcode: 第二次')
    assert.equal(again.ok, true, again.error)
    assert.equal(again.initialized, false, '第二次不该再 init')
    assert.ok(again.commit)
  } finally {
    removeDir(dir)
  }
})

test('git：只提交传进来的那些路径，不会顺手提交用户未提交的改动', async (t) => {
  const dir = tempWorkspace('git-commit')
  try {
    if (!(await makeRepo(dir))) {
      t.skip('这台机器没有 git')
      return
    }
    writeFileSync(join(dir, 'mine.txt'), '我自己的改动\n', 'utf8')
    writeFileSync(join(dir, 'agent.txt'), 'agent 写的 1\n', 'utf8')

    // 基线提交
    await run('git', ['add', 'mine.txt', 'agent.txt'], { cwd: dir, windowsHide: true })
    await run('git', ['commit', '-qm', 'init'], { cwd: dir, windowsHide: true })

    // 用户动了自己的文件；agent 改了 agent.txt
    writeFileSync(join(dir, 'mine.txt'), '我自己的改动（未提交）\n', 'utf8')
    writeFileSync(join(dir, 'agent.txt'), 'agent 写的 2\n', 'utf8')

    const result = await commitPaths(dir, ['agent.txt'], 'qzcode: 改 agent.txt')
    assert.equal(result.ok, true, result.error)
    assert.ok(result.commit, '应该产生提交')

    // 提交里只能有 agent.txt
    const { stdout } = await run('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
      cwd: dir,
      windowsHide: true,
    })
    assert.match(stdout, /agent\.txt/)
    assert.doesNotMatch(stdout, /mine\.txt/, '不能把用户自己的改动一起提交')

    // 用户那份改动还在
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: dir, windowsHide: true })
    assert.match(status, /mine\.txt/)

    // 没改动时不再造空提交
    const again = await commitPaths(dir, ['agent.txt'], 'qzcode: 再来一次')
    assert.equal(again.ok, true)
    assert.match(again.skipped ?? '', /不需要提交|一致/)
    assert.ok(await headShort(dir))
  } finally {
    removeDir(dir)
  }
})

test('git：没有改动路径时什么都不做', async () => {
  const dir = tempWorkspace('git-empty')
  try {
    const result = await commitPaths(dir, [], 'qzcode: 空')
    assert.equal(result.ok, true)
    assert.match(result.skipped ?? '', /没有改动/)
  } finally {
    removeDir(dir)
  }
})
