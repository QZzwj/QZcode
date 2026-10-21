import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/media/chat.js'
let code = readFileSync(path, 'utf8')
const done = []

// 1) view 记下"已经收到多少条事件"，用来断线续传
code = code.replace(
  `const view = { base: '', source: null, runId: null, busy: false, round: 0, bubbles: new Map() }`,
  `const view = {
  base: '',
  source: null,
  runId: null,
  busy: false,
  round: 0,
  bubbles: new Map(),
  /** 已经收到多少条事件：断线重连时从这个下标继续（后端支持 ?since=） */
  eventCount: 0,
  /** 重连次数，用来退避和给用户看进度 */
  retries: 0,
  retryTimer: null,
}`,
)

// 2) 用带 since 的续传 + 指数退避 + 兜底轮询替换原来的空壳 onerror
const from = `function subscribe(runId) {
  closeSource()
  view.runId = runId
  const source = new EventSource(\`\${view.base}/api/events?id=\${runId}&since=0\`)
  view.source = source
  source.onmessage = (message) => {
    try {
      handle(JSON.parse(message.data))
    } catch {
      /* 忽略坏帧 */
    }
  }
  source.onerror = () => {
    if (view.runId) setStatus('连接中断，重试中…', 'err')
  }
}`

const to = `function subscribe(runId, since = 0) {
  closeSource()
  view.runId = runId
  if (since === 0) {
    view.eventCount = 0
    view.retries = 0
  }
  const source = new EventSource(\`\${view.base}/api/events?id=\${runId}&since=\${since}\`)
  view.source = source
  source.onmessage = (message) => {
    try {
      view.eventCount += 1
      handle(JSON.parse(message.data))
    } catch {
      /* 忽略坏帧 */
    }
  }
  source.onerror = () => {
    if (!view.runId) return
    closeSource()
    void recoverRun()
  }
}

/**
 * 断线恢复：先看后端这个运行还在不在。
 *   · 还在跑 → 从 eventCount 续上（不重放已经显示过的内容）
 *   · 已经跑完 → 把剩下的事件补完，按跑完处理
 *   · 查不到（后端重启过，内存里的运行没了）→ 明确告诉用户，别一直"重试中"
 */
async function recoverRun() {
  const runId = view.runId
  if (!runId) return

  view.retries += 1
  if (view.retryTimer) clearTimeout(view.retryTimer)

  // 前几次快速退避重连；次数多了改成慢一点
  const delay = Math.min(8000, 500 * 2 ** Math.min(view.retries - 1, 4))
  setStatus(\`连接中断，正在重连（第 \${view.retries} 次）…\`, 'err')

  view.retryTimer = setTimeout(async () => {
    view.retryTimer = null
    if (!view.runId) return

    let snapshot = null
    try {
      const response = await fetch(\`\${view.base}/api/run?id=\${runId}\`)
      if (response.ok) snapshot = await response.json()
    } catch {
      snapshot = null
    }

    if (!snapshot) {
      // 后端连不上：继续退避重试，但把次数说清楚（最多 12 次 ≈ 一分多钟）
      if (view.retries >= 12) {
        giveUp(\`连不上后端，本次运行看不到了（可能是后端重启过）。\`)
        return
      }
      void recoverRun()
      return
    }

    // 后端还认得这个运行：先把它已经产生、但我们没收到的事件补齐
    const events = Array.isArray(snapshot.events) ? snapshot.events : []
    for (const event of events.slice(view.eventCount)) {
      view.eventCount += 1
      handle(event)
    }

    if (snapshot.status === 'running') {
      setStatus(\`已重连（补了 \${events.length - (view.eventCount - events.length)} 条）…\`, 'live')
      view.retries = 0
      subscribe(runId, view.eventCount)
      return
    }

    // 已经结束了：收尾
    view.retries = 0
    setBusy(false)
    view.runId = null
    closeSource()
    return
  }, delay)
}

/** 彻底恢复不了：给一句原因和两个出口，而不是永远挂着"重试中"。 */
function giveUp(reason) {
  view.runId = null
  view.retries = 0
  if (view.retryTimer) clearTimeout(view.retryTimer)
  view.retryTimer = null
  closeSource()
  setBusy(false)
  hideThinking()
  setStatus(reason, 'err')

  if (document.getElementById('recover-hint')) return
  const hint = el('div', 'hint snapshot-actions')
  hint.id = 'recover-hint'
  const again = el('button', 'link', '重新发送')
  again.addEventListener('click', () => {
    hint.remove()
    const last = document.querySelector('.msg.user .text')
    if (last) {
      input.value = last.textContent
      autoGrow()
      input.focus()
    }
  })
  const restart = el('button', 'link', '重启后端')
  restart.addEventListener('click', () => {
    hint.remove()
    vscode.postMessage({ type: 'restartServer' })
    setTimeout(() => vscode.postMessage({ type: 'needUrl' }), 1500)
  })
  hint.append(document.createTextNode(reason + ' '), again, ' 或 ', restart)
  thread.append(hint)
  scrollDown()
}`

if (code.includes(from)) {
  code = code.replace(from, to)
  done.push('断线续传 + 退避 + 兜底')
} else {
  console.log('⚠ subscribe 锚点未匹配')
}

// 3) 新一轮发送时把计数清零
code = code.replace(
  `  showThinking()
  view.bubbles.clear()`,
  `  showThinking()
  view.eventCount = 0
  view.retries = 0
  view.bubbles.clear()`,
)

// 4) 主动结束/新任务时清掉重连定时器
code = code.replace(
  `function closeSource() {
  if (view.source) {`,
  `function closeSource() {
  if (view.retryTimer) {
    clearTimeout(view.retryTimer)
    view.retryTimer = null
  }
  if (view.source) {`,
)

writeFileSync(path, code, 'utf8')
console.log('chat.js:', done.join(' / ') || '(无改动)')
