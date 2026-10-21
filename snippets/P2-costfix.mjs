import { readFileSync, writeFileSync } from 'node:fs'

// 1) listRoles 漏了 catalog → 设置面板的供应商下拉是空的（我刚测出来的真 bug）
{
  const path = 'src/providers.ts'
  let code = readFileSync(path, 'utf8')
  const from = `    providers: listProviders(config).providers,
    configPath: config.path || null,`
  const to = `    providers: listProviders(config).providers,
    // 下拉用的供应商清单（缺了它设置面板里只剩当前这一家）
    catalog: listProviders(config).catalog,
    configPath: config.path || null,`
  if (code.includes(from) && !code.includes('catalog: listProviders')) {
    code = code.replace(from, to)
    // RolesState 类型也要有 catalog
    code = code.replace(
      `export interface RolesState {`,
      `export interface RolesState {
  /** 供应商下拉清单（只是选项，不代表已配置）。 */
  catalog?: unknown[]`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('providers.ts：listRoles 带上 catalog')
  } else {
    console.log(code.includes('catalog: listProviders') ? '已经有了' : '⚠ 锚点未匹配')
  }
}

// 2) 扩展：reloadCost / reloadSkills 必须"一定有回应"，不能把面板挂死
{
  const path = 'vscode/extension.cjs'
  let code = readFileSync(path, 'utf8')
  const from = `      if (message.type === 'reloadCost') {
        await ensureServer()
        const data = await api('/api/cost').catch(() => null)
        panel.webview.postMessage({ type: 'cost', data })
        return
      }`
  const to = `      if (message.type === 'reloadCost') {
        // 这里必须**永远**回一条消息：以前 ensureServer 一旦抛错，
        // 面板就停在"空白"，看起来就是"成本页打不开"。
        try {
          await ensureServer()
          const data = await api('/api/cost')
          panel.webview.postMessage({ type: 'cost', data })
        } catch (error) {
          output().appendLine(\`[cost] 读取失败: \${error.message}\`)
          panel.webview.postMessage({
            type: 'cost',
            data: null,
            error: String(error.message ?? error),
          })
        }
        return
      }`
  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('extension.cjs：reloadCost 兜住异常并一定回应')
  } else {
    console.log('⚠ reloadCost 锚点未匹配')
  }
}

// 3) 面板：加载中要有字，超时要能重试（不能让用户对着空白）
{
  const path = 'vscode/media/settings.js'
  let code = readFileSync(path, 'utf8')
  const from = `  if (name === 'cost') vscode.postMessage({ type: 'reloadCost' })`
  const to = `  if (name === 'cost') loadCost()`
  if (code.includes(from)) {
    code = code.replace(from, to)
  }

  if (!code.includes('function loadCost')) {
    const anchor = 'function renderCost() {'
    if (!code.includes(anchor)) throw new Error('renderCost 锚点未匹配')
    const helper = `/** 读成本：先显示"读取中"，超时给重试，绝不留给用户一块空白。 */
let costTimer = null

function loadCost() {
  const box = $('cost-summary')
  if (box) {
    box.replaceChildren(el('div', 'dim', '正在读取成本…'))
  }
  const body = $('cost-body')
  if (body) body.replaceChildren()

  vscode.postMessage({ type: 'reloadCost' })

  if (costTimer) clearTimeout(costTimer)
  costTimer = setTimeout(() => {
    const target = $('cost-summary')
    if (!target) return
    target.replaceChildren()
    const line = el('div', 'dim', '读取超时：后端没有回应。')
    const retry = el('button', 'link', '重试')
    retry.type = 'button'
    retry.addEventListener('click', () => loadCost())
    const restart = el('button', 'link', '重启后端')
    restart.type = 'button'
    restart.addEventListener('click', () => vscode.postMessage({ type: 'restartServer' }))
    target.append(line, retry, ' ', restart)
  }, 5000)
}

${anchor}`
    code = code.replace(anchor, helper)
    console.log('settings.js：加了 loadCost（加载中/超时/重试）')
  }

  // 收到消息：清掉超时；data 为空但有 error 就把原因写出来
  const costFrom = `  if (message.type === 'cost') {
    costData = message.data
    renderCost()
    return
  }`
  const costTo = `  if (message.type === 'cost') {
    if (costTimer) {
      clearTimeout(costTimer)
      costTimer = null
    }
    const box = $('cost-summary')
    if (message.error) {
      if (box) {
        box.replaceChildren()
        box.append(el('div', 'dim', '成本读不出来：' + message.error))
      }
      return
    }
    costData = message.data
    renderCost()
    return
  }`
  if (code.includes(costFrom)) {
    code = code.replace(costFrom, costTo)
    console.log('settings.js：cost 消息处理带上错误分支')
  } else {
    console.log('⚠ cost 消息锚点未匹配')
  }

  writeFileSync(path, code, 'utf8')
}
