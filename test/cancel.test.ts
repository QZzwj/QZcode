import test from 'node:test'
import assert from 'node:assert/strict'
import { execShell } from '../src/tools.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

/** 硬中断：abort 之后命令要立刻结束，不能把 30 秒的 sleep 跑完。 */

test('停止运行：abort 能立刻掐断正在跑的命令', async () => {
  const dir = tempWorkspace('cancel-shell')
  try {
    const controller = new AbortController()
    const started = Date.now()

    // 一条"正常要跑很久"的命令
    const promise = execShell('node -e "setTimeout(()=>{},30000)"', {
      cwd: dir,
      timeoutMs: 40_000,
      mode: 'pipe',
      signal: controller.signal,
    })

    // 200ms 后按停止
    setTimeout(() => controller.abort(), 200)
    const result = await promise
    const elapsed = Date.now() - started

    assert.equal(result.ok, false, '被取消的命令不该算成功')
    assert.match(result.output, /已取消|中断/, `输出要说清是被中断的：${result.output}`)
    assert.ok(elapsed < 5000, `应该几乎立刻返回，实际用了 ${elapsed}ms`)
  } finally {
    removeDir(dir)
  }
})

test('停止运行：信号已经 abort 时，命令根本不启动', async () => {
  const dir = tempWorkspace('cancel-shell-pre')
  try {
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const result = await execShell('node -e "setTimeout(()=>{},30000)"', {
      cwd: dir,
      timeoutMs: 40_000,
      mode: 'pipe',
      signal: controller.signal,
    })
    assert.equal(result.ok, false)
    assert.ok(Date.now() - started < 3000, '已经取消就不该再等')
  } finally {
    removeDir(dir)
  }
})

test('没有 signal 时行为不变（正常命令照常执行）', async () => {
  const dir = tempWorkspace('cancel-shell-normal')
  try {
    const result = await execShell('node -e "console.log(42)"', { cwd: dir, timeoutMs: 20_000, mode: 'pipe' })
    assert.equal(result.ok, true, result.output)
    assert.match(result.output, /42/)
  } finally {
    removeDir(dir)
  }
})
