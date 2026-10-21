import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-chat.mjs'
let code = readFileSync(path, 'utf8')

if (!code.includes('圆角至少 4px')) {
  const anchor = "check('没有横向溢出'"
  const insert = `const radiusCheck = await evaluate(\`(() => {
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
})()\`)
const radiusValues = Object.values(radiusCheck).filter((value) => typeof value === 'number')
check('圆角至少 4px（别太硬朗）', radiusValues.length >= 4 && Math.min(...radiusValues) >= 4, JSON.stringify(radiusCheck))

${anchor}`
  code = code.replace(anchor, insert)
  writeFileSync(path, code, 'utf8')
  console.log('ui-check-chat：加了圆角下限断言')
}
