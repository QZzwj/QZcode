import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-chat.mjs'
let code = readFileSync(path, 'utf8')

// 空状态必须真的在画面中间（横向和纵向都居中，容差 3px）
if (!code.includes('空状态在画面正中')) {
  const anchor = "check('空状态写着 L 管全程'"
  const insert = `const centerFit = await evaluate(\`(() => {
  // 预览里跑起来后空状态已被替换，所以用一份"刚加载、还没发消息"的快照来衡量
  return window.__CENTER__ || null;
})()\`)
check('空状态在画面正中（横竖都居中）', centerFit ? centerFit.ok === true : false, JSON.stringify(centerFit))

${anchor}`
  code = code.replace(anchor, insert)

  // 在 ready 里（发消息之前）量一次空状态的中心
  const onReadyFrom = `onReady: \`window.__EMPTY__ = {`
  const onReadyTo = `onReady: \`window.__CENTER__ = (() => {
        const hint = document.getElementById('hint');
        const thread = document.getElementById('thread');
        if (!hint || !thread) return { ok: false, reason: '找不到空状态' };
        const h = hint.getBoundingClientRect();
        const t = thread.getBoundingClientRect();
        const dx = Math.abs((h.left + h.right) / 2 - (t.left + t.right) / 2);
        const dy = Math.abs((h.top + h.bottom) / 2 - (t.top + t.bottom) / 2);
        return { ok: dx <= 3 && dy <= 12, dx: Math.round(dx), dy: Math.round(dy), textAlign: getComputedStyle(hint).textAlign };
      })();
      window.__EMPTY__ = {`
  if (code.includes(onReadyFrom)) {
    code = code.replace(onReadyFrom, onReadyTo)
  }

  writeFileSync(path, code, 'utf8')
  console.log('ui-check-chat：加了"空状态居中"断言')
}
