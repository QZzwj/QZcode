import { readFileSync, writeFileSync } from 'node:fs'

// UI 验收：点保存 → 先"保存中…"，收到结果 → 变成结论（成功/失败）
{
  const path = 'scripts/ui-check-settings.mjs'
  let code = readFileSync(path, 'utf8')

  if (!code.includes('视觉保存按钮不会卡住')) {
    const anchor = "check('视觉开关默认关闭、设置区收起'"
    const insert = `// 点保存：先"保存中…"，再收到结果
await evaluate(\`document.getElementById('vision-save').click()\`)
await sleep(150)
const savingText = await evaluate(\`(document.getElementById('vision-status').textContent || '').trim()\`)
check('点保存先显示"保存中…"', /保存中/.test(savingText), savingText.slice(0, 30))

await evaluate(\`window.postMessage({ type: 'visionSaved', result: { ok: true, ready: true, vision: { enabled: true, model: 'gpt-4o' } } }, '*')\`)
await sleep(200)
const savedText = await evaluate(\`(() => ({
  text: (document.getElementById('vision-status').textContent || '').trim(),
  ok: document.getElementById('vision-status').className.includes('ok'),
}))()\`)
check('收到结果后按钮不再是"保存中"（不会卡死）', !/保存中/.test(savedText.text) && savedText.ok === true, JSON.stringify(savedText))

${anchor}`
    code = code.replace(anchor, insert)
    writeFileSync(path, code, 'utf8')
    console.log('ui-check-settings：加了视觉保存不卡死断言')
  }
}
