import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/CHANGELOG.md'
let code = readFileSync(path, 'utf8')

const entry = `## 3.6.x

- **3.6.0** **不再需要机器上装 Node**：本地服务改用 VS Code 自带的运行时（Electron + \`ELECTRON_RUN_AS_NODE=1\`）启动，装好即用。\`qzcode.nodePath\` 默认留空 = 用自带运行时，填了才用外部 node。体检里也会标出"来自 VS Code 自带运行时"。

`

if (!code.includes('## 3.6.x')) {
  code = code.replace('## 3.5.x', entry + '## 3.5.x')
  writeFileSync(path, code, 'utf8')
  console.log('CHANGELOG 加了 3.6.0')
}
