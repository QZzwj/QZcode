import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { BrowserSession, browserAvailability, findBrowser, looksLikeWebProject } from '../src/browser.ts'
import { Toolbox, createTools } from '../src/tools.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>测试页</title>
<style>body{margin:0;font:16px/1.5 sans-serif}#box{padding:40px;text-align:center}</style></head>
<body><div id="box">
  <p id="score">0</p>
  <button id="go">加分</button>
  <p id="hint">待操作</p>
</div>
<script>
  let score = 0;
  let charging = false;
  const scoreNode = document.getElementById('score');
  const hintNode = document.getElementById('hint');
  document.getElementById('go').addEventListener('click', () => { score += 1; scoreNode.textContent = String(score); });
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !charging) { charging = true; hintNode.textContent = '蓄力中'; }
  });
  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space' && charging) { charging = false; score += 1; scoreNode.textContent = String(score); hintNode.textContent = '已松开'; }
  });
  window.addEventListener('pointerdown', () => { hintNode.textContent = '按住中'; });
  window.addEventListener('pointerup', () => { hintNode.textContent = '松开了'; });
</script></body></html>`

test('findBrowser：这台机器上能找到 Chromium（找不到就跳过后续实测）', (t) => {
  const found = findBrowser()
  if (!found) {
    t.skip('这台机器没有 Chromium，跳过浏览器实测')
    return
  }
  assert.ok(existsSync(found.path), '返回的路径要真的存在')
  assert.match(found.source, /playwright|system|config/)
})

test('looksLikeWebProject：只对根目录里的 html 认账', () => {
  const dir = tempWorkspace('web-project')
  try {
    assert.equal(looksLikeWebProject(dir), false)
    writeFileSync(join(dir, 'index.html'), '<!doctype html>', 'utf8')
    assert.equal(looksLikeWebProject(dir), true)
  } finally {
    removeDir(dir)
  }
})

test('浏览器实测：打开页面、点按钮、按住空格、改视口、截图、查溢出', async (t) => {
  const found = findBrowser()
  if (!found) {
    t.skip('这台机器没有 Chromium')
    return
  }
  const dir = tempWorkspace('browser-live')
  const session = new BrowserSession()
  try {
    const file = join(dir, 'index.html')
    writeFileSync(file, PAGE, 'utf8')

    const opened = await session.open({ target: file, width: 800, height: 600 })
    assert.match(opened.title, /测试页/, '要读到页面标题')
    assert.equal(await session.evaluate("document.getElementById('score').textContent"), '0')

    // 真点按钮
    await session.evaluate("document.getElementById('go').click()")
    assert.equal(await session.evaluate("document.getElementById('score').textContent"), '1', 'click 后分数要变')

    // 按住再松开：松开才算一次
    await session.evaluate("document.getElementById('go').click()")
    await session.hold(500, { key: 'Space' })
    assert.equal(await session.evaluate("document.getElementById('score').textContent"), '3', '按住+松开要加一次')
    assert.equal(await session.evaluate("document.getElementById('hint').textContent"), '已松开')

    // 视口 + 横向溢出检查
    await session.setViewport(390, 844, true)
    const layout = (await session.evaluate(
      'JSON.stringify({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })',
    )) as string
    const parsed = JSON.parse(layout) as { sw: number; iw: number }
    assert.ok(parsed.sw <= parsed.iw + 1, `不该横向溢出：${layout}`)

    // 截图落到工作区
    const shot = await session.screenshot('probe', join(dir, '.qzcode', 'shots'))
    assert.ok(existsSync(shot), '截图文件要真的写出来')
  } finally {
    session.close()
    removeDir(dir)
  }
})

test('browser 工具：status 能用，并且是 readOnly（C 拿得到）', async () => {
  const dir = tempWorkspace('browser-tool')
  try {
    const toolbox = new Toolbox(createTools())
    const tools = createTools().find((tool) => tool.name === 'browser')
    assert.ok(tools, '要有 browser 工具')
    assert.equal(tools.readOnly, true, '只读：C 才能拿到')

    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 1000 } }
    const result = await toolbox.call('browser', JSON.stringify({ action: 'status' }), runtime)
    assert.equal(result.ok, true)
    assert.match(result.output, /浏览器|Chromium/)
  } finally {
    removeDir(dir)
  }
})
