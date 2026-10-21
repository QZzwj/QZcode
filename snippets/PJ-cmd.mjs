import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/extension.cjs'
const lines = readFileSync(path, 'utf8').split('\n')

const index = lines.findIndex((line) => line.includes("registerCommand('qzcode.showDiff'"))
if (index < 0) throw new Error('showDiff 注册行没找到')
if (!lines.some((line) => line.includes("registerCommand('qzcode.openRunLog'"))) {
  lines.splice(index, 0, "    vscode.commands.registerCommand('qzcode.openRunLog', (pathArg) => openRunLog(pathArg)),")
  writeFileSync(path, lines.join('\n'), 'utf8')
  console.log('extension.cjs：注册 openRunLog 命令')
}
