import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPreviewPage } from '../scripts/preview-page.mjs'

/**
 * 断线恢复验收：
 *  场景 A —— 流断了但后端还认得这次运行 → 补事件、正常收尾
 *  场景 B —— 后端重启过、运行没了 → 明确报错 + 给"重新发送 / 重启后端"
 */

const SHOTS = join(tmpdir(), 'qz-ui-shots')
mkdirSync(SHOTS, { recursive: true })

const fullEvents = [
  { t: 'route', decision: { route: 'pipeline', why: '要写文件' } },
  { t: 'phase', phase: 'plan', round: 1 },
  { t: 'text', pane: 'planner', delta: '## 任务\n做个倒计时。' },
  { t: 'text_end', pane: 'planner' },
  { t: 'phase', phase: 'implement', round: 1 },
  { t: 'text', pane: 'implementer', delta: '写好了。' },
  { t: 'text_end', pane: 'implementer' },
  { t: 'tool', pane: 'implementer', stage: 'end', name: 'write', ok: true, ms: 96 },
  { t: 'patch', pane: 'implementer', path: 'index.html', status: 'created', added: 30, removed: 0, diff: '+<html>' },
  { t: 'phase', phase: 'verify', round: 1 },
  { t: 'verdict', verdict: { pass: true } },
  { t: 'done', result: { ok: true, rounds: 1, elapsedMs: 9000, usage: { total: 3000 } }, touched: 1 },
  { t: 'run_end', status: 'passed' },
]

function stub({ dropAfter, snapshot }) {
  return `
    window.__QZ_EVENTS__ = ${JSON.stringify(fullEvents)};
    window.__QZ_DROP_AFTER__ = ${dropAfter};
    window.__QZ_SNAPSHOT__ = ${JSON.stringify(snapshot)};
    window.__QZ_READY__ = function () {};

    window.__ES_COUNT__ = 0;
    window.__DBG__ = [];
    class FakeEventSource {
      constructor(url) {
        window.__ES_COUNT__ += 1;
        window.__DBG__.push('ES#' + window.__ES_COUNT__ + ' ' + String(url).split('?')[1]);
        const list = window.__QZ_EVENTS__;
        let index = 0;
        const limit = window.__QZ_DROP_AFTER__;
        const tick = () => {
          if (index >= limit) {
            // 模拟断线
            if (this.onerror) this.onerror({});
            return;
          }
          if (this.onmessage) this.onmessage({ data: JSON.stringify(list[index++]) });
          window.__QZ_TIMER__ = setTimeout(tick, 60);
        };
        window.__QZ_TIMER__ = setTimeout(tick, 80);
      }
      close() { clearTimeout(window.__QZ_TIMER__); }
    }
    window.EventSource = FakeEventSource;

    window.fetch = async (url) => {
      window.__DBG__.push('fetch ' + String(url).slice(-40));
      if (String(url).includes('/api/run?id=')) {
        const snap = window.__QZ_SNAPSHOT__;
        if (!snap) return { ok: false, status: 404, json: async () => ({ error: '没有这个运行' }) };
        return { ok: true, status: 200, json: async () => snap };
      }
      return { ok: true, status: 200, json: async () => ({ runId: 'preview' }) };
    };

    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        if (message.type !== 'ready') return;
        setTimeout(() => {
          window.postMessage({ type: 'init', url: 'http://127.0.0.1:60608', providers: { providers: [], current: { provider: 'gatewaya', model: 'x', mock: false } } }, '*');
          window.__QZ_READY__();
        }, 60);
      },
    });
  `
}

const chrome = [
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((item) => existsSync(item))

async function runCase(name, { dropAfter, snapshot, waitMs = 4000 }) {
  const page = buildPreviewPage({ kind: 'chat', name, stub: stub({ dropAfter, snapshot }) })
  const port = 9500 + Math.floor(Math.random() * 200)
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(tmpdir(), `qz-rc-${name}-${Date.now()}`)}`,
    '--window-size=420,900', page,
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
  const failures2 = []
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data)
    if (data.method === 'Runtime.exceptionThrown') {
      failures2.push('EXC: ' + (data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text))
    }
    if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      failures2.push('ERR: ' + data.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })
  await sleep(300)
  // 发一条消息触发整轮
  await evaluate(`document.getElementById('input').value = '做个倒计时'; document.getElementById('send').click();`)
  await sleep(waitMs)

  const state = await evaluate(`(() => ({
    status: (document.getElementById('status').textContent || '').trim(),
    statusClass: document.getElementById('status').className,
    recover: Boolean(document.getElementById('recover-hint')),
    recoverText: (document.getElementById('recover-hint') || {}).textContent || '',
    doneTags: [...document.querySelectorAll('.tag')].map((n) => n.textContent.trim()),
    eventSources: window.__ES_COUNT__,
    dbg: window.__DBG__,
    thinking: Boolean(document.getElementById('thinking')),
  }))()`)

  state.errors = failures2.slice(0, 5)
  socket.close()
  browser.kill()
  return state
}

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' · ' + detail : ''}`)
}

// 场景 A：后端还认得，补完后正常收尾
const a = await runCase('recover-ok', {
  dropAfter: 4,
  snapshot: { status: 'passed', events: fullEvents },
})
check('断线后能续上并正常收尾', !/重试中|重连/.test(a.status) && /完成/.test(a.status), JSON.stringify(a.status))
check('断线恢复后没有残留的"正在思考中"', a.thinking === false)
check('补发的事件里带上了通过标记', a.doneTags.some((tag) => /通过/.test(tag)), JSON.stringify(a.doneTags))
if (a.errors.length) console.log('  页面异常:', a.errors)
console.log('  A 轨迹:', JSON.stringify(a.dbg))
console.log('  A 状态原文:', JSON.stringify(a.status))

// 场景 B：后端重启过，运行没了
const b = await runCase('recover-lost', { dropAfter: 3, snapshot: null, waitMs: 6000 })
check('运行丢了以后不会一直挂着"重试中"', !/重试中…$/.test(b.status), JSON.stringify(b.status))
check('给出原因和出口（重新发送 / 重启后端）', b.recover === true && /重新发送/.test(b.recoverText), JSON.stringify(b.recoverText.slice(0, 60)))

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 条失败'}`)
process.exit(failures === 0 ? 0 : 1)
