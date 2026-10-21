import { readFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------- 后端：快照清单接口
{
  const path = 'src/web/server.ts'
  let code = readFileSync(path, 'utf8')
  if (!code.includes("path === '/api/snapshot'")) {
    const anchor = `        if (request.method === 'POST' && path === '/api/rollback') {`
    if (!code.includes(anchor)) throw new Error('rollback 锚点未匹配')
    code = code.replace(
      anchor,
      `        if (request.method === 'GET' && path === '/api/snapshot') {
          const id = url.searchParams.get('id') ?? ''
          const runId = id || listSnapshots(toolRuntime.workspace)[0]?.runId || ''
          const index = runId ? loadSnapshot(toolRuntime.workspace, runId) : null
          if (!index) {
            sendJson(response, 404, { ok: false, error: '没有可用的快照' })
            return
          }
          sendJson(response, 200, {
            ok: true,
            runId: index.runId,
            entries: index.entries.map((entry) => ({ path: entry.path, status: entry.status ?? 'modified' })),
          })
          return
        }

${anchor}`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('server.ts：GET /api/snapshot')
  }
}
