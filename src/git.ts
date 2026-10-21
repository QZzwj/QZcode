import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * git 集成：每一轮/每次运行结束自动提交"这次改过的文件"。
 *
 * 关键取舍：**只提交本次改动涉及的文件**（路径来自快照索引），
 * 不用 `git add -A`——否则会顺手把用户自己没提交的改动一起塞进提交里。
 */

export interface GitConfig {
  /** 每轮结束自动提交这次改过的文件。 */
  autoCommit: boolean
  /** 提交信息前缀。 */
  prefix: string
}

export const DEFAULT_GIT: GitConfig = { autoCommit: false, prefix: 'qzcode' }

export interface GitResult {
  ok: boolean
  /** 是否是 git 仓库（不是就什么都不做，不报错）。 */
  repo: boolean
  commit?: string
  error?: string
  skipped?: string
}

async function git(workspace: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('git', args, { cwd: workspace, windowsHide: true, timeout: 30_000 })
    return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() }
  } catch (error) {
    const wrapped = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: String(wrapped.stdout ?? '').trim(), stderr: String(wrapped.stderr ?? wrapped.message ?? '').trim() }
  }
}

/** 工作区是不是 git 仓库（往上找 .git 也算——用户在子目录里开会话时很正常）。 */
export async function isGitRepo(workspace: string): Promise<boolean> {
  if (!workspace || !existsSync(workspace)) return false
  const result = await git(workspace, ['rev-parse', '--is-inside-work-tree'])
  return result.ok && result.stdout === 'true'
}

/**
 * 提交指定路径。
 * @param paths 相对工作区的路径（来自快照索引，只含这次真改过的文件）
 */
export async function commitPaths(
  workspace: string,
  paths: string[],
  message: string,
): Promise<GitResult> {
  if (paths.length === 0) return { ok: true, repo: true, skipped: '这次没有改动文件' }
  if (!(await isGitRepo(workspace))) return { ok: true, repo: false, skipped: '工作区不是 git 仓库' }

  // 只暂存这次碰过的文件（已删除的用 -A 也只会 stage 这些路径）
  const staged = await git(workspace, ['add', '--', ...paths])
  if (!staged.ok) {
    return { ok: false, repo: true, error: `git add 失败：${staged.stderr || staged.stdout}` }
  }

  // 没有实际变更（比如内容和 HEAD 一样）就别造空提交
  const diff = await git(workspace, ['diff', '--cached', '--name-only'])
  if (diff.ok && diff.stdout === '') {
    return { ok: true, repo: true, skipped: '这些文件跟 HEAD 一致，不需要提交' }
  }

  const commit = await git(workspace, ['commit', '-m', message, '--no-verify'])
  if (!commit.ok) {
    return { ok: false, repo: true, error: `git commit 失败：${commit.stderr || commit.stdout}` }
  }
  const head = await git(workspace, ['rev-parse', '--short', 'HEAD'])
  return { ok: true, repo: true, commit: head.ok ? head.stdout : undefined }
}

/** 当前 HEAD（给界面显示"基于哪个提交"）。 */
export async function headShort(workspace: string): Promise<string | null> {
  const result = await git(workspace, ['rev-parse', '--short', 'HEAD'])
  return result.ok ? result.stdout : null
}

/** 这个路径集合里，有多少是被 git 跟踪的（用来判断能否 diff 到原生 diff 视图）。 */
export function gitDirOf(workspace: string): string {
  return join(workspace, '.git')
}
