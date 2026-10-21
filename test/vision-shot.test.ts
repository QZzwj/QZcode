import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { browserAvailability, closeSharedBrowser } from '../src/browser.ts'
import { Toolbox, createTools } from '../src/tools.ts'
import { mockConfig, removeDir, tempWorkspace } from './helpers.ts'

/** 截图 + 视觉模型：接上 vision 回调后，截图输出里要带"看到的内容"。 */

async function makeToolbox(dir: string) {
  const toolbox = new Toolbox(createTools())
  return { toolbox, config: mockConfig(dir) }
}

test('截图接上视觉模型后，输出里带描述', async (t) => {
  const available = await browserAvailability()
  if (!available.ok) {
    t.skip('这台机器没有可用浏览器，跳过截图+视觉的集成测试')
    return
  }
  const dir = tempWorkspace('vision-shot')
  try {
    writeFileSync(join(dir, 'page.html'), '<h1 id="t">分数：0</h1><p>按住空格蓄力</p>', 'utf8')
    const { toolbox } = await makeToolbox(dir)

    const seen: string[] = []
    const runtime = {
      workspace: dir,
      exec: { enabled: true, timeoutMs: 20_000 },
      vision: async (file: string) => {
        seen.push(file)
        return { ok: true, description: '页面左上角写着"分数：0"，下面一行是"按住空格蓄力"' }
      },
    }

    await toolbox.call('browser', JSON.stringify({ action: 'open', target: 'page.html' }), runtime as never)
    const shot = await toolbox.call('browser', JSON.stringify({ action: 'screenshot', name: 'verify' }), runtime as never)

    assert.equal(shot.ok, true, shot.output)
    assert.equal(seen.length, 1, '截图应该正好触发一次看图')
    assert.match(shot.output, /截图已保存/)
    assert.match(shot.output, /\[视觉模型看到的内容\]/)
    assert.match(shot.output, /分数：0/, '描述要真的塞进工具输出，C 才看得到')
  } finally {
    await closeSharedBrowser()
    removeDir(dir)
  }
})

test('没开视觉模型时，截图行为保持原样', async (t) => {
  const available = await browserAvailability()
  if (!available.ok) {
    t.skip('这台机器没有可用浏览器，跳过截图+视觉的集成测试')
    return
  }
  const dir = tempWorkspace('vision-off')
  try {
    writeFileSync(join(dir, 'page.html'), '<h1>hi</h1>', 'utf8')
    const { toolbox } = await makeToolbox(dir)
    const runtime = { workspace: dir, exec: { enabled: true, timeoutMs: 20_000 } }

    await toolbox.call('browser', JSON.stringify({ action: 'open', target: 'page.html' }), runtime as never)
    const shot = await toolbox.call('browser', JSON.stringify({ action: 'screenshot' }), runtime as never)
    assert.equal(shot.ok, true, shot.output)
    assert.doesNotMatch(shot.output, /视觉模型/)
  } finally {
    await closeSharedBrowser()
    removeDir(dir)
  }
})

test('视觉模型看不成时，截图照样算成功并说明原因', async (t) => {
  const available = await browserAvailability()
  if (!available.ok) {
    t.skip('这台机器没有可用浏览器，跳过截图+视觉的集成测试')
    return
  }
  const dir = tempWorkspace('vision-fail')
  try {
    writeFileSync(join(dir, 'page.html'), '<h1>hi</h1>', 'utf8')
    const { toolbox } = await makeToolbox(dir)
    const runtime = {
      workspace: dir,
      exec: { enabled: true, timeoutMs: 20_000 },
      vision: async () => ({ ok: false, description: '', error: '接口超时' }),
    }

    await toolbox.call('browser', JSON.stringify({ action: 'open', target: 'page.html' }), runtime as never)
    const shot = await toolbox.call('browser', JSON.stringify({ action: 'screenshot' }), runtime as never)
    assert.equal(shot.ok, true, '看图失败不该让截图失败')
    assert.match(shot.output, /视觉模型没能看图：接口超时/)
  } finally {
    await closeSharedBrowser()
    removeDir(dir)
  }
})
