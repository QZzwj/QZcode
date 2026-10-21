import { readFileSync, writeFileSync } from 'node:fs'

// 1) 预览桩：支持延后回放事件，好让"还没回复"的那一小段可以被测到
{
  const path = 'scripts/preview-page.mjs'
  let code = readFileSync(path, 'utf8')
  const from = `export function vscodeStub({ events = [], init = {}, onReady = '' } = {}) {
  return \`
    window.__QZ_EVENTS__ = \${JSON.stringify(events)};`
  const to = `export function vscodeStub({ events = [], init = {}, onReady = '', startDelayMs = 120 } = {}) {
  return \`
    window.__QZ_START_DELAY__ = \${Number(startDelayMs) || 0};
    window.__QZ_EVENTS__ = \${JSON.stringify(events)};`
  if (code.includes(from)) {
    code = code.replace(from, to)
    code = code.replace('window.__QZ_TIMER__ = setTimeout(tick, 120);', 'window.__QZ_TIMER__ = setTimeout(tick, window.__QZ_START_DELAY__ ?? 120);')
    writeFileSync(path, code, 'utf8')
    console.log('preview-page.mjs：支持 startDelayMs')
  } else {
    console.log('⚠ vscodeStub 锚点未匹配')
  }
}

// 2) chat.js：发出消息后先挂一个"正在思考中"，收到第一条事件就摘掉
{
  const path = 'vscode/media/chat.js'
  let code = readFileSync(path, 'utf8')

  if (!code.includes('function showThinking')) {
    const anchor = 'function addUser(text) {'
    const helper = `/* ---------------------------------------------------------- 等待反馈
   消息发出去到模型吐第一个字之间有一段空档（几百毫秒到几秒）。
   这段时间给一条"正在思考中"，人就知道不是卡死了。 */

function showThinking() {
  hideThinking()
  const row = el('div', 'msg agent thinking')
  row.id = 'thinking'
  const head = el('div', 'head')
  head.append(el('span', 'badge', '·'), el('span', 'title', '正在思考中'))
  const dots = el('span', 'dots')
  dots.append(el('i'), el('i'), el('i'))
  head.append(dots)
  row.append(head)
  thread.append(row)
  scrollDown()
}

function hideThinking() {
  const node = document.getElementById('thinking')
  if (node) node.remove()
}

${anchor}`
    if (!code.includes(anchor)) throw new Error('addUser 锚点未匹配')
    code = code.replace(anchor, helper)
    console.log('chat.js：加了 showThinking / hideThinking')
  }

  // 发消息时显示
  const sendAnchor = `  addUser(goal)
  view.bubbles.clear()`
  if (code.includes(sendAnchor) && !code.includes('showThinking()\n  view.bubbles.clear()')) {
    code = code.replace(sendAnchor, `  addUser(goal)
  showThinking()
  view.bubbles.clear()`)
    console.log('chat.js：发送后显示"正在思考中"')
  }

  // 收到任何真实事件就摘掉
  const handleAnchor = `function handle(event) {
  switch (event.t) {`
  if (code.includes(handleAnchor)) {
    code = code.replace(
      handleAnchor,
      `function handle(event) {
  // 只要有真实进展，就不再是"还在想"了
  if (event.t !== 'run_start') hideThinking()
  switch (event.t) {`,
    )
    console.log('chat.js：收到事件即摘掉角标')
  }

  // 失败 / 结束 / 新任务也要确保摘掉
  code = code.replace(
    `    setBusy(false)
    setStatus(payload.error ?? '启动失败', 'err')`,
    `    setBusy(false)
    hideThinking()
    setStatus(payload.error ?? '启动失败', 'err')`,
  )
  code = code.replace(
    `    setBusy(false)
    setStatus(\`请求失败：\${error.message}\`, 'err')`,
    `    setBusy(false)
    hideThinking()
    setStatus(\`请求失败：\${error.message}\`, 'err')`,
  )
  code = code.replace(
    `    case 'run_end':`,
    `    case 'run_end':
      hideThinking()`,
  )
  code = code.replace(
    `function newTask() {
  closeSource()`,
    `function newTask() {
  closeSource()
  hideThinking()`,
  )

  writeFileSync(path, code, 'utf8')
}
