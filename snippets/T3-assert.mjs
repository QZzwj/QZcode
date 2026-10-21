import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-chat.mjs'
let code = readFileSync(path, 'utf8')

// 1) 让事件晚点回放，好测"还没回复"的那一段
code = code.replace(
  `  stub: vscodeStub({
    init: {`,
  `  stub: vscodeStub({
    startDelayMs: 1100,
    init: {`,
)

// 2) ready 时抓一份"思考中"的快照
if (!code.includes('正在思考中')) {
  const from = `      window.__EMPTY__ = {`
  const to = `      setTimeout(() => {
        const thinking = document.getElementById('thinking');
        window.__THINKING__ = thinking
          ? { text: thinking.textContent.trim(), dots: thinking.querySelectorAll('.dots i').length }
          : null;
      }, 260);
      window.__EMPTY__ = {`
  if (code.includes(from)) code = code.replace(from, to)

  const anchor = "check('运行中有「已运行 XX」计时器'"
  const insert = `const thinkingState = await evaluate(\`(() => ({
  saved: window.__THINKING__ || null,
  now: Boolean(document.getElementById('thinking')),
}))()\`)
check('刚发出消息时显示"正在思考中"', thinkingState.saved !== null && /正在思考中/.test(thinkingState.saved.text), JSON.stringify(thinkingState.saved))
check('思考中带三个跳动的小点', (thinkingState.saved?.dots ?? 0) === 3, JSON.stringify({ dots: thinkingState.saved?.dots }))
check('收到回复后角标自动消失', thinkingState.now === false, JSON.stringify({ now: thinkingState.now }))

${anchor}`
  code = code.replace(anchor, insert)
  writeFileSync(path, code, 'utf8')
  console.log('ui-check-chat：加了"正在思考中"断言')
}
