import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPreviewPage, vscodeStub } from '../scripts/preview-page.mjs'

/** 用真实的 /api/roles 载荷打开设置面板，看脚本有没有在初始化时抛错（抛了就点不动页签）。 */

const userConfig = join(process.env.APPDATA ?? '', 'Code', 'User', 'globalStorage', 'qzcode.qzcode', 'qzcode.json')
const dir = join(tmpdir(), 'qz-state-real-' + Date.now())
mkdirSync(dir, { recursive: true })
const child = spawn(
  process.execPath,
  ['D:/example/qzcode/vscode/backend/dist/cli.js', 'web', '--no-open', '--port', '0', '--workspace', dir, '--config', userConfig],
  { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
)
let buffer = ''
child.stdout.on('data', (c) => (buffer += c.toString()))
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
const state = await (await fetch(url + '/api/roles')).json()
const cost = await (await fetch(url + '/api/cost')).json()
const skills = await (await fetch(url + '/api/skills')).json()
child.kill()
console.log('真实 roles 载荷字段:', Object.keys(state).join(','))
console.log('vision:', JSON.stringify(state.vision)?.slice(0, 120))
console.log('catalog 条数:', (state.catalog ?? []).length, '| skills 条数:', (skills.catalog ?? skills.skills ?? []).length)

const page = buildPreviewPage({
  kind: 'settings',
  name: 'state-real',
  stub: vscodeStub({
    init: { providers: state.providers ?? { providers: [] } },
    events: [],
    onReady: `
      window.__ERRORS__ = [];
      window.addEventListener('error', (e) => window.__ERRORS__.push(String(e.message) + ' @' + e.lineno));
      window.addEventListener('unhandledrejection', (e) => window.__ERRORS__.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
      window.__STATE__ = ${JSON.stringify(state)};
      window.__COST__ = ${JSON.stringify(cost)};
      window.__SKILLS__ = ${JSON.stringify(skills)};
    `,
  }),
})

const chrome = [
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((item) => existsSync(item))
const port = 9499
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), 'qz-stater-' + Date.now())}`,
  '--window-size=1000,900', page,
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

// 按真实顺序喂数据：state → skills → cost
await evaluate(`window.postMessage({ type: 'state', state: window.__STATE__ }, '*')`)
await sleep(400)
await evaluate(`window.postMessage({ type: 'skills', catalog: (window.__SKILLS__.catalog || window.__SKILLS__.skills || []) }, '*')`)
await sleep(300)
await evaluate(`window.postMessage({ type: 'cost', data: window.__COST__ }, '*')`)
await sleep(400)

const before = await evaluate(`(() => ({
  errors: window.__ERRORS__ ?? [],
  tabs: [...document.querySelectorAll('.tab')].length,
  costHidden: document.getElementById('tab-cost').hidden,
}))()`)
console.log('喂完数据后 错误:', before.errors.length ? before.errors.slice(0, 4) : '(无)', '| 页签数:', before.tabs)

// 点"成本"
await evaluate(`document.querySelector('[data-tab="cost"]').click()`)
await sleep(500)
const after = await evaluate(`(() => ({
  costHidden: document.getElementById('tab-cost').hidden,
  modelsHidden: document.getElementById('tab-models').hidden,
  summary: document.getElementById('cost-summary').textContent.slice(0, 120),
  errors: window.__ERRORS__ ?? [],
}))()`)
console.log('点击成本后 → 成本可见:', after.costHidden === false, '| 模型隐藏:', after.modelsHidden === true)
console.log('成本内容:', after.summary || '(空白)')
console.log('错误:', after.errors.length ? after.errors.slice(0, 4) : '(无)')

socket.close()
browser.kill()
process.exit(0)
