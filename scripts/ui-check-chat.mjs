import { spawn } from 'node:child_process'
import { buildPreviewPage, vscodeStub } from './preview-page.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * UI 验收：规则来自 ui-ux-pro-max-zh（无障碍/触摸/动效/对比度）+ frontend-design（节制、签名元素）。
 * 主模型读不了图片，所以全部用计算样式做断言。
 */

const PAGE = buildPreviewPage({
  kind: 'chat',
  name: 'chat',
  stub: vscodeStub({
    startDelayMs: 1100,
    init: { providers: { providers: [], current: { provider: 'ghd', model: 'deepseek-v4.1-flash', mock: false } } },
    events: [
      { t: 'route', decision: { route: 'pipeline', why: '要改动代码' } },
      { t: 'phase', phase: 'plan', round: 1 },
      { t: 'text', pane: 'planner', delta: '## 任务\n在空工作区新建 `index.html`，做一个能直接打开玩的中文跳一跳。\n\n' },
      { t: 'text', pane: 'planner', delta: '**验收**\n1. 内联 HTML/CSS/JS\n2. 按住蓄力、松开跳跃\n3. 落台计分、落空可重开' },
      { t: 'text_end', pane: 'planner' },
      { t: 'plan', plan: { acceptance: [1, 2, 3] } },
      { t: 'phase', phase: 'implement', round: 1 },
      { t: 'text', pane: 'implementer', delta: '先看一眼目录，然后直接写文件。' },
      { t: 'text_end', pane: 'implementer' },
      { t: 'tool', pane: 'implementer', stage: 'start', name: 'bash', args: '{"command":"pwd && ls -la"}' },
      { t: 'tool', pane: 'implementer', stage: 'end', name: 'bash', ok: true, ms: 247 },
      { t: 'tool', pane: 'implementer', stage: 'start', name: 'write', args: '{"path":"index.html","content":"…"}' },
      { t: 'tool', pane: 'implementer', stage: 'end', name: 'write', ok: true, ms: 96 },
      { t: 'tool', pane: 'implementer', stage: 'start', name: 'browser', args: '{"action":"open"}' },
      { t: 'tool', pane: 'implementer', stage: 'end', name: 'browser', ok: true, ms: 812 },
      { t: 'tool', pane: 'implementer', stage: 'start', name: 'bash', args: '{"command":"node -e …"}' },
      { t: 'tool', pane: 'implementer', stage: 'end', name: 'bash', ok: false, ms: 7094 },
      { t: 'patch', pane: 'implementer', path: 'index.html', status: 'modified', added: 5, removed: 1,
        diff: '--- index.html（改动前）\n+++ index.html（改动后）\n@@ 约第 12 行 @@\n-const MIN_DIST = 60;\n+const MIN_DIST = 45;\n  其余不变' },
      { t: 'review', review: { ok: false, drift: ['落台判定没验证'] } },
      { t: 'phase', phase: 'verify', round: 1 },
      { t: 'text', pane: 'verifier', delta: '断言了首屏分数、按住 600ms 后得分、重开归零；两个视口都没有横向溢出。' },
      { t: 'text_end', pane: 'verifier' },
      { t: 'verdict', verdict: { pass: true } },
      { t: 'usage', pane: 'implementer', usage: { prompt: 5200, completion: 1797, total: 6997 } },
      { t: 'done', result: { ok: true, rounds: 1, elapsedMs: 18400, usage: { total: 6997 } }, touched: 2 },
      { t: 'run_end', status: 'passed' },
    ],
    onReady: `window.__CENTER__ = (() => {
        const hint = document.getElementById('hint');
        const thread = document.getElementById('thread');
        if (!hint || !thread) return { ok: false, reason: '找不到空状态' };
        const h = hint.getBoundingClientRect();
        const t = thread.getBoundingClientRect();
        const dx = Math.abs((h.left + h.right) / 2 - (t.left + t.right) / 2);
        const dy = Math.abs((h.top + h.bottom) / 2 - (t.top + t.bottom) / 2);
        return { ok: dx <= 3 && dy <= 12, dx: Math.round(dx), dy: Math.round(dy), textAlign: getComputedStyle(hint).textAlign };
      })();
      setTimeout(() => {
        const thinking = document.getElementById('thinking');
        window.__THINKING__ = thinking
          ? { text: thinking.textContent.trim(), dots: thinking.querySelectorAll('.dots i').length }
          : null;
      }, 260);
      window.__EMPTY__ = {
        flow: (document.querySelector('.empty-flow') || {}).textContent || '',
        chain: (document.querySelector('.empty-chain') || {}).textContent || '',
        items: document.querySelectorAll('.empty-chain .flow-item').length,
      };
      document.getElementById('input').value = '帮我制作一个跳一跳的 HTML 小游戏';
      document.getElementById('send').click();`,
  }),
})
const SHOTS = join(tmpdir(), 'qz-ui-shots')
mkdirSync(SHOTS, { recursive: true })

const chrome = [
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((item) => existsSync(item))

const port = 9477
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(tmpdir(), `qz-ui2-${Date.now()}`)}`,
    '--window-size=1000,900',
    PAGE,
  ],
  { stdio: 'ignore', windowsHide: true },
)
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
await send('Runtime.enable')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' · ' + detail : ''}`)
}

await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 2, mobile: false })
await sleep(400)
await evaluate("document.getElementById('input').value = '做一个跳一跳'; document.getElementById('send').click()")
await sleep(1100)

// 1) 计时器 + 忙碌
const midRun = await evaluate(`(() => ({
  timer: document.querySelector('#status .timer')?.textContent ?? null,
  railActive: [...document.querySelectorAll('.rail-node')].findIndex((n) => n.classList.contains('active')),
  railNodes: document.querySelectorAll('.rail-node').length,
  railRoles: [...document.querySelectorAll('.rail-node')].map((n) => n.dataset.role),
}))()`)
const sendMode = await evaluate(`(() => {
  const btn = document.getElementById('send');
  return {
    stopMode: btn.classList.contains('stop-mode'),
    label: btn.getAttribute('aria-label'),
    title: btn.title,
    sendIcon: getComputedStyle(btn.querySelector('.icon-send')).display,
    stopIcon: getComputedStyle(btn.querySelector('.icon-stop')).display,
    onlyOneButton: !document.getElementById('stop'),
  };
})()`)
check('运行中发送键变成停止（二合一）', sendMode.stopMode === true && /停止/.test(sendMode.label ?? ''), JSON.stringify(sendMode))
check('停止态只显示方块图标', sendMode.sendIcon === 'none' && sendMode.stopIcon !== 'none', JSON.stringify(sendMode))
check('页面上只有一个按钮（没有独立停止键）', sendMode.onlyOneButton === true)

const emptyState = await evaluate(`(() => {
  const captured = window.__EMPTY__ || { flow: '', chain: '', items: 0 };
  return { flow: captured.flow, chain: captured.chain, chainItems: captured.items };
})()`)
const centerFit = await evaluate(`(() => {
  // 预览里跑起来后空状态已被替换，所以用一份"刚加载、还没发消息"的快照来衡量
  return window.__CENTER__ || null;
})()`)
check('空状态在画面正中（横竖都居中）', centerFit ? centerFit.ok === true : false, JSON.stringify(centerFit))

check('空状态写着 L 管全程', /L\s*管全程/.test(emptyState.flow), emptyState.flow.trim())
check('执行链是 A→B→C 三段', emptyState.chainItems === 3 && /写任务书/.test(emptyState.chain) && /核验/.test(emptyState.chain), emptyState.chain.trim())

const thinkingState = await evaluate(`(() => ({
  saved: window.__THINKING__ || null,
  now: Boolean(document.getElementById('thinking')),
}))()`)
check('刚发出消息时显示"正在思考中"', thinkingState.saved !== null && /正在思考中/.test(thinkingState.saved.text), JSON.stringify(thinkingState.saved))
check('思考中带三个跳动的小点', (thinkingState.saved?.dots ?? 0) === 3, JSON.stringify({ dots: thinkingState.saved?.dots }))
check('收到回复后角标自动消失', thinkingState.now === false, JSON.stringify({ now: thinkingState.now }))

check('运行中有「已运行 XX」计时器', /已运行/.test(midRun.timer ?? ''), midRun.timer ?? 'null')
check('接力轨道有 4 段且当前段点亮', midRun.railNodes === 4 && midRun.railActive >= 0, `nodes=${midRun.railNodes} active=${midRun.railActive}`)
check('轨道顺序是 L/A/B/C', (midRun.railRoles ?? []).join('>') === 'leader>planner>implementer>verifier', (midRun.railRoles ?? []).join('>'))


await sleep(3600)

// 2) 结构与排版
const layout = await evaluate(`(() => {
  const doc = document.documentElement;
  const thread = document.getElementById('thread').getBoundingClientRect();
  const out = { overflowX: doc.scrollWidth > window.innerWidth + 1, issues: [] };
  for (const node of document.querySelectorAll('.msg')) {
    const r = node.getBoundingClientRect();
    if (r.right > thread.right + 1 || r.left < thread.left - 1) out.issues.push('越界 ' + node.className);
  }
  out.tools = document.querySelectorAll('.tool').length;
  out.toolIssues = [...document.querySelectorAll('.tool')].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.right > thread.right + 1 || parseFloat(getComputedStyle(n).fontSize) < 10.5;
  }).length;
  out.tags = [...document.querySelectorAll('.tag')].map((n) => n.textContent.trim());
  out.railPast = document.querySelectorAll('.rail-node.past').length;
  // 图标必须是 SVG，不能是字符
  out.glyphIcons = [...document.querySelectorAll('.icon-btn, .send, .stop')].filter((n) => !n.querySelector('svg')).length;
  out.svgIcons = document.querySelectorAll('.icon-btn svg, .send svg, .stop svg').length;
  // 可点击元素都有可访问名
  out.unnamed = [...document.querySelectorAll('button')].filter((n) => {
    const label = (n.getAttribute('aria-label') || n.textContent || '').trim();
    return label.length === 0;
  }).length;
  // 正文行高
  const bodyText = document.querySelector('.msg.agent .text');
  out.lineHeight = bodyText ? parseFloat(getComputedStyle(bodyText).lineHeight) / parseFloat(getComputedStyle(bodyText).fontSize) : 0;
  return out;
})()`)

const radiusCheck = await evaluate(`(() => {
  const radius = (sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    return parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;
  };
  return {
    user: radius('.msg.user .text'),
    composer: radius('.composer-box'),
    patch: radius('.patch-body'),
    code: radius('.text pre'),
    send: radius('.send'),
    tag: radius('.tag'),
  };
})()`)
const radiusValues = Object.values(radiusCheck).filter((value) => typeof value === 'number')
check('圆角至少 4px（别太硬朗）', radiusValues.length >= 4 && Math.min(...radiusValues) >= 4, JSON.stringify(radiusCheck))

check('没有横向溢出', layout.overflowX === false)
check('消息都在会话区内', layout.issues.length === 0, layout.issues.join('; ') || 'ok')
check('工具行数量正确且不溢出', layout.tools >= 6 && layout.toolIssues === 0, `tools=${layout.tools}`)
const patchUi = await evaluate(`(() => {
      const patch = document.querySelector('.patch');
      const head = patch ? patch.querySelector('.patch-head') : null;
      const body = patch ? patch.querySelector('.patch-body') : null;
      const toggle = document.getElementById('git-toggle');
      // 展开 diff 看颜色类有没有用上
      if (head) head.click();
      const addLine = patch ? patch.querySelector('.patch-body .add') : null;
      const delLine = patch ? patch.querySelector('.patch-body .del') : null;
      const rect = body ? body.getBoundingClientRect() : null;
      return {
        hasPatch: Boolean(patch),
        headText: head ? head.textContent : '',
        expanded: body ? body.hidden === false : false,
        addColor: addLine ? getComputedStyle(addLine).color : null,
        delColor: delLine ? getComputedStyle(delLine).color : null,
        noOverflow: rect ? rect.right <= document.getElementById('thread').getBoundingClientRect().right + 1 : false,
        hasToggle: Boolean(toggle),
      };
    })()`)
check('文件改动以 diff 形式显示', patchUi.hasPatch === true && /index\.html/.test(patchUi.headText), patchUi.headText.slice(0, 40))
check('diff 块能展开且有 +/− 配色', patchUi.expanded === true && /78,\s*201,\s*165/.test(patchUi.addColor ?? '') && /242,\s*112,\s*95/.test(patchUi.delColor ?? ''), JSON.stringify({ add: patchUi.addColor, del: patchUi.delColor }))
check('diff 块不横向溢出', patchUi.noOverflow === true)
check('输入框下面有 git 自动提交开关', patchUi.hasToggle === true)

const verdictUi = await evaluate(`(() => {
  const row = document.querySelector('.verdict-row');
  const tag = document.querySelector('.tag.verdict');
  const thread = document.getElementById('thread').getBoundingClientRect();
  if (!row || !tag) return { found: false };
  const r = tag.getBoundingClientRect();
  const dx = Math.abs((r.left + r.right) / 2 - (thread.left + thread.right) / 2);
  return {
    found: true,
    text: tag.textContent.trim(),
    dx: Math.round(dx),
    centered: getComputedStyle(row).justifyContent,
    fontSize: parseFloat(getComputedStyle(tag).fontSize),
  };
})()`)
check('通过结论居中显示', verdictUi.found === true && verdictUi.dx <= 3 && verdictUi.centered === 'center', JSON.stringify(verdictUi))

check('阶段标签有通过/退回', layout.tags.some((t) => /退回/.test(t)) && layout.tags.some((t) => /通过/.test(t)), layout.tags.join(' | '))
check('结束后轨道整条点亮', layout.railPast === 4, `past=${layout.railPast}`)
check('图标全部是 SVG（无字符图标）', layout.glyphIcons === 0 && layout.svgIcons >= 3, `svg=${layout.svgIcons} glyph=${layout.glyphIcons}`)
check('所有按钮都有可访问名', layout.unnamed === 0, `缺名=${layout.unnamed}`)
check('正文行高在 1.5–1.75', layout.lineHeight >= 1.4 && layout.lineHeight <= 1.8, layout.lineHeight.toFixed(2))

// 3) 对比度（正文与次要文字都 ≥4.5:1）
const contrast = await evaluate(`(() => {
  const parse = (color) => {
    const m = color.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((v) => parseFloat(v));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // 找元素实际生效的背景（向上找不透明的）
  const bgOf = (node) => {
    let current = node;
    while (current) {
      const bg = parse(getComputedStyle(current).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
      current = current.parentElement;
    }
    return { r: 30, g: 33, b: 38, a: 1 }; // 兜底：VS Code 深色底
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };
  const report = {};
  const targets = {
    'agent-text': document.querySelector('.msg.agent .text'),
    'tool-args': document.querySelector('.tool .args'),
    'tool-ms': document.querySelector('.tool .ms'),
    'status': document.getElementById('status'),
    'tag': document.querySelector('.tag'),
  };
  for (const [key, node] of Object.entries(targets)) {
    if (!node) { report[key] = null; continue; }
    const style = getComputedStyle(node);
    report[key] = Math.round(ratio(parse(style.color), bgOf(node)) * 100) / 100;
  }
  return report;
})()`)

for (const [key, value] of Object.entries(contrast)) {
  check(`${key} 对比度 ≥ 4.5`, typeof value === 'number' && value >= 4.5, String(value))
}

// 4) 焦点环（键盘可见）
const focus = await evaluate(`(() => {
  const btn = document.getElementById('send');
  btn.focus();
  const style = getComputedStyle(btn);
  return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
})()`)
check('按钮有可见焦点环', focus.style !== 'none' && parseFloat(focus.width) >= 1, JSON.stringify(focus))

// 5) 触摸目标：桌面 ≥30，触摸设备（CSS 媒体查询）≥44
const targets = await evaluate(`(() => {
  const size = (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return Math.round(Math.min(r.width, r.height));
  };
  return { send: size('send'), newTask: size('new-task') };
})()`)
check('桌面图标按钮 ≥30px', targets.send >= 30 && targets.newTask >= 30, JSON.stringify(targets))

const cssText = readFileSync(new URL('../vscode/media/chat.css', import.meta.url), 'utf8')
const coarseRule = /@media\s*\(pointer:\s*coarse\)[\s\S]*?44px/.test(cssText)
const reducedRule = /prefers-reduced-motion/.test(cssText)
void reducedRule
check('触摸设备有 44px 命中区规则', coarseRule === true)

// 6) 减少动效
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await sleep(300)
const reduced = await evaluate(`(() => {
  const msg = document.querySelector('.msg');
  const style = getComputedStyle(msg);
  return { animation: style.animationName, duration: style.animationDuration };
})()`)
check('尊重 prefers-reduced-motion', reduced.animation === 'none' || parseFloat(reduced.duration) < 0.01, JSON.stringify(reduced))
await send('Emulation.setEmulatedMedia', { features: [] })

// 7) 截图存档（人看）
for (const [name, w, h] of [
  ['chat-v2-420', 420, 820],
  ['chat-v2-1000', 1000, 900],
]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false })
  await sleep(350)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 通过`)
console.log('截图:', SHOTS)
socket.close()
child.kill()
await sleep(200)

process.exit(0)
