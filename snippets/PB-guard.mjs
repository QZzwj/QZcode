import { readFileSync, writeFileSync } from 'node:fs'

// 1) 后端：GET /api/runs（当前进程里的所有运行）
{
  const path = 'src/web/server.ts'
  let code = readFileSync(path, 'utf8')
  if (!code.includes("path === '/api/runs'")) {
    const anchor = `        if (request.method === 'GET' && path === '/api/run') {`
    if (!code.includes(anchor)) throw new Error('/api/run GET 锚点未匹配')
    code = code.replace(
      anchor,
      `        if (request.method === 'GET' && path === '/api/runs') {
          const list = [...runs.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 30)
            .map((item) => ({
              id: item.id,
              goal: item.goal,
              status: item.status,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            }))
          sendJson(response, 200, { ok: true, runs: list, running: list.filter((r) => r.status === 'running').length })
          return
        }

${anchor}`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('server.ts：加了 GET /api/runs')
  }
}

// 2) 扩展：切工作区时如果正在跑，先问一句
{
  const path = 'vscode/extension.cjs'
  let code = readFileSync(path, 'utf8')
  const from = `      const next = workspaceRoot()
      // 后端还没起来时不要"重启"（runtime.workspace 为空 = 首次启动中，
      // 以前这里会把它刚起好的进程杀掉再起一遍，加载时间直接翻倍）
      if (!next || !runtime.workspace || next === runtime.workspace) return`
  const to = `      const next = workspaceRoot()
      // 后端还没起来时不要"重启"（runtime.workspace 为空 = 首次启动中，
      // 以前这里会把它刚起好的进程杀掉再起一遍，加载时间直接翻倍）
      if (!next || !runtime.workspace || next === runtime.workspace) return

      // 正在跑任务时切工作区 = 后端被杀、这轮活白干：先问一句
      if (await hasRunningRun()) {
        const choice = await vscode.window.showWarningMessage(
          'QZcode 正在跑任务，切工作区会中断它。',
          { modal: true },
          '停止并切换',
          '等它跑完',
        )
        if (choice !== '停止并切换') {
          output().appendLine('[workspace] 用户选择先不切（有任务在跑）')
          return
        }
      }`
  if (code.includes(from) && !code.includes('正在跑任务，切工作区会中断它')) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('extension.cjs：切工作区前检查是否有任务在跑')
  } else {
    console.log('⚠ workspaceChanged 锚点未匹配')
  }
}
