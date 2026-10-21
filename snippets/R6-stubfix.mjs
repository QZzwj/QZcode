import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-reconnect.mjs'
let code = readFileSync(path, 'utf8')

// 桩里 POST /api/run 和 GET /api/run?id= 是同一个路径，要分开：
// 只有带 ?id= 的才是"查运行状态"，其余当成"创建运行"，返回 runId
code = code.replace(
  `      if (String(url).includes('/api/run')) {`,
  `      if (String(url).includes('/api/run?id=')) {`,
)

writeFileSync(path, code, 'utf8')
console.log('桩：区分创建运行与查询状态')
