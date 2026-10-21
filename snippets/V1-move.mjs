import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/extension.cjs'
let code = readFileSync(path, 'utf8')
const done = []

// 1) 从"侧栏聊天"的处理器里摘掉 saveVision（放错地方了）
const chatBlock = `      if (message.type === 'saveVision') {
        try {
          const result = await api('/api/vision', { ...message, type: undefined })
          this.view.webview.postMessage({ type: 'visionSaved', result })
          output().appendLine(\`[vision] 开关=\${message.enabled ? '开' : '关'} 模型=\${message.model || '(空)'}\`)
        } catch (error) {
          this.view.webview.postMessage({
            type: 'visionSaved',
            result: { ok: false, error: String(error.message) },
          })
        }
        return
      }
`
if (code.includes(chatBlock)) {
  code = code.replace(chatBlock, '')
  done.push('从聊天面板摘掉 saveVision')
}

// 2) 放到"设置面板"的处理器里（视觉设置是设置面板的按钮）
const anchor = `      if (message.type === 'reloadCost') {`
if (!code.includes("if (message.type === 'saveVision') {\n        // 视觉设置是设置面板里的按钮")) {
  if (!code.includes(anchor)) throw new Error('设置面板 reloadCost 锚点未匹配')
  const block = `      if (message.type === 'saveVision') {
        // 视觉设置是设置面板里的按钮，消息必须回到这个 panel 上，
        // 回到侧栏的 view 等于没回应（按钮会永远停在"保存中…"）
        try {
          await ensureServer()
          const result = await api('/api/vision', {
            enabled: message.enabled === true,
            model: message.model,
            baseUrl: message.baseUrl,
            apiKey: message.apiKey,
            maxImages: message.maxImages,
            question: message.question,
          })
          panel.webview.postMessage({ type: 'visionSaved', result })
          output().appendLine(
            \`[vision] 开关=\${message.enabled ? '开' : '关'} 模型=\${message.model || '(空)'} 已写入配置=\${result.saved === true}\`,
          )
        } catch (error) {
          output().appendLine(\`[vision] 保存失败: \${error.message}\`)
          panel.webview.postMessage({
            type: 'visionSaved',
            result: { ok: false, error: String(error.message ?? error) },
          })
        }
        return
      }
${anchor}`
  code = code.replace(anchor, block)
  done.push('挂到设置面板')
}

writeFileSync(path, code, 'utf8')
console.log('extension.cjs:', done.join(' / ') || '(无改动)')
