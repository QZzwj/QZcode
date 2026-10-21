import { readFileSync, writeFileSync } from 'node:fs'

const path = 'test/runlog.test.ts'
let code = readFileSync(path, 'utf8')

// 1) 结论那行不是列表项，断言别带 "- "
code = code.replace("assert.match(markdown, /- 结论：通过/)", "assert.match(markdown, /结论：通过/)")

// 2) ESM 里没有 require，用已导入的 mkdirSync
code = code.replace("import { existsSync, readFileSync, writeFileSync } from 'node:fs'", "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'")
code = code.replace("    require('node:fs').mkdirSync(logDir, { recursive: true })", "    mkdirSync(logDir, { recursive: true })")

writeFileSync(path, code, 'utf8')
console.log('测试修正：结论断言 / mkdirSync')
