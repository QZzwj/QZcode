import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/media/chat.js'
let code = readFileSync(path, 'utf8')

// 后端明确说"没有这个运行"（404）= 它重启过、内存里没了 → 立刻给结论，不要重试 12 次
const from = `    let snapshot = null
    try {
      const response = await fetch(\`\${view.base}/api/run?id=\${runId}\`)
      if (response.ok) snapshot = await response.json()
    } catch {
      snapshot = null
    }`
const to = `    let snapshot = null
    let missing = false
    try {
      const response = await fetch(\`\${view.base}/api/run?id=\${runId}\`)
      if (response.ok) snapshot = await response.json()
      else if (response.status === 404) missing = true
    } catch {
      snapshot = null
    }

    if (missing) {
      giveUp(\`后端重启过，这次运行的进度已经丢了（已完成的改动仍在工作区，记录见 .qzcode/run*.md）。\`)
      return
    }`

if (code.includes(from)) {
  code = code.replace(from, to)
  writeFileSync(path, code, 'utf8')
  console.log('chat.js：404 立刻给结论')
} else {
  console.log('⚠ snapshot 锚点未匹配')
}
