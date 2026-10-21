import { readFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------- ③ 运行记录：done 带路径 + 命令
{
  const path = 'src/web/server.ts'
  let code = readFileSync(path, 'utf8')
  const done = []

  // RunState 记下记录文件
  if (!code.includes('runLogPath?: string')) {
    code = code.replace(
      `  /** 各步骤的模型耗时与输出 token（跑完填）。 */`,
      `  /** 这一轮的记录文件（<工作区>/.qzcode/runN.md）。 */
  runLogPath?: string
  runLogIndex?: number
  /** 各步骤的模型耗时与输出 token（跑完填）。 */`,
    )
    done.push('RunState.runLogPath')
  }

  // 写记录时把路径存到 run 上
  const from = `          if (logged.ok) {
            push(run, { t: 'note', level: 'info', message: \`本轮记录已写入 .qzcode/run\${logged.index}.md\` })`
  const to = `          if (logged.ok) {
            run.runLogPath = logged.path
            run.runLogIndex = logged.index
            push(run, { t: 'note', level: 'info', message: \`本轮记录已写入 .qzcode/run\${logged.index}.md\` })`
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('run 记下记录路径')
  }

  // GET /api/run 返回记录路径（界面用它开文件）
  const getFrom = `        status: run.status,`
  const getTo = `        status: run.status,
        runLogPath: run.runLogPath ?? null,
        runLogIndex: run.runLogIndex ?? null,`
  if (code.includes(getFrom) && !code.includes('runLogPath: run.runLogPath')) {
    code = code.replace(getFrom, getTo)
    done.push('/api/run 返回 runLogPath')
  }

  writeFileSync(path, code, 'utf8')
  console.log('server.ts:', done.join(' / ') || '(无改动)')
}
