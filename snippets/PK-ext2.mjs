import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/extension.cjs'
let code = readFileSync(path, 'utf8')
const done = []

// 1) openRunLog 函数
if (!code.includes('async function openRunLog')) {
  const anchor = 'async function showRunDiff() {'
  if (!code.includes(anchor)) throw new Error('showRunDiff 锚点没找到')
  code = code.replace(
    anchor,
    `/** 打开某一轮的 .qzcode/runN.md（侧栏按钮和命令都走这里）。 */
async function openRunLog(pathArg) {
  const workspace = runtime.workspace || workspaceRoot()
  if (!workspace) {
    vscode.window.showWarningMessage('还没有工作区，找不到运行记录。')
    return
  }

  let target = typeof pathArg === 'string' && pathArg ? pathArg : ''
  if (!target) {
    const dir = path.join(workspace, '.qzcode')
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((name) => /^run\\d+\\.md$/.test(name))
          .sort((a, b) => Number(b.match(/\\d+/)[0]) - Number(a.match(/\\d+/)[0]))
      : []
    if (files.length === 0) {
      vscode.window.showInformationMessage('还没有运行记录：跑一次任务就会生成 .qzcode/run1.md。')
      return
    }
    const picked = await vscode.window.showQuickPick(
      files.map((name) => ({ label: name, description: path.join('.qzcode', name) })),
      { placeHolder: '看哪一轮的记录？' },
    )
    if (!picked) return
    target = path.join(dir, picked.label)
  }

  try {
    const document = await vscode.workspace.openTextDocument(target)
    await vscode.window.showTextDocument(document, { preview: true })
  } catch (error) {
    vscode.window.showWarningMessage(\`打不开记录文件：\${error.message}\`)
  }
}

${anchor}`,
  )
  done.push('openRunLog 函数')
}

// 2) 侧栏消息：openRunLog / rollbackFile
if (!code.includes("message.type === 'openRunLog'")) {
  const anchor = `      if (message.type === 'continuePlan') {`
  if (!code.includes(anchor)) throw new Error('continuePlan 锚点没找到')
  code = code.replace(
    anchor,
    `      if (message.type === 'openRunLog') {
        await openRunLog(message.path)
        return
      }
      if (message.type === 'rollbackFile') {
        try {
          await ensureServer()
          const runId = String(message.runId ?? '')
          const list = await api(\`/api/snapshot\${runId ? \`?id=\${encodeURIComponent(runId)}\` : ''}\`)
          const entries = Array.isArray(list.entries) ? list.entries : []
          if (entries.length === 0) {
            vscode.window.showInformationMessage('这次运行没有改动文件，没得回滚。')
            return
          }
          const picked = await vscode.window.showQuickPick(
            entries.map((entry) => ({
              label: entry.path,
              description: entry.status === 'created' ? '新建（回滚会删掉）' : '修改（回滚会还原）',
            })),
            { placeHolder: '回滚哪个文件？可多选', canPickMany: true },
          )
          if (!picked || picked.length === 0) return
          const result = await api('/api/rollback', {
            runId: list.runId,
            paths: picked.map((item) => item.label),
          })
          const restored = (result.restored ?? []).length
          const deleted = (result.deleted ?? []).length
          vscode.window.showInformationMessage(
            \`已回滚 \${restored} 个文件\${deleted > 0 ? \`，删掉新增 \${deleted} 个\` : ''}\`,
          )
        } catch (error) {
          vscode.window.showWarningMessage(\`按文件回滚失败：\${error.message}\`)
        }
        return
      }
${anchor}`,
  )
  done.push('openRunLog / rollbackFile 消息')
}

writeFileSync(path, code, 'utf8')
console.log('extension.cjs:', done.join(' / ') || '(无改动)')
