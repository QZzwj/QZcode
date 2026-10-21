/* QZcode 侧栏聊天。
   与本地服务直连（fetch + EventSource），扩展只负责给地址、弹供应商选择器。 */

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {} }

/** 等地址的回调队列：init 到达时统一唤醒。 */
const urlWaiters = []

const $ = (id) => document.getElementById(id)
const thread = $('thread')
const input = $('input')
const sendBtn = $('send')
const statusLine = $('status')
const providerBtn = $('provider')
const providerLabel = $('provider-label')

const WHO = { planner: ['A', 'a'], implementer: ['B', 'b'], verifier: ['C', 'c'] }
const view = {
  base: '',
  source: null,
  runId: null,
  busy: false,
  round: 0,
  bubbles: new Map(),
  /** 已经收到多少条事件：断线重连时从这个下标继续（后端支持 ?since=） */
  eventCount: 0,
  /** 最近一次运行的 id（取消后仍能据此回滚） */
  lastRunId: '',
  /** 重连次数，用来退避和给用户看进度 */
  retries: 0,
  retryTimer: null,
}

/* ------------------------------------------------------------------ markdown */

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

/** 够用就行的 markdown：标题、列表、围栏代码、粗体、行内代码。 */
function md(source) {
  const lines = String(source ?? '').split(/\r?\n/)
  const out = []
  let list = null
  let fence = null

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }

  for (const line of lines) {
    if (fence) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(fence.body.join('\n'))}</code></pre>`)
        fence = null
      } else fence.body.push(line)
      continue
    }
    const open = line.match(/^\s*```(\w*)/)
    if (open) {
      closeList()
      fence = { body: [] }
      continue
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = Math.min(6, heading[1].length + 1)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ordered) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inline(ordered[1])}</li>`)
      continue
    }
    if (!line.trim()) {
      closeList()
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  if (fence) out.push(`<pre><code>${escapeHtml(fence.body.join('\n'))}</code></pre>`)
  closeList()
  return out.join('')
}

/* -------------------------------------------------------------------- render */

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

/** 空状态里的示例，点一下填进输入框。 */
const EXAMPLES = [
  '给 src/utils.ts 加 parseDuration 并补测试',
  '把 README 里的安装步骤改成分平台说明',
  '排查 npm test 为什么在 Windows 上失败',
]

function buildExamples() {
  const box = $('examples')
  if (!box) return
  box.replaceChildren()
  for (const text of EXAMPLES) {
    const button = el('button', 'example', text)
    button.type = 'button'
    button.addEventListener('click', () => {
      const input = $('input')
      if (!input) return
      input.value = text
      input.focus()
      autoGrow()
    })
    box.append(button)
  }
}

function clearHint() {
  const hint = $('hint')
  if (hint) hint.remove()
}

function scrollDown() {
  thread.scrollTop = thread.scrollHeight
}

/** 运行中的秒表：让人一眼看出"在跑"而不是"死了"。 */
let busyTimer = null
let busyStartedAt = 0

function startBusyClock() {
  stopBusyClock()
  busyStartedAt = Date.now()
  const status = $('status')
  if (!status) return
  const node = el('span', 'timer', '0.0s')
  status.append(node)
  busyTimer = setInterval(() => {
    const current = statusLine.querySelector('.timer')
    if (current) current.textContent = clockNode().textContent
  }, 200)
}

function stopBusyClock() {
  if (busyTimer) clearInterval(busyTimer)
  busyTimer = null
  for (const node of document.querySelectorAll('.status .timer')) node.remove()
}

/** 状态行变了也别把秒表搞丢：忙碌中重新挂回去。 */
/* 接力轨道：把"现在跑到哪一段"画在左侧，别只写在状态栏里。 */
const RAIL_ORDER = ['leader', 'planner', 'implementer', 'verifier']

function setRail(role, finished) {
  const rail = $('rail')
  if (!rail) return
  const nodes = [...rail.querySelectorAll('.rail-node')]
  const target = RAIL_ORDER.indexOf(String(role || ''))
  nodes.forEach((node, index) => {
    node.classList.remove('active')
    node.classList.toggle('past', finished === true ? index <= target : index < target)
    if (!finished && index === target) node.classList.add('active')
  })
}

function setStatus(text, kind) {
  statusLine.textContent = text ?? ''
  statusLine.className = `status${kind ? ' ' + kind : ''}`
  // 运行中重新挂上"已运行 XX"：不然状态一更新，秒表就没了
  if (busyTimer) statusLine.append(clockNode())
}

/** 秒表节点（长任务的关键反馈：让人知道在跑，而不是死了）。 */
function clockNode() {
  const seconds = (Date.now() - busyStartedAt) / 1000
  const label =
    seconds < 60 ? `已运行 ${seconds.toFixed(1)}s` : `已运行 ${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
  return el('span', 'timer', label)
}

/* ---------------------------------------------------------- 等待反馈
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

function addUser(text) {
  clearHint()
  const row = el('div', 'msg user')
  const bubble = el('div', 'text')
  bubble.textContent = text
  row.append(bubble)
  thread.append(row)
  scrollDown()
}

function bubbleFor(pane) {
  const key = `${view.round}:${pane}`
  if (view.bubbles.has(key)) return view.bubbles.get(key)
  clearHint()
  const [letter, cls] = WHO[pane] ?? ['·', '']
  const row = el('div', 'msg agent')
  row.dataset.role = pane
  const head = el('div', 'head')
  const badge = el('span', `badge ${cls}`)
  badge.textContent = letter
  const title = el('span', 'title')
  title.textContent = pane === 'planner' ? '任务书' : pane === 'implementer' ? '实现' : '核验'
  head.append(badge, title)
  const text = el('div', 'text')
  const tools = el('div', 'tools')
  const chips = el('div', 'chips')
  row.append(head, text, tools, chips)
  thread.append(row)
  const entry = { row, text, tools, chips, buffer: '', timer: null }
  view.bubbles.set(key, entry)
  scrollDown()
  return entry
}

function renderText(entry) {
  entry.text.innerHTML = md(entry.buffer)
  scrollDown()
}

function addTool(event) {
  const entry = bubbleFor(event.pane)
  const running = event.stage === 'start'
  const cls = running ? 'tool running' : event.ok === false ? 'tool bad' : 'tool ok'
  const line = el('div', cls)
  const name = el('span', 'name')
  name.textContent = event.name
  const state = el('span', 'state', running ? '…' : event.ok === false ? 'ERR' : 'OK')
  line.append('→ ', name, state)
  if (event.stage === 'end' && typeof event.ms === 'number') line.append(el('span', 'ms', `${event.ms}ms`))
  if (event.args) {
    line.append(el('span', 'args', String(event.args).replace(/\s+/g, ' ').slice(0, 80)))
  }
  if (event.output) line.title = String(event.output).slice(0, 800)
  entry.tools.append(line)
  scrollDown()
}

/** 文件改动：B 每改一个文件就插一条可折叠的 diff，过程看得见。 */
function addPatch(event) {
  const entry = bubbleFor(event.pane)
  const box = el('div', 'patch')
  const head = el('div', 'patch-head')
  const statusMark = event.status === 'created' ? '新增' : event.status === 'deleted' ? '删除' : '修改'
  head.append(el('span', 'patch-path', `${statusMark} ${event.path}`))
  head.append(el('span', 'patch-stat patch-added', `+${event.added}`))
  head.append(el('span', 'patch-stat patch-removed', `−${event.removed}`))
  head.append(el('span', 'dim', '展开'))
  const body = el('pre', 'patch-body')
  const lines = String(event.diff || "").split("\n")
  for (const line of lines) {
    if (!line) continue
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'del'
      : line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++') ? 'meta'
      : ''
    body.append(el('div', cls, line))
  }
  body.hidden = true
  head.addEventListener("click", () => {
    body.hidden = !body.hidden
    head.lastChild.textContent = body.hidden ? '展开' : '收起'
  })
  box.append(head, body)
  entry.tools.append(box)
  scrollDown()
}

function addTag(pane, text, cls, options = {}) {
  const entry = bubbleFor(pane)
  const tag = el('span', `tag ${cls ?? ''}`)
  tag.textContent = text

  if (options.center === true) {
    // 结论（通过 / 未通过）是这一轮的结果，单独占一行、居中，别混在细节标签里
    tag.classList.add('verdict')
    const row = el('div', 'verdict-row')
    row.append(tag)
    entry.row.append(row)
  } else {
    entry.chips.append(tag)
  }
  scrollDown()
}

/* -------------------------------------------------------------------- events */

function handle(event) {
  // 只要有真实进展，就不再是"还在想"了
  if (event.t !== 'run_start') hideThinking()
  switch (event.t) {
    case 'run_start':
      setStatus('A 写任务书中…', 'live')
      break
    case 'phase':
      view.round = event.round
      setRail(event.phase === 'plan' ? 'planner' : event.phase === 'implement' ? 'implementer' : 'verifier')
      setStatus(
        `第 ${event.round} 轮 · ${event.phase === 'plan' ? 'A 规划' : event.phase === 'implement' ? 'B 实现' : 'C 核验'}`,
        'live',
      )
      break
    case 'text': {
      const entry = bubbleFor(event.pane)
      entry.buffer += event.delta
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => renderText(entry), 60)
      break
    }
    case 'text_end':
      renderText(bubbleFor(event.pane))
      break
    case 'tool':
      addTool(event)
      break
    case 'patch':
      addPatch(event)
      break
    case 'review': {
      const review = event.review ?? {}
      addTag('planner', review.ok ? 'A 复核 · 对齐' : 'A 复核 · 退回修正', review.ok ? 'pass' : 'fail')
      if (!review.ok) {
        const entry = bubbleFor('planner')
        for (const item of (review.drift ?? []).slice(0, 3)) {
          const line = el('div', 'tool')
          line.textContent = '· ' + item
          entry.tools.append(line)
        }
        scrollDown()
      }
      break
    }
    case 'plan':
      addTag('planner', `任务书 · ${event.plan?.acceptance?.length ?? 0} 条验收`)
      break
    case 'verdict':
      addTag(
        'verifier',
        event.verdict?.pass ? '✔ 通过' : '✘ 未通过',
        event.verdict?.pass ? 'pass' : 'fail',
        { center: true },
      )
      break
    case 'note':
      if (event.message) setStatus(event.message, event.level === 'error' ? 'err' : undefined)
      break
    case 'route': {
      const decision = event.decision ?? {}
      addTag('system', decision.route === 'direct' ? 'L：直接回答' : 'L：走流水线', decision.route === 'direct' ? 'pass' : '')
      break
    }
    case 'done': {
      const result = event.result
      const seconds = (result.elapsedMs / 1000).toFixed(1)
      setStatus(
        `${result.ok ? '✔ 完成' : '✘ 未通过'} · ${result.rounds} 轮 · ${seconds}s · ${result.usage?.total ?? 0} tok`,
      )
      // 计划模式：任务书出了但还没动手，等用户点头
      if (result.planned === true) {
        setStatus('任务书已出，等你确认', 'ok')
        const box = el('div', 'snapshot-actions')
        box.id = 'plan-actions'
        const go = el('button', 'primary-mini', '按这个做')
        go.type = 'button'
        go.addEventListener('click', () => {
          box.remove()
          vscode.postMessage({ type: 'continuePlan', runId: view.runId ?? '' })
        })
        box.append('要先看一眼任务书？确认后我再动手。 ', go)
        thread.append(box)
        scrollDown()
      }

      const touched = event.touched ?? 0
      const runId = view.runId ?? ''
      if (touched > 0) {
        const box = el('div', 'hint snapshot-actions')
        box.append(`本次运行改动了 ${touched} 个文件：`)
        const diff = el('button', 'link', '查看改动')
        diff.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }))
        const rollback = el('button', 'link', '全部回滚')
        rollback.addEventListener('click', () => vscode.postMessage({ type: 'rollback' }))
        const one = el('button', 'link', '回滚某个文件')
        one.addEventListener('click', () => vscode.postMessage({ type: 'rollbackFile', runId }))
        box.append(diff, ' · ', one, ' · ', rollback)
        thread.append(box)
      }
      {
        const box = el('div', 'hint snapshot-actions')
        const log = el('button', 'link', '查看本轮记录')
        log.addEventListener('click', () => vscode.postMessage({ type: 'openRunLog' }))
        box.append(log)
        thread.append(box)
        scrollDown()
      }
      break
    }


    case 'run_end':
      hideThinking()
      setRail('verifier', true)
      setBusy(false)
      view.runId = null
      closeSource()
      if (event.status === 'cancelled') {
        setStatus('已取消', 'err')
        // 停下来之后仍然可以回滚这次已经改过的文件
        const box = el('div', 'hint snapshot-actions')
        box.append('本次运行已经停下来了，改动还在。')
        const rollback = el('button', 'link', '回滚这次改动')
        rollback.addEventListener('click', () =>
          vscode.postMessage({ type: 'rollback', runId: view.lastRunId }),
        )
        box.append(' ', rollback)
        thread.append(box)
        scrollDown()
      }
      if (event.status === 'planned') setStatus('任务书已出，等你确认', 'ok')
      break
    default:
      break
  }
}

function closeSource() {
  if (view.retryTimer) {
    clearTimeout(view.retryTimer)
    view.retryTimer = null
  }
  if (view.source) {
    view.source.close()
    view.source = null
  }
}

function setBusy(busy) {
  view.busy = busy
  // 发送键二合一：运行中变成"停止"（不再单独放一个停止按钮）
  sendBtn.classList.toggle('stop-mode', busy)
  sendBtn.setAttribute('aria-label', busy ? '停止当前运行' : '发送')
  sendBtn.title = busy ? '停止当前运行 (Esc)' : '发送 (Enter)'
  sendBtn.disabled = false
  if (busy) {
    setStatus('运行中…（Esc 或 ■ 可强制停止）', 'busy')
    startBusyClock()
  } else {
    stopBusyClock()
  }
}

function subscribe(runId, since = 0) {
  closeSource()
  view.runId = runId
  view.lastRunId = runId
  if (since === 0) {
    view.eventCount = 0
    view.retries = 0
  }
  const source = new EventSource(`${view.base}/api/events?id=${runId}&since=${since}`)
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
  setStatus(`连接中断，正在重连（第 ${view.retries} 次）…`, 'err')

  view.retryTimer = setTimeout(async () => {
    view.retryTimer = null
    if (!view.runId) return

    let snapshot = null
    let missing = false
    try {
      const response = await fetch(`${view.base}/api/run?id=${runId}`)
      if (response.ok) snapshot = await response.json()
      else if (response.status === 404) missing = true
    } catch {
      snapshot = null
    }

    if (missing) {
      giveUp(`后端重启过，这次运行的进度已经丢了（已完成的改动仍在工作区，记录见 .qzcode/run*.md）。`)
      return
    }

    if (!snapshot) {
      // 后端连不上：继续退避重试，但把次数说清楚（最多 12 次 ≈ 一分多钟）
      if (view.retries >= 12) {
        giveUp(`连不上后端，本次运行看不到了（可能是后端重启过）。`)
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
      setStatus(`已重连（补了 ${events.length - (view.eventCount - events.length)} 条）…`, 'live')
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
}

/* ------------------------------------------------------------------- actions */

async function send() {
  const goal = input.value.trim()
  if (!goal || view.busy) return
  input.value = ''
  autoGrow()
  addUser(goal)
  showThinking()
  view.eventCount = 0
  view.retries = 0
  view.bubbles.clear()
  view.round = 0
  setBusy(true)
  setStatus('提交中…', 'live')

  try {
    const response = await request((base) =>
      fetch(`${base}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal,
          planOnly: Boolean($('plan-first') && $('plan-first').checked),
        }),
      }),
    )
    const payload = await response.json()
    if (!response.ok) {
      setBusy(false)
      setStatus(payload.error ?? '启动失败', 'err')
      return
    }
    subscribe(payload.runId)
  } catch (error) {
    setBusy(false)
    hideThinking()
    setStatus(`请求失败：${error.message}`, 'err')
    addRetryHint()
  }
}

/**
 * 带着"地址可能已经变了"的假设发请求：
 * 没有地址 / 连不上 → 向扩展要一次最新地址 → 重试一次。
 * （后端每次启动端口是随机的，webview 里存下来的地址随时可能过期。）
 */
/** 强制停止：把 runId 发给后端 abort。没有 runId 时让后端取消"正在跑的那个"。 */
async function stopRun() {
  setStatus('正在停止…', 'live')
  try {
    const response = await request((base) =>
      fetch(`${base}/api/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: view.runId ?? '' }),
      }),
    )
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      setStatus(payload.error ?? '停止失败', 'err')
      return
    }
    setStatus('已发送停止请求，等当前工具调用结束…', 'live')
  } catch (error) {
    setStatus(`停止失败：${error.message}`, 'err')
  }
}

async function request(build, attempts = 2) {
  let lastError = null
  for (let i = 0; i < attempts; i++) {
    if (!view.base) {
      vscode.postMessage({ type: 'needUrl' })
      const url = await waitForUrl(4000)
      if (!url) throw new Error('没拿到服务地址，后端可能还没起来')
    }
    try {
      return await build(view.base)
    } catch (error) {
      lastError = error
      // 只在"连不上"时换地址重试；HTTP 4xx/5xx 不该重试
      view.base = ''
      vscode.postMessage({ type: 'needUrl' })
      await waitForUrl(3000)
    }
  }
  throw lastError ?? new Error('请求失败')
}

function waitForUrl(timeoutMs) {
  return new Promise((resolve) => {
    if (view.base) return resolve(view.base)
    const timer = setTimeout(() => resolve(''), timeoutMs)
    urlWaiters.push((url) => {
      clearTimeout(timer)
      resolve(url)
    })
  })
}

/** 失败了给一条可点的出路，而不是只丢一句 Failed to fetch。 */
function addRetryHint() {
  if (document.getElementById('retry-hint')) return
  const hint = el('div', 'hint')
  hint.id = 'retry-hint'
  const again = el('button', 'link', '重试')
  again.addEventListener('click', () => {
    hint.remove()
    void send()
  })
  const restart = el('button', 'link', '重启服务')
  restart.addEventListener('click', () => {
    hint.remove()
    vscode.postMessage({ type: 'restartServer' })
    setTimeout(() => vscode.postMessage({ type: 'needUrl' }), 1500)
  })
  hint.append('后端没响应。', again, ' 或 ', restart)
  thread.append(hint)
  scrollDown()
}

function newTask() {
  closeSource()
  hideThinking()
  view.bubbles.clear()
  view.round = 0
  setBusy(false)
  thread.innerHTML = ''
  const hint = el('div', 'hint')
  hint.id = 'hint'
  const p1 = el('p')
  p1.textContent = '一句目标，A 写任务书 → B 实现 → C 核验。'
  const p2 = el('p', 'dim')
  p2.textContent = '例如：给 src/utils.ts 加 parseDuration 并补测试'
  hint.append(p1, p2)
  thread.append(hint)
  setStatus('')
  input.focus()
}

function autoGrow() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(120, input.scrollHeight)}px`
}

/* -------------------------------------------------------------------- wiring */

input.addEventListener('input', autoGrow)
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
})
sendBtn.addEventListener('click', () => {
  // 二合一：忙碌时这个键就是停止
  if (view.busy) void stopRun()
  else void send()
})

// Esc = 强制停止（和 ■ 等价）
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && view.busy) {
    event.preventDefault()
    void stopRun()
  }
})
$('new-task').addEventListener('click', newTask)
providerBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickProvider' }))

function applyProvider(state) {
  if (!state || !state.current) return
  const current = state.current
  providerLabel.textContent = `${current.provider} · ${current.model}`
  providerBtn.title = `当前 ${current.provider} · ${current.model}${current.mock ? '（mock，不联网）' : ''}\n点击切换供应商`
  providerBtn.classList.toggle('mock', Boolean(current.mock))
}

window.addEventListener('message', async (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'init') {
    view.base = String(message.url ?? '').replace(/\/+$/, '')
    if (message.git) {
      gitState = { autoCommit: message.git.autoCommit === true, repo: message.git.repo === true }
      renderGit()
    }
    for (const waiter of urlWaiters.splice(0)) waiter(view.base)
    applyProvider(message.providers)
    if (message.error) setStatus(message.error, 'err')
    else if (!view.busy) setStatus('')
    return
  }
  if (message.type === 'continued') {
    const payload = message.result || {}
    if (payload.ok && payload.runId) {
      const box = document.getElementById('plan-actions')
      if (box) box.remove()
      view.bubbles.clear()
      view.round = 0
      setBusy(true)
      subscribe(payload.runId)
    } else {
      setStatus(payload.error || '继续执行失败', 'err')
    }
    return
  }
  if (message.type === 'providers') {
    applyProvider(message.providers)
    return
  }
})

buildExamples()
// 后端要几百毫秒才起来：先给个明确的状态，别让人看着空面板发呆
setStatus('正在启动后端…', 'busy')
// 面板里出任何未捕获错误都别让它变空白：显示在状态行，并回报给扩展写日志
window.addEventListener('qz-webview-error', () => {})
window.addEventListener('error', (event) => {
  const text = event && event.message ? event.message : '未知错误'
  if (statusLine) setStatus('面板出错了：' + text, 'err')
  vscode.postMessage({ type: 'webviewError', error: text + ' @ ' + (event && event.filename) + ':' + (event && event.lineno) })
})
window.addEventListener('unhandledrejection', (event) => {
  const text = event && event.reason ? String(event.reason && event.reason.message ? event.reason.message : event.reason) : '未知错误'
  if (statusLine) setStatus('面板出错了：' + text, 'err')
  vscode.postMessage({ type: 'webviewError', error: 'unhandledrejection: ' + text })
})

/** 输入框下面的 git 开关：只有工作区是 git 仓库时才出现。 */
let gitState = { autoCommit: false, repo: false }

function renderGit() {
  const toggle = $('git-toggle')
  const box = $('git-auto')
  const hint = $('git-hint')
  if (!toggle || !box || !hint) return
  // 没仓库也照常显示开关：打开后第一次提交会自动 git init
  toggle.hidden = false
  box.checked = gitState.autoCommit === true
  hint.textContent =
    gitState.repo === true
      ? ''
      : gitState.autoCommit === true
        ? '（不是 git 仓库：下次提交会自动 git init）'
        : '（不是 git 仓库，开启后会自动建一个）'
}

const gitBox = $("git-auto")
if (gitBox) {
  gitBox.addEventListener("change", () => {
    gitState.autoCommit = gitBox.checked
    vscode.postMessage({ type: "setGit", autoCommit: gitBox.checked })
    setStatus(gitBox.checked ? "已开启：每次改动后自动 git 提交" : "已关闭自动提交", "ok")
  })
}

vscode.postMessage({ type: 'ready' })
input.focus()
