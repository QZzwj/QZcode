import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPreviewPage, vscodeStub } from '../scripts/preview-page.mjs'

/** 拿你真实的账本喂给成本页，看它是不是渲染时抛错。 */

// 1) 用真实配置起后端（只读 /api/cost，不会写你的配置）
const userConfig = join(process.env.APPDATA ?? '', 'Code', 'User', 'globalStorage', 'qzcode.qzcode', 'qzcode.json')
const ledger = join(process.env.APPDATA ?? '', 'Code', 'User', 'globalStorage', 'qzcode.qzcode', '.qzcode', 'cost.json')
console.log('账本存在:', existsSync(ledger), existsSync(ledger) ? readFileSync(ledger, 'utf8').length + ' 字节' : '')

const dir = join(tmpdir(), 'qz-cost-real-' + Date.now())
mkdirSync(dir, { recursive: true })
const out = join(dir, 'o.log')
const child = spawn(
  process.execPath,
  ['D:/hhd/pi/vscode/backend/dist/cli.js', 'web', '--no-open', '--port', '0', '--workspace', dir, '--config', userConfig],
  { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
)
let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
})
let url = null
for (let i = 0; i < 100 && !url; i++) {
  await new Promise((r) => setTimeout(r, 150))
  const m = buffer.match(/qzcode GUI:\s*(\S+)/)
  if (m) url = m[1].replace(/\/+$/, '')
}
if (!url) {
  console.log('后端没起来')
  child.kill()
  process.exit(1)
}
const payload = await (await fetch(url + '/api/cost')).json()
console.log('真实载荷: runs=' + payload.runs, '| steps=' + (payload.steps ?? []).length, '| recent=' + (payload.recent ?? []).length, '| today=' + payload.today)
child.kill()

// 2) 把这份载荷喂给成本页，抓渲染错误
const page = buildPreviewPage({
  kind: 'settings',
  name: 'cost-real',
  stub: vscodeStub({
    init: { providers: { providers: [], current: { provider: 'hhd', model: 'x', mock: false } } },
    events: [],
    onReady: `
      window.__ERRORS__ = [];
      window.addEventListener('error', (e) => window.__ERRORS__.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__ERRORS__.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));
      setTimeout(() => {
        document.querySelector('[data-tab="cost"]').click();
      }, 250);
    `,
  }),
})

const chrome = [
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((item) => existsSync(item))
const port = 9497
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), 'qz-cost-' + Date.now())}`,
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
await sleep(1200)

// 直接把真实载荷塞进页面
await evaluate(`window.postMessage({ type: 'cost', data: ${JSON.stringify(payload)} }, '*')`)
await sleep(800)

const state = await evaluate(`(() => {
  const section = document.getElementById('tab-cost');
  const summary = document.getElementById('cost-summary');
  return {
    errors: window.__ERRORS__ ?? [],
    costVisible: section ? !section.hidden : null,
    summaryText: summary ? summary.textContent.slice(0, 160) : '(空)',
    rows: document.querySelectorAll('.cost-card, .step-table').length,
  };
})()`)
console.log('成本页可见:', state.costVisible, '| 渲染块数:', state.rows)
console.log('内容:', state.summaryText)
console.log('页面错误:', state.errors.length ? state.errors : '(无)')

writeFileSync(join(tmpdir(), 'qz-ui-shots', 'cost-real.png'), '')
socket.close()
browser.kill()
process.exit(0)
