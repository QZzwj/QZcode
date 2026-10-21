import { readFileSync, writeFileSync } from 'node:fs'

// 1) 保存按钮加超时兜底：绝不能永远停在"保存中…"
{
  const path = 'vscode/media/settings.js'
  let code = readFileSync(path, 'utf8')

  const from = `  save.addEventListener('click', () => {
    vscode.postMessage({
      type: 'saveVision',
      enabled: enabled.checked,
      model: model.value.trim(),
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      maxImages: Number(maxImages.value || 0),
      question: question.value.trim(),
    })
    status.className = 'vision-status'
    status.textContent = '保存中…'
  })`

  const to = `  let saveTimer = null

  save.addEventListener('click', () => {
    vscode.postMessage({
      type: 'saveVision',
      enabled: enabled.checked,
      model: model.value.trim(),
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      maxImages: Number(maxImages.value || 0),
      question: question.value.trim(),
    })
    status.className = 'vision-status'
    status.textContent = '保存中…'

    // 兜底：后端/扩展一旦没回消息，8 秒后必须给个说法，不能一直转
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      status.className = 'vision-status err'
      status.textContent = '保存超时：后端没回应，再点一次保存'
    }, 8000)
  })

  // 收到结果就清掉超时
  window.__clearVisionTimer__ = () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }`

  if (code.includes(from)) {
    code = code.replace(from, to)
    console.log('settings.js：保存按钮加 8 秒超时兜底')
  } else {
    console.log('⚠ 保存按钮锚点未匹配')
  }

  // 结果分支里清定时器，并把值同步回本地状态
  const resFrom = `  if (message.type === 'visionSaved') {
    const status = document.getElementById('vision-status')`
  const resTo = `  if (message.type === 'visionSaved') {
    if (window.__clearVisionTimer__) window.__clearVisionTimer__()
    if (message.result && message.result.vision) state.vision = message.result.vision
    const status = document.getElementById('vision-status')`
  if (code.includes(resFrom)) {
    code = code.replace(resFrom, resTo)
    console.log('settings.js：结果回来时清定时器')
  }

  writeFileSync(path, code, 'utf8')
}

// 2) 单测：saveVision 必须在"设置面板"的处理器里，而不是聊天面板
{
  const path = 'test/vscode.test.ts'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('saveVision 必须在设置面板的处理器里')) {
    code += `
test('saveVision 必须在设置面板的处理器里（放错面板会让按钮永远"保存中…"）', () => {
  const ext = readFileSync(join(repoRoot, 'vscode', 'extension.cjs'), 'utf8')
  const panelStart = ext.indexOf('panel.webview.onDidReceiveMessage')
  assert.ok(panelStart > 0, '要能找到设置面板的消息处理器')

  const chatSection = ext.slice(0, panelStart)
  const panelSection = ext.slice(panelStart)

  assert.ok(!chatSection.includes("message.type === 'saveVision'"), '聊天面板不该处理视觉设置')
  assert.match(panelSection, /message\\.type === 'saveVision'/, '设置面板要处理视觉设置')
  // 回应必须发回 panel，不能发回侧栏的 view
  const handlerBlock = panelSection.slice(
    panelSection.indexOf("message.type === 'saveVision'"),
    panelSection.indexOf("message.type === 'saveVision'") + 900,
  )
  assert.match(handlerBlock, /panel\\.webview\\.postMessage/, '结果要回到设置面板')
  assert.doesNotMatch(handlerBlock, /this\\.view\\.webview\\.postMessage/, '不能把结果发到侧栏')
})
`
    writeFileSync(path, code, 'utf8')
    console.log('vscode.test：加 saveVision 面板归属断言')
  }
}
