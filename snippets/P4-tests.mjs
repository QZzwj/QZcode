import { readFileSync, writeFileSync } from 'node:fs'

// UI 验收：点"成本"要看到"正在读取"，超时给重试，报错给原因——不能空白
{
  const path = 'scripts/ui-check-settings.mjs'
  let code = readFileSync(path, 'utf8')

  if (!code.includes('成本页不会空白')) {
    const anchor = "check('成本页按步骤列出速度与耗时'"
    const insert = `// 1) 点成本 → 立刻出现"正在读取"
await evaluate(\`document.querySelector('[data-tab="models"]').click()\`)
await sleep(200)
await evaluate(\`document.querySelector('[data-tab="cost"]').click()\`)
await sleep(120)
const loadingText = await evaluate(\`(document.getElementById('cost-summary').textContent || '').trim()\`)
check('点成本先显示"正在读取"（不会空白发呆）', /正在读取/.test(loadingText), loadingText.slice(0, 40))

// 2) 后端报错 → 显示原因 + 重试按钮
await evaluate(\`window.postMessage({ type: 'cost', data: null, error: '连接被拒绝' }, '*')\`)
await sleep(150)
const errorState = await evaluate(\`(() => ({
  text: (document.getElementById('cost-summary').textContent || '').trim(),
  retry: Boolean([...document.querySelectorAll('#cost-summary .link')].find((n) => n.textContent.includes('重试'))),
}))()\`)
check('成本读取失败时说明原因并给重试', /连接被拒绝/.test(errorState.text) && errorState.retry === true, JSON.stringify(errorState))

// 3) 恢复：正常数据还能渲染
await evaluate(\`window.postMessage({ type: 'cost', data: { currency: 'CNY', today: 0.04, total: 1.2, runs: 3, budget: 1, remaining: 0.96, overBudget: false, byRole: {}, recent: [], steps: [] } }, '*')\`)
await sleep(200)

${anchor}`
    code = code.replace(anchor, insert)
    writeFileSync(path, code, 'utf8')
    console.log('ui-check-settings：加了成本页健壮性断言')
  }
}

// 单测：后端 /api/roles 必须带 catalog（下拉清单不能为空）
{
  const path = 'test/providers-list.test.ts'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('catalog 一定要跟着 roles 一起返回')) {
    code += `
test('catalog 一定要跟着 roles 一起返回（否则设置面板的供应商下拉是空的）', async () => {
  const { listRoles } = await import('../src/providers.ts')
  const dir = tempWorkspace('providers-catalog-in-roles')
  try {
    const config = mockConfig(dir)
    const state = listRoles(config) as { catalog?: unknown[] }
    assert.ok(Array.isArray(state.catalog), 'listRoles 要返回 catalog')
    assert.ok((state.catalog ?? []).length > 5, '清单里应该有多个平台可选')
  } finally {
    removeDir(dir)
  }
})
`
    writeFileSync(path, code, 'utf8')
    console.log('providers-list.test：加 catalog 断言')
  }
}
