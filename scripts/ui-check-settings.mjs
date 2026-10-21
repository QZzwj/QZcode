import { spawn } from 'node:child_process'
import { buildPreviewPage, vscodeStub } from './preview-page.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 设置面板验收：同一套规则（对比度 / 焦点 / 触摸 / 溢出 / 三页签渲染）。 */

const PAGE = buildPreviewPage({ kind: 'settings', name: 'settings', stub: vscodeStub({
    init: { providers: { providers: [], current: { provider: 'ghd', model: 'cn:auto', mock: false } } },
    events: [],
    onReady: `
      const role = (name, title, model) => ({
        role: name, title, provider: 'ghd', baseUrl: 'http://8.134.108.99:7863/v1', model,
        hasKey: true, keyHint: 'sk-5…d672', hasKeyForProvider: true, temperature: 0.3,
        maxTokens: 16384, headers: {}, timeoutMs: 180000, retries: 2, mock: false, custom: true, skills: [],
      });
      window.postMessage({ type: 'state', state: {
        roles: [
          role('leader', 'L · 调度（分流，省 token）', 'gpt-6.1-sol'),
          role('planner', 'A · 规划（prompt + guidance）', 'gpt-6.1-sol'),
          role('implementer', 'B · 实现（tools）', 'cn:deepseek-v4.1-flash'),
          role('verifier', 'C · 核验（read-only + tests）', 'cn:deepseek-v4.1-flash'),
        ],
        providers: [],
        catalog: [
          { id: 'hhd', label: 'hhd', name: 'hhd', site: 'ruoli.dev', baseUrl: 'https://ruoli.dev/v1', model: 'gpt-6.1-sol', needsRoute: false, current: false },
          { id: 'deepseek', label: 'DeepSeek · platform.deepseek.com', name: 'DeepSeek', site: 'platform.deepseek.com', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsRoute: false, current: false },
          { id: 'ant-ling', label: 'BaiLing · developer.ant-ling.com', name: 'BaiLing', site: 'developer.ant-ling.com', baseUrl: '', model: '', needsRoute: true, current: false },
          { id: 'kimi', label: 'Kimi · platform.kimi.com · 4 个版本', name: 'Kimi', site: 'platform.kimi.com', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-turbo-preview', needsRoute: false, current: false },
        ],
        vision: {
          enabled: false, provider: '', baseUrl: '', model: '', apiKey: '',
          maxTokens: 500, timeoutMs: 60000, maxImages: 8, question: '请客观描述这张截图',
        },
        configPath: 'C:\\Users\\jn\\qzcode.json',
        workspace: 'D:\\hhd\\demo',
      } }, '*');
      window.postMessage({ type: 'skills', catalog: [
        { name: 'code-implementer', title: '实现纪律（B）', roles: ['implementer'], source: 'builtin', description: '先读再改' },
        { name: 'verified-delivery', title: '核验纪律（C）', roles: ['verifier'], source: 'builtin' },
        { name: 'prompt-writer', title: '任务书写作（L/A）', roles: ['leader', 'planner'], source: 'builtin' },
        { name: 'gpt6-prompt-writer', title: 'gpt6 原版', roles: ['leader', 'planner'], source: 'user' },
      ] }, '*');
      setTimeout(() => window.postMessage({
        type: 'tested', role: 'planner',
        result: { ok: true, ms: 1683, model: 'gpt-6.1-sol', models: new Array(56).fill({ id: 'x' }) },
      }, '*'), 60);
    `,
  }) })
const SHOTS = join(tmpdir(), 'qz-ui-shots')
mkdirSync(SHOTS, { recursive: true })

const chrome = [
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((item) => existsSync(item))

const port = 9488
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(tmpdir(), `qz-set-${Date.now()}`)}`,
    '--window-size=1200,900',
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
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' · ' + detail : ''}`)
}

await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(900)

// 1) 模型页：四张卡、每张有状态行、反馈落在 planner 卡
const models = await evaluate(`(() => {
  const cards = document.getElementById('cards');
  const statuses = [...cards.querySelectorAll('.card-status')];
  return {
    cards: cards.children.length,
    statuses: statuses.length,
    plannerStatus: statuses[1]?.textContent ?? '',
    plannerOk: statuses[1]?.className.includes('ok') ?? false,
    badges: [...cards.querySelectorAll('.badge')].map((n) => getComputedStyle(n).backgroundColor),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    tabs: document.querySelectorAll('.tab').length,
  };
})()`)
const visionUi = await evaluate(`(() => {
  const boxes = document.querySelectorAll('.vision-box');
  const card = boxes[0] ? boxes[0].closest('.card') : null;
  const title = card ? (card.querySelector('.card-title') || {}).textContent : '';
  const enabled = document.getElementById('vision-enabled');
  const body = document.querySelector('.vision-body');
  const model = document.getElementById('vision-model');
  return {
    count: boxes.length,
    title,
    hasToggle: Boolean(enabled),
    checked: enabled ? enabled.checked : null,
    bodyHidden: body ? body.hidden : null,
    modelPlaceholder: model ? model.placeholder : '',
  };
})()`)
const providerSelect = await evaluate(`(() => {
  const select = document.querySelector('.card select');
  if (!select) return null;
  const options = [...select.children].filter((n) => n.tagName === 'OPTION');
  const groups = [...select.children].filter((n) => n.tagName === 'OPTGROUP');
  return {
    labels: options.map((n) => n.textContent),
    groups: groups.length,
    customCount: options.filter((n) => n.textContent.includes('自定义')).length,
    hasDeepseek: options.some((n) => n.textContent.startsWith('DeepSeek · platform.deepseek.com')),
    hasVersions: options.some((n) => /4 个版本/.test(n.textContent)),
  };
})()`)
check('供应商是平铺列表（不再分组）', providerSelect.groups === 0, JSON.stringify({ groups: providerSelect.groups }))
check('列表里是平台清单（DeepSeek · 站点 这种）', providerSelect.hasDeepseek === true, JSON.stringify(providerSelect.labels.slice(0, 3)))
check('多入口平台标出"N 个版本"', providerSelect.hasVersions === true)
check('「自定义」只出现一次', providerSelect.customCount === 1, JSON.stringify({ custom: providerSelect.customCount }))

check('C 的卡片里有视觉设置块（其他角色没有）', visionUi.count === 1, JSON.stringify({ count: visionUi.count, title: visionUi.title }))
// 点保存：先"保存中…"，再收到结果
await evaluate(`document.getElementById('vision-save').click()`)
await sleep(150)
const savingText = await evaluate(`(document.getElementById('vision-status').textContent || '').trim()`)
check('点保存先显示"保存中…"', /保存中/.test(savingText), savingText.slice(0, 30))

await evaluate(`window.postMessage({ type: 'visionSaved', result: { ok: true, ready: true, vision: { enabled: true, model: 'gpt-4o' } } }, '*')`)
await sleep(200)
const savedText = await evaluate(`(() => ({
  text: (document.getElementById('vision-status').textContent || '').trim(),
  ok: document.getElementById('vision-status').className.includes('ok'),
}))()`)
check('收到结果后按钮不再是"保存中"（不会卡死）', !/保存中/.test(savedText.text) && savedText.ok === true, JSON.stringify(savedText))

check('视觉开关默认关闭、设置区收起', visionUi.checked === false && visionUi.bodyHidden === true)
check('视觉模型输入框提示要看图模型', /gpt-4o|qwen-vl|glm-4v/i.test(visionUi.modelPlaceholder ?? ''), visionUi.modelPlaceholder)

check('四张角色卡', models.cards === 4, String(models.cards))
check('每卡都有状态行', models.statuses === 4)
check('测试反馈落在 A 卡且标绿', /连接正常/.test(models.plannerStatus) && models.plannerOk, models.plannerStatus)
check('角色徽标四种颜色', new Set(models.badges).size >= 4, models.badges.length + ' 个')
check('三个页签', models.tabs === 3)
check('模型页没有横向溢出', models.overflowX === false)

// 2) 技能页
await evaluate("document.querySelector('[data-tab=\"skills\"]').click()")
await sleep(400)
const skills = await evaluate(`(() => {
  const table = document.getElementById('skills-table');
  const rows = [...table.querySelectorAll('.skill-row')];
  return {
    rows: rows.length,
    head: rows[0]?.textContent.includes('技能') ?? false,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    visible: !document.getElementById('tab-skills').hidden,
  };
})()`)
check('技能表渲染（表头 + 4 行）', skills.rows === 5 && skills.head === true, `rows=${skills.rows}`)
check('技能页可见且不溢出', skills.visible === true && skills.overflowX === false)

// 3) 成本页
await evaluate("document.querySelector('[data-tab=\"cost\"]').click()")
await sleep(300)
await evaluate(`window.postMessage({ type: 'cost', data: {
  currency: 'CNY', today: 0.0424, total: 1.2399, runs: 12, budget: 1, remaining: 0.9576,
  overBudget: false, byRole: { planner: 0.0212, implementer: 0.0138, verifier: 0.0076 },
  recent: [{ goal: '做一个跳一跳小游戏', total: 0.0132, tokens: 6997 }],
  avgTokPerSec: 42.3, maxTokPerSec: 68.1, avgRunMs: 4211, speedSamples: 3,
  steps: [
    { role: 'leader', calls: 2, ms: 900, prompt: 800, completion: 120, tokPerSec: 133.3, maxTokPerSec: 180.4, msPerCall: 450 },
    { role: 'planner', calls: 3, ms: 12400, prompt: 24000, completion: 2100, tokPerSec: 169.4, maxTokPerSec: 212.0, msPerCall: 4133 },
    { role: 'implementer', calls: 9, ms: 96000, prompt: 310000, completion: 8200, tokPerSec: 85.4, maxTokPerSec: 143.1, msPerCall: 10666 },
    { role: 'verifier', calls: 4, ms: 21000, prompt: 41000, completion: 1400, tokPerSec: 66.7, maxTokPerSec: 98.2, msPerCall: 5250 },
  ],
} }, '*')`)
await sleep(400)
const cost = await evaluate(`(() => ({
  today: document.querySelector('.cost-today')?.textContent ?? '',
  speed: document.querySelector('.cost-speed')?.textContent ?? '',
  bar: !!document.querySelector('.cost-fill'),
  overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
}))()`)
check('成本页显示今日金额', /¥0\.0424/.test(cost.today), cost.today)
const stepTable = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.step-table .step-row')];
  const body = rows.slice(1);
  return {
    rows: body.length,
    names: body.map((row) => row.querySelector('.step-name').textContent),
    best: body.map((row) => row.querySelector('.step-best').textContent),
    duration: body.map((row) => row.querySelectorAll('.step-num')[2].textContent),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
})()`)
check('步骤表有表头（步骤/最快/平均/用时/调用）', await evaluate("document.querySelectorAll('.step-table .step-head .step-num').length === 4 && /步骤/.test(document.querySelector('.step-table .step-head').textContent)"))
// 1) 点成本 → 立刻出现"正在读取"
await evaluate(`document.querySelector('[data-tab="models"]').click()`)
await sleep(200)
await evaluate(`document.querySelector('[data-tab="cost"]').click()`)
await sleep(120)
const loadingText = await evaluate(`(document.getElementById('cost-summary').textContent || '').trim()`)
check('点成本先显示"正在读取"（不会空白发呆）', /正在读取/.test(loadingText), loadingText.slice(0, 40))

// 2) 后端报错 → 显示原因 + 重试按钮
await evaluate(`window.postMessage({ type: 'cost', data: null, error: '连接被拒绝' }, '*')`)
await sleep(150)
const errorState = await evaluate(`(() => ({
  text: (document.getElementById('cost-summary').textContent || '').trim(),
  retry: Boolean([...document.querySelectorAll('#cost-summary .link')].find((n) => n.textContent.includes('重试'))),
}))()`)
check('成本读取失败时说明原因并给重试', /连接被拒绝/.test(errorState.text) && errorState.retry === true, JSON.stringify(errorState))

// 3) 恢复：正常数据还能渲染
await evaluate(`window.postMessage({ type: 'cost', data: { currency: 'CNY', today: 0.04, total: 1.2, runs: 3, budget: 1, remaining: 0.96, overBudget: false, byRole: {}, recent: [], steps: [] } }, '*')`)
await sleep(200)

check('成本页按步骤列出速度与耗时', stepTable.rows === 4, JSON.stringify(stepTable.names))
check('每一步都有最快速度', stepTable.best.join(',') === '180.4,212.0,143.1,98.2', stepTable.best.join(','))
check('久的时间显示成 1m36s 这种', stepTable.duration[2] === '1m36s', stepTable.duration.join(','))
check('步骤表不横向溢出', stepTable.overflowX === false)

check('有预算进度条且不溢出', cost.bar === true && cost.overflowX === false)

// 4) 对比度 / 焦点 / 触摸（同一套规则）
// 切回模型页，保证输入框/按钮可见
await evaluate("document.querySelector('.tab[data-tab=\"models\"]').click()")
await sleep(400)
const a11y = await evaluate(`(() => {
  const parse = (color) => {
    const m = color.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (node) => {
    let cur = node;
    while (cur) {
      const bg = parse(getComputedStyle(cur).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
      cur = cur.parentElement;
    }
    return { r: 30, g: 33, b: 38, a: 1 };
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
  const out = {};
  const pick = {
    'field-hint': document.querySelector('.field-hint'),
    'card-role': document.querySelector('.card-role'),
    'tab': document.querySelector('.tab'),
    'dim': document.querySelector('.dim'),
  };
  for (const [k, node] of Object.entries(pick)) {
    out[k] = node ? Math.round(ratio(parse(getComputedStyle(node).color), bgOf(node)) * 100) / 100 : null;
  }
  const visible = (nodes) => nodes.find((n) => n.getBoundingClientRect().height > 0);
  const btn = visible([...document.querySelectorAll('button.primary')]) || visible([...document.querySelectorAll('button')]);
  btn.focus();
  const st = getComputedStyle(btn);
  out.focus = { style: st.outlineStyle, width: st.outlineWidth, label: (btn.textContent || '').trim().slice(0, 8) };
  const input = visible([...document.querySelectorAll('input[type=text], input[type=password], input[type=number]')]);
  out.sizes = {
    primary: Math.round(btn.getBoundingClientRect().height),
    input: input ? Math.round(input.getBoundingClientRect().height) : 0,
  };
  return out;
})()`)
for (const key of ['field-hint', 'card-role', 'tab', 'dim']) {
  check(`设置页 ${key} 对比度 ≥4.5`, typeof a11y[key] === 'number' && a11y[key] >= 4.5, String(a11y[key]))
}
check('设置页按钮有焦点环', a11y.focus.style !== 'none' && parseFloat(a11y.focus.width) >= 1, JSON.stringify(a11y.focus))
check('设置页控件高度合理', a11y.sizes.primary >= 26 && a11y.sizes.input >= 26, JSON.stringify(a11y.sizes))

const css = readFileSync(new URL('../vscode/media/settings.css', import.meta.url), 'utf8')
check('设置页有 44px 触摸规则', /@media\s*\(pointer:\s*coarse\)[\s\S]*?44px/.test(css))
check('设置页尊重 reduced-motion', /prefers-reduced-motion/.test(css))

// 截图
await evaluate("document.querySelector('[data-tab=\"models\"]').click()")
await sleep(400)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(SHOTS, 'settings-v2.png'), Buffer.from(shot.data, 'base64'))

console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`)
socket.close()
child.kill()
await sleep(200)

process.exit(0)
