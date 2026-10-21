import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-chat.mjs'
let code = readFileSync(path, 'utf8')

if (!code.includes('通过结论居中')) {
  const anchor = "check('阶段标签有通过/退回'"
  const insert = `const verdictUi = await evaluate(\`(() => {
  const row = document.querySelector('.verdict-row');
  const tag = document.querySelector('.tag.verdict');
  const thread = document.getElementById('thread').getBoundingClientRect();
  if (!row || !tag) return { found: false };
  const r = tag.getBoundingClientRect();
  const dx = Math.abs((r.left + r.right) / 2 - (thread.left + thread.right) / 2);
  return {
    found: true,
    text: tag.textContent.trim(),
    dx: Math.round(dx),
    centered: getComputedStyle(row).justifyContent,
    fontSize: parseFloat(getComputedStyle(tag).fontSize),
  };
})()\`)
check('通过结论居中显示', verdictUi.found === true && verdictUi.dx <= 3 && verdictUi.centered === 'center', JSON.stringify(verdictUi))

${anchor}`
  code = code.replace(anchor, insert)
  writeFileSync(path, code, 'utf8')
  console.log('ui-check-chat：加了"结论居中"断言')
}
