import { readFileSync, writeFileSync } from 'node:fs'

// 1) 开关不再因为"不是仓库"而隐藏：开启时说明会自动 init
{
  const path = 'vscode/media/chat.js'
  let code = readFileSync(path, 'utf8')
  const from = `function renderGit() {
  const toggle = $('git-toggle')
  const box = $('git-auto')
  const hint = $('git-hint')
  if (!toggle || !box || !hint) return
  toggle.hidden = gitState.repo !== true
  box.checked = gitState.autoCommit === true
  hint.textContent = gitState.repo === true ? '' : '（工作区不是 git 仓库）'
}`
  const to = `function renderGit() {
  const toggle = $('git-toggle')
  const box = $('git-auto')
  const hint = $('git-hint')
  if (!toggle || !box || !hint) return
  // 没仓库也照常显示开关：打开后第一次提交会自动 git init
  toggle.hidden = false
  box.checked = gitState.autoCommit === true
  hint.textContent =
    gitState.repo === true
      ? ''
      : gitState.autoCommit === true
        ? '（不是 git 仓库：下次提交会自动 git init）'
        : '（不是 git 仓库，开启后会自动建一个）'
}`
  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('chat.js：开关不再隐藏，并说明会自动 init')
  } else {
    console.log('⚠ renderGit 锚点未匹配')
  }
}

// 2) 测试：不是仓库时自动 init 并提交
{
  const path = 'test/git.test.ts'
  let code = readFileSync(path, 'utf8')

  const from = `test('git：不是仓库时不报错，只是跳过', async () => {
  const dir = tempWorkspace('git-norepo')
  try {
    assert.equal(await isGitRepo(dir), false)
    const result = await commitPaths(dir, ['a.txt'], 'qzcode: test')
    assert.equal(result.ok, true)
    assert.equal(result.repo, false)
    assert.match(result.skipped ?? '', /不是 git 仓库/)
  } finally {
    removeDir(dir)
  }
})`

  const to = `test('git：不是仓库时先 git init 再提交（不然开关等于没用）', async () => {
  const dir = tempWorkspace('git-norepo')
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello\\n', 'utf8')
    assert.equal(await isGitRepo(dir), false, '起始状态不该是仓库')

    const result = await commitPaths(dir, ['a.txt'], 'qzcode: 第一次提交')
    assert.equal(result.ok, true, result.error)
    assert.equal(result.repo, true, '提交完后就是仓库了')
    assert.equal(result.initialized, true, '要标记出"这次新建了仓库"')
    assert.ok(result.commit, '应该有提交号')
    assert.equal(await isGitRepo(dir), true)

    // 第二次提交就不该再 init
    writeFileSync(join(dir, 'a.txt'), 'hello again\\n', 'utf8')
    const again = await commitPaths(dir, ['a.txt'], 'qzcode: 第二次')
    assert.equal(again.ok, true, again.error)
    assert.equal(again.initialized, false, '第二次不该再 init')
    assert.ok(again.commit)
  } finally {
    removeDir(dir)
  }
})`

  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('git.test：改成"自动 init"用例')
  } else {
    console.log('⚠ 旧用例锚点未匹配')
  }
}
