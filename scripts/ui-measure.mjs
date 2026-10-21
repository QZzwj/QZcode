import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPreviewPage, vscodeStub } from '../scripts/preview-page.mjs'

/** 量一下新布局有没有挤、有没有压字（我看不了截图，只能量）。 */

const SHOTS = join(tmpdir(), 'qz-ui-shots')
mkdirSync(SHOTS, { recursive: true })

const events = [
  { t: 'route', decision: { route: 'pipeline', why: '要改动代码' } },
  { t: 'phase', phase: 'plan', round: 1 },
  { t: 'text', pane: 'planner', delta: '## 任务\n做一个跳一跳小游戏。\n\n**验收**\n1. 单文件\n2. 能蓄力\n3. 落台计分' },
  { t: 'text_end', pane: 'planner' },
  { t: 'phase', phase: 'implement', round: 1 },
  { t: 'text', pane: 'implementer', delta: '先看目录再写文件。' },
  { t: 'text_end', pane: 'implementer' },
  { t: 'tool', pane: 'implementer', stage: 'start', name: 'bash', args: '{"command":"ls -la"}' },
  { t: 'tool', pane: 'implementer', stage: 'end', name: 'bash', ok: true, ms: 247 },
  { t: 'patch', pane: 'implementer', path: 'index.html', status: 'modified', added: 5, removed: 1,
    diff: '--- a\n+++ b\n@@ x @@\n-const A = 60;\n+const A = 45;' },
  { t: 'phase', phase: 'verify', round: 1 },
  { t: 'verdict', verdict: { pass: true } },
  { t: 'done', result: { ok: true, rounds: 1, elapsedMs: 18400, usage: { total: 6997 } }, touched: 1 },
  { t: 'run_end', status: 'passed' },
]

const PAGE = buildPreviewPage({
  kind: 'chat',
  name: 'layout',
  stub: vscodeStub({
    init: {
      providers: { providers: [], current: { provider: 'gatewaya', model: 'deepseek-chat', mock: false } },
      workspace: 'D:\\gatewaya\\demo\\qzcodetest',
    },
    events,
    onReady: "document.getElementById('input').value = '帮我制作一个跳一跳的 HTML 小游戏'; document.getElementById('send').click();",
  }),
})

const chrome = [
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((item) => existsSync(item))

const port = 9491
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), `qz-layout-${Date.now()}`)}`,
  '--window-size=420,900', PAGE,
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
await new Promise((resolve, reject) => {
  socket.addEventListener('open', () => resolve())
  socket.addEventListener('error', () => reject(new Error('ws 失败')))
})
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data)
  const entry = pending.get(data.id)
  if (!entry) return
  pending.delete(data.id)
  if (data.error) entry.reject(new Error(data.error.message))
  else entry.resolve(data.result)
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

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(2600)

const metrics = await evaluate(`(() => {
  const lanes = [...document.querySelectorAll('.lane')].map((lane) => {
    const rect = lane.getBoundingClientRect()
    const letter = lane.querySelector('.lane-letter').getBoundingClientRect()
    const name = lane.querySelector('.lane-name').getBoundingClientRect()
    const split = lane.querySelector('.lane-split').getBoundingClientRect()
    const baton = document.getElementById('baton').getBoundingClientRect()
    const overlapsBaton = (r) => !(r.right <= baton.left || r.left >= baton.right || r.bottom <= baton.top || r.top >= baton.bottom)
    return {
      role: lane.dataset.role,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      contentH: lane.scrollHeight,
      overflowY: lane.scrollHeight > lane.clientHeight + 1,
      overflowX: lane.scrollWidth > lane.clientWidth + 1,
      nameOverflow: name.scrollWidth > name.clientWidth + 1 || name.height > 14,
      hitsBaton: overlapsBaton(letter) || overlapsBaton(name) || overlapsBaton(split),
    }
  })
  const head = document.querySelector('.board-head').getBoundingClientRect()
  const thread = document.getElementById('thread').getBoundingClientRect()
  const composer = document.querySelector('.composer').getBoundingClientRect()
  return {
    lanes,
    railWidth: Math.round(document.querySelector('.lanes').getBoundingClientRect().width),
    batonVisible: document.getElementById('baton').classList.contains('on'),
    headOverflow: document.querySelector('.board-head').scrollWidth > document.querySelector('.board-head').clientWidth + 1,
    threadW: Math.round(thread.width),
    bodyFitsViewport: Math.round(composer.bottom) <= window.innerHeight + 1,
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    workspace: document.getElementById('workspace').textContent,
    status: document.getElementById('status').textContent,
  }
})()`)

console.log('车道宽:', metrics.railWidth, '| 会话宽:', metrics.threadW, '| 工作区:', metrics.workspace)
for (const lane of metrics.lanes) console.log('  lane', lane.role.padEnd(12), JSON.stringify(lane))
console.log('棒可见:', metrics.batonVisible, '| 顶栏溢出:', metrics.headOverflow, '| 收尾贴底:', metrics.bodyFitsViewport, '| 横向溢出:', metrics.docOverflowX)
console.log('状态行:', metrics.status)

const problems = metrics.lanes.filter((lane) => lane.overflowY || lane.overflowX || lane.nameOverflow || lane.hitsBaton)
console.log(problems.length === 0 ? '✔ 车道无挤压、无压字' : '✘ 有问题: ' + JSON.stringify(problems))

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(SHOTS, 'chat-v3-420.png'), Buffer.from(shot.data, 'base64'))

await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(400)
const wide = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(SHOTS, 'chat-v3-700.png'), Buffer.from(wide.data, 'base64'))
console.log('截图:', SHOTS)

socket.close()
child.kill()
process.exit(0)
