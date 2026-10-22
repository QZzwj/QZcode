import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 量 SVG：真渲染器里取每段文字的屏幕位置，换算回 viewBox 坐标，
 * 检查「出界 / 互相重叠 / 字号过小」。注意不能用 getBBox（那是局部坐标，
 * g transform 之后会全部错位、报出一堆假重叠）。
 */

const chrome = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
].find((path) => existsSync(path))

if (!chrome) {
  console.log('没有可用的 Chromium/Edge，跳过')
  process.exit(0)
}

const svgDir = process.argv[2] ?? 'assets/readme'
if (!existsSync(svgDir)) {
  console.log('（没有 ' + svgDir + '，跳过 SVG 检查）')
  process.exit(0)
}
const files = readdirSync(svgDir).filter((name) => name.endsWith('.svg'))
let failures = 0

for (const name of files) {
  const file = join(process.cwd(), svgDir, name)
  const dir = mkdtempSync(join(tmpdir(), 'qz-svg-'))
  const port = 9600 + Math.floor(Math.random() * 200)
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(dir, 'profile')}`,
      '--window-size=1200,420',
      `file:///${file.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore', windowsHide: true },
  )

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let info = null
  for (let i = 0; i < 60 && !info; i++) {
    await sleep(200)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      info = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    } catch {
      /* 还没起来 */
    }
  }
  if (!info) {
    console.log(`✘ ${name}: 浏览器没起来`)
    browser.kill()
    continue
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
  await sleep(500)

  const report = await evaluate(`(() => {
    const svg = document.querySelector('svg');
    const vb = svg.viewBox.baseVal;
    const svgRect = svg.getBoundingClientRect();
    const scale = svgRect.width / vb.width;   // 屏幕像素 → viewBox 单位
    const toVb = (value, origin) => (value - origin) / scale;
    const texts = [...svg.querySelectorAll('text')].map((node) => {
      const r = node.getBoundingClientRect();
      return {
        text: node.textContent.trim().slice(0, 26),
        size: Number(node.getAttribute('font-size') || 0),
        x: Math.round(toVb(r.left, svgRect.left)),
        y: Math.round(toVb(r.top, svgRect.top)),
        right: Math.round(toVb(r.right, svgRect.left)),
        bottom: Math.round(toVb(r.bottom, svgRect.top)),
      };
    }).filter((t) => t.text);
    const overflow = texts.filter((t) => t.x < 4 || t.y < 4 || t.right > vb.width - 4 || t.bottom > vb.height - 4);
    const overlaps = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], b = texts[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
        if (ox > 3 && oy > 3) overlaps.push(a.text + ' ✕ ' + b.text + ' (' + ox + 'x' + oy + ')');
      }
    }
    const tiny = texts.filter((t) => t.size > 0 && t.size < 18);
    return { width: vb.width, height: vb.height, count: texts.length, overflow, overlaps, tiny };
  })()`)

  const bad = report.overflow.length + report.overlaps.length
  console.log(`${bad === 0 ? '✔' : '✘'} ${name}  ${report.width}×${report.height} · ${report.count} 段文字`)
  if (report.overflow.length) {
    failures += 1
    for (const item of report.overflow) console.log(`    出界: "${item.text}" x=${item.x} y=${item.y} right=${item.right} bottom=${item.bottom}`)
  }
  if (report.overlaps.length) {
    failures += 1
    for (const item of report.overlaps) console.log(`    重叠: ${item}`)
  }
  if (report.tiny.length) console.log(`    字号 <18: ${report.tiny.map((t) => `"${t.text}"(${t.size})`).join(', ')}`)

  socket.close()
  browser.kill()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* 浏览器还占着 profile 目录，忽略 */
  }
}

process.exit(failures === 0 ? 0 : 1)
