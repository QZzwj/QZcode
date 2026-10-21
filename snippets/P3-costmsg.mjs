import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/media/settings.js'
let code = readFileSync(path, 'utf8')

const from = `  if (message.type === 'cost') {
    costData = message.data ?? null
    renderCost()
    return
  }`
const to = `  if (message.type === 'cost') {
    if (costTimer) {
      clearTimeout(costTimer)
      costTimer = null
    }
    const box = $('cost-summary')
    if (message.error) {
      if (box) {
        box.replaceChildren()
        const line = el('div', 'dim', '成本读不出来：' + message.error)
        const retry = el('button', 'link', '重试')
        retry.type = 'button'
        retry.addEventListener('click', () => loadCost())
        box.append(line, retry)
      }
      return
    }
    costData = message.data ?? null
    renderCost()
    return
  }`

if (code.includes(from)) {
  code = code.replace(from, to)
  writeFileSync(path, code, 'utf8')
  console.log('settings.js：cost 消息处理补上错误分支')
} else {
  console.log('⚠ 还是没匹配上')
}
