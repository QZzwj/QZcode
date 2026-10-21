import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/web/server.ts'
let code = readFileSync(path, 'utf8')

// RunResult 没有 touched 字段；改动数从快照索引取
code = code.replace(
  `            touched: result.touched ?? run.snapshot?.entries.length,`,
  `            touched: run.snapshot?.entries.length ?? 0,`,
)

writeFileSync(path, code, 'utf8')
console.log('server.ts：改动数改用快照索引')
