import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/README.md'
let code = readFileSync(path, 'utf8')

// 把 ASCII 示意图换成真图（市场不渲染 SVG，所以引用 PNG）
const from = `\`\`\`
┌ QZ 接力 ──────────────── D:\\work\\demo ┐
│  A 写好了，B 去做                       │   ← 模型输出（markdown）
│  → write OK 96ms index.html            │   ← 工具调用压成一行
│  ▸ 修改 index.html +42 −0   展开        │   ← 文件改动，点开看 diff
│                                        │
│  ✔ 通过                                │   ← 结论单独一行、居中
│                                        │
│ ┌────────────────────────────────────┐ │
│ │ 描述你想完成的事…（可用 @文件）     │ │
│ │ (•) deepseek·deepseek-chat  ▤ ＋ ↑  │ │
│ └────────────────────────────────────┘ │
│ ☐ 先看任务书   ☐ 每次改动自动 git 提交 │
│                          已运行 12.3s  │
└────────────────────────────────────────┘
\`\`\``

const to = `![QZcode 侧栏](media/readme/sidebar.png)

*A 的结论、B 的工具调用与文件改动、结论条、输入框、两个开关——都在一个侧栏里。*`

if (code.includes(from)) {
  code = code.replace(from, to)
  writeFileSync(path, code, 'utf8')
  console.log('详情页：ASCII 换成 sidebar.png')
} else {
  console.log('⚠ ASCII 图锚点没匹配，看看是不是换行/转义不同')
}

// 顺手确认引用路径和文件都在
const check = readFileSync(path, 'utf8')
console.log('  引用:', /!\[QZcode 侧栏\]\(media\/readme\/sidebar\.png\)/.test(check) ? '✔ 已写入' : '✘ 没写进去')
console.log('  还有 ASCII 边框吗:', /┌ QZ 接力/.test(check) ? '✘ 还在' : '✔ 已删除')
