import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/package.json'
const pkg = JSON.parse(readFileSync(path, 'utf8'))

// 市场列表这一行：只说能核实的
pkg.description =
  '四角色接力做代码改动：L 管全程 → A 写任务书 → B 带工具实现 → C 只读核验，不通过退回 A 重写，最多 3 轮。自带后端，不需要装 Node；填一次模型 key 即可在侧栏运行。'

writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log('描述:', pkg.description)
console.log('长度:', pkg.description.length, '字符（市场列表一行展示，太长会被截）')
