import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-chat.mjs'
let code = readFileSync(path, 'utf8')

// 空状态在跑起来后就被替换了：品牌行也要在 ready 那一刻一起抓
const from = `      window.__EMPTY__ = {
        flow: (document.querySelector('.empty-flow') || {}).textContent || '',
        chain: (document.querySelector('.empty-chain') || {}).textContent || '',
        items: document.querySelectorAll('.empty-chain .flow-item').length,
      };`
const to = `      window.__EMPTY__ = (() => {
        const brandNode = document.querySelector('.hint-brand');
        const bold = brandNode ? brandNode.querySelector('b') : null;
        return {
          flow: (document.querySelector('.empty-flow') || {}).textContent || '',
          chain: (document.querySelector('.empty-chain') || {}).textContent || '',
          items: document.querySelectorAll('.empty-chain .flow-item').length,
          brand: brandNode ? brandNode.textContent.trim() : '',
          brandBold: bold ? Number(getComputedStyle(bold).fontWeight) : 0,
          brandNormal: brandNode ? Number(getComputedStyle(brandNode).fontWeight) : 0,
        };
      })();`

if (code.includes(from)) {
  code = code.replace(from, to)
  console.log('checker：ready 时一并抓品牌行')
}

// 断言改成读快照
const oldAssert = `const brand = await evaluate(\`(() => {
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
check('空状态顶部有 QZcode 品牌行，QZ 加粗', brand.found === true && /QZcode/.test(brand.text) && brand.boldWeight > brand.normalWeight, JSON.stringify(brand))`

const newAssert = `const brand = await evaluate(\`(() => {
  const saved = window.__EMPTY__ || {};
  return {
    text: saved.brand || '',
    boldWeight: saved.brandBold || 0,
    normalWeight: saved.brandNormal || 0,
  };
})()\`)
check('空状态顶部有 QZcode 品牌行，QZ 加粗', /QZcode/.test(brand.text) && brand.boldWeight > brand.normalWeight, JSON.stringify(brand))`

if (code.includes(oldAssert)) {
  code = code.replace(oldAssert, newAssert)
  console.log('checker：断言改读快照')
}

writeFileSync(path, code, 'utf8')
