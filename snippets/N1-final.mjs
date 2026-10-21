import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/README.md'
let code = readFileSync(path, 'utf8')
const from = '- 需要机器上装 Node。扩展本身没有构建步骤，装完直接用。'
const to = '- 需要机器上装 Node；装好后不需要任何额外安装或配置就能用。'
if (code.includes(from)) {
  code = code.replace(from, to)
  writeFileSync(path, code, 'utf8')
  console.log('改掉了最后一处"构建"')
} else {
  console.log('⚠ 没匹配到')
}

// 复查：不能残留打包/编译/调试说明
const banned = ['vsce', 'bundle:backend', 'npm run', 'extensionDevelopmentPath', '构建', '编译']
const hits = banned.filter((word) => code.includes(word))
console.log('残留的构建类词:', hits.length === 0 ? '（无）' : hits.join(', '))
