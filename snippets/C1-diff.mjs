import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-chat.mjs'
const lines = readFileSync(path, 'utf8').split('\n')

const index = lines.findIndex((line) => line.includes("check('diff 块能展开且有 +/− 配色'"))
if (index < 0) throw new Error('没找到 diff 配色断言')

// 新配色：新增 #4ec9a5 → rgb(78,201,165)；删除 #f2705f → rgb(242,112,95)
lines[index] =
  "check('diff 块能展开且有 +/− 配色', patchUi.expanded === true && /78,\\s*201,\\s*165/.test(patchUi.addColor ?? '') && /242,\\s*112,\\s*95/.test(patchUi.delColor ?? ''), JSON.stringify({ add: patchUi.addColor, del: patchUi.delColor }))"

writeFileSync(path, lines.join('\n'), 'utf8')
console.log('diff 配色断言已更新为新配色')
