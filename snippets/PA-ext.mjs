import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/extension.cjs'
let code = readFileSync(path, 'utf8')
const done = []

// 侧栏新增消息：继续执行（用上一轮的任务书起一轮真活）
if (!code.includes("message.type === 'continuePlan'")) {
  const anchor = `      if (message.type === 'reloadCost') {`
  if (!code.includes(anchor)) throw new Error('聊天面板锚点变了')
  // 这个分支属于聊天面板（view），插在 ready 之前
  const chatAnchor = `      if (message.type === 'ready') await this.push()`
  if (!code.includes(chatAnchor)) throw new Error('ready 锚点没找到')
  code = code.replace(
    chatAnchor,
    `      if (message.type === 'continuePlan') {
        try {
          await ensureServer()
          const result = await api('/api/continue', { runId: message.runId })
          this.view.webview.postMessage({ type: 'continued', result })
          output().appendLine(\`[plan] 继续执行 → \${result.runId ?? 'FAIL'}\`)
        } catch (error) {
          this.view.webview.postMessage({
            type: 'continued',
            result: { ok: false, error: String(error.message ?? error) },
          })
        }
        return
      }
      if (message.type === 'ready') await this.push()`,
  )
  done.push('continuePlan 分支')
}

// 运行中的标记：切工作区要拦一下
if (!code.includes('runtime.hasRunning')) {
  const anchor = `let cliPathCache = null`
  code = code.replace(
    anchor,
    `let cliPathCache = null

/** 后端有没有正在跑的运行（切工作区时用来判断要不要拦一下）。 */
async function hasRunningRun() {
  try {
    const list = await api('/api/runs').catch(() => null)
    const runs = Array.isArray(list?.runs) ? list.runs : []
    return runs.some((run) => run.status === 'running')
  } catch {
    return false
  }
}`,
  )
  done.push('hasRunningRun')
}

writeFileSync(path, code, 'utf8')
console.log('extension.cjs:', done.join(' / ') || '(无改动)')
