import { readFileSync, writeFileSync } from 'node:fs'

// 1) 空状态顶部加品牌行：QZ 加粗
{
  const path = 'vscode/pages.cjs'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('hint-brand')) {
    const from = `            <div class="hint-title">一句话目标，四个模型接力</div>`
    const to = `            <div class="hint-brand"><b>QZ</b>code</div>
            <div class="hint-title">一句话目标，四个模型接力</div>`
    if (!code.includes(from)) throw new Error('hint-title 锚点没找到')
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('pages.cjs：空状态顶部加了 QZcode 品牌行')
  }
}

// 2) 样式
{
  const path = 'vscode/media/chat.css'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('.hint-brand')) {
    const anchor = `.hint-title {`
    if (!code.includes(anchor)) throw new Error('hint-title 样式没找到')
    code = code.replace(
      anchor,
      `/* 品牌行：QZ 加粗，code 用常规字重 */
.hint-brand {
  margin-bottom: 6px;
  font-family: var(--qz-mono);
  font-size: 15px;
  letter-spacing: 0.02em;
  color: var(--qz-muted);
}

.hint-brand b {
  font-weight: 800;
  color: var(--qz-fg);
}

${anchor}`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('chat.css：加了 hint-brand 样式')
  }
}

// 3) UI 断言：品牌行存在且 QZ 更粗
{
  const path = 'scripts/ui-check-chat.mjs'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('品牌行')) {
    const anchor = "check('空状态写着 L 管全程'"
    const insert = `const brand = await evaluate(\`(() => {
  const node = document.querySelector('.hint-brand');
  if (!node) return { found: false };
  const bold = node.querySelector('b');
  return {
    found: true,
    text: node.textContent.trim(),
    boldWeight: bold ? Number(getComputedStyle(bold).fontWeight) : 0,
    normalWeight: Number(getComputedStyle(node).fontWeight),
  };
})()\`)
check('空状态顶部有 QZcode 品牌行，QZ 加粗', brand.found === true && /QZcode/.test(brand.text) && brand.boldWeight > brand.normalWeight, JSON.stringify(brand))

${anchor}`
    code = code.replace(anchor, insert)
    writeFileSync(path, code, 'utf8')
    console.log('ui-check-chat：加了品牌行断言')
  }
}
