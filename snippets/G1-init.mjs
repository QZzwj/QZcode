import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/git.ts'
let code = readFileSync(path, 'utf8')
const done = []

// 1) 不是仓库就 git init（用户明确要求：没有仓库就先建一个）
{
  const from = `  if (paths.length === 0) return { ok: true, repo: true, skipped: '这次没有改动文件' }
  if (!(await isGitRepo(workspace))) return { ok: true, repo: false, skipped: '工作区不是 git 仓库' }`
  const to = `  if (paths.length === 0) return { ok: true, repo: true, skipped: '这次没有改动文件' }

  // 不是仓库就先 git init：不建仓库的话自动提交永远是一句"没有提交"，
  // 这个开关就等于没用。
  let initialized = false
  if (!(await isGitRepo(workspace))) {
    const init = await git(workspace, ['init'])
    if (!init.ok) {
      return { ok: false, repo: false, error: \`git init 失败：\${init.stderr || init.stdout}\` }
    }
    initialized = true
  }`
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('不是仓库时 git init')
  } else {
    console.log('⚠ commitPaths 头锚点未匹配')
  }

  // 2) 提交时兜住"没配 user.name/email"的环境（只对这次命令生效，不改用户配置）
  const from2 = `  const commit = await git(workspace, ['commit', '-m', message, '--no-verify'])
  if (!commit.ok) {
    return { ok: false, repo: true, error: \`git commit 失败：\${commit.stderr || commit.stdout}\` }
  }`
  const to2 = `  const commit = await git(workspace, ['commit', '-m', message, '--no-verify'])
  if (!commit.ok && /empty ident name|tell me who you are|unable to auto-detect email/i.test(commit.stderr + commit.stdout)) {
    // 机器上没配 git 身份：只给这一条命令临时补一个，不写进用户的 git 配置
    const retried = await git(workspace, [
      '-c', 'user.name=QZcode',
      '-c', 'user.email=qzcode@local',
      'commit', '-m', message, '--no-verify',
    ])
    if (retried.ok) {
      const head = await git(workspace, ['rev-parse', '--short', 'HEAD'])
      return { ok: true, repo: true, initialized, commit: head.ok ? head.stdout : undefined }
    }
    return { ok: false, repo: true, error: \`git commit 失败：\${retried.stderr || retried.stdout}\` }
  }
  if (!commit.ok) {
    return { ok: false, repo: true, error: \`git commit 失败：\${commit.stderr || commit.stdout}\` }
  }`
  if (code.includes(from2)) {
    code = code.replace(from2, to2)
    done.push('兜住未配置 git 身份')
  } else {
    console.log('⚠ commit 锚点未匹配')
  }

  // 3) 返回值带上 initialized，界面能说清"新建了仓库"
  code = code.replace(
    `  const head = await git(workspace, ['rev-parse', '--short', 'HEAD'])
  return { ok: true, repo: true, commit: head.ok ? head.stdout : undefined }`,
    `  const head = await git(workspace, ['rev-parse', '--short', 'HEAD'])
  return { ok: true, repo: true, initialized, commit: head.ok ? head.stdout : undefined }`,
  )
  code = code.replace(
    `export interface GitResult {
  ok: boolean
  /** 是否是 git 仓库（不是就什么都不做，不报错）。 */
  repo: boolean
  commit?: string`,
    `export interface GitResult {
  ok: boolean
  /** 提交之后一定是仓库了（不是的话这次会先 git init）。 */
  repo: boolean
  /** 这次是不是新建的仓库。 */
  initialized?: boolean
  commit?: string`,
  )

  writeFileSync(path, code, 'utf8')
}

// 4) 侧栏提示：说清是"新建了仓库并提交"
{
  const path = 'src/web/server.ts'
  let code = readFileSync(path, 'utf8')
  const from = `            if (committed.commit) {
              push(run, { t: 'note', level: 'info', message: \`已提交 git：\${committed.commit}\` })`
  const to = `            if (committed.commit) {
              push(run, {
                t: 'note',
                level: 'info',
                message: committed.initialized
                  ? \`已新建 git 仓库并提交：\${committed.commit}\`
                  : \`已提交 git：\${committed.commit}\`,
              })`
  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    done.push('提示区分新建/已有仓库')
  }
}

console.log('git.ts / server.ts:', done.join(' / '))
