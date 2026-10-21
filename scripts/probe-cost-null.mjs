import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPreviewPage, vscodeStub } from '../scripts/preview-page.mjs'

/** 成本页在"拿不到数据"时会不会炸？ */

const page = buildPreviewPage({
  kind: 'settings',
  name: 'cost-null',
  stub: vscodeStub({
    init: { providers: { providers: [], current: { provider: 'gatewaya', model: 'x', mock: false } } },
    events: [],
    onReady: `
      window.__ERRORS__ = [];
      window.addEventListener('error', (e) => window.__ERRORS__.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__ERRORS__.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
      setTimeout(() => {
        document.querySelector('[data-tab="cost"]').click();
        setTimeout(() => window.postMessage({ type: 'cost', data: null }, '*'), 120);
      }, 250);
    `,
  }),
})

const chrome = [
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((item) => existsSync(item))
const port = 9498
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), 'qz-costnull-' + Date.now())}`,
  '--window-size=900,900', page,
], { stdio: 'ignore', windowsHide: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let info = null
for (let i = 0; i < 80 && !info; i++) {
  await sleep(200)
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    info = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  } catch {}
}
const socket = new WebSocket(info.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data)
  const entry = pending.get(data.id)
  if (!entry) return
  pending.delete(data.id)
  data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result)
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'eval 失败')
  return result.result.value
}

await send('Runtime.enable')
await sleep(1600)
const state = await evaluate(`(() => ({
  errors: window.__ERRORS__ ?? [],
  costVisible: !document.getElementById('tab-cost').hidden,
  summary: document.getElementById('cost-summary').textContent.slice(0, 120),
}))()`)
console.log('成本页可见:', state.costVisible)
console.log('内容:', state.summary || '(空白)')
console.log('页面错误:', state.errors.length ? state.errors.slice(0, 3) : '(无)')
socket.close()
browser.kill()
process.exit(0)
