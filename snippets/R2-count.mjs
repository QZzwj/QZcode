import { readFileSync, writeFileSync } from 'node:fs'

const path = 'test/vscode.test.ts'
let code = readFileSync(path, 'utf8')

// 命令数从 14 → 15（新增"打开运行记录"）
code = code.replace('assert.equal(commands.length, 14)', 'assert.equal(commands.length, 15)')
code = code.replace(
  "assert.equal(manifest.contributes.commands.length, 14)",
  'assert.equal(manifest.contributes.commands.length, 15)',
)

writeFileSync(path, code, 'utf8')
console.log('vscode.test：命令数改成 15')
