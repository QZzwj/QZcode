import { readFileSync, writeFileSync } from 'node:fs'

const done = []

// ---------------------------------------------------------------- 详情页
{
  const path = 'vscode/README.md'
  let code = readFileSync(path, 'utf8')

  const from = `\`\`\`
L 管全程（派活 · 盯进度 · 打回返工）
   └→ A 写任务书（提示词 + 验收标准）
        └→ B 带工具实现（读/写/改文件、跑命令；本机有 Chrome/Edge 时还能开浏览器验证）
             └→ C 只读核验（跑测试、看截图、给结论）
                  └→ 不通过就退回 A 重写任务书，最多 3 轮
\`\`\``

  const to = `\`\`\`
L   判断这一轮怎么走（走完整流水线 / 直接回答 / 追问）
      └→ A 写任务书（提示词 + 验收标准）
           └→ B 带工具实现（读/写/改文件、跑命令；本机有 Chrome/Edge 时还能开浏览器验证）
                └→ A 复核 B 的产出，跑偏就退回重做
                     └→ C 只读核验（跑测试、看截图、给结论）
                          └→ 不通过就退回 A 重写任务书，最多 3 轮
\`\`\``

  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('流程图改成真实分工（复核是 A，L 只分流）')
  } else {
    console.log('⚠ 流程图锚点没匹配')
  }

  // 插件例子：安装包里没有，别让人以为自带
  const pluginFrom = '自带两个例子：一个会拦住 `rm -rf` 这类命令、把 `API_KEY=` 打码，并给模型多一个 `count_lines` 工具。'
  const pluginTo =
    '（两个示例插件 `pi-style-extension.ts` / `example-plugin.ts` 只放在 GitHub 仓库里，不随安装包分发——想要就照仓库里的写法抄一份到自己的 `plugins/`。）'
  if (code.includes(pluginFrom)) {
    code = code.replace(pluginFrom, pluginTo)
    done.push('插件例子说清"不在包里"')
  }

  writeFileSync(path, code, 'utf8')
}

// ---------------------------------------------------------------- 仓库 README 对齐
{
  const path = 'README.md'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    'L 管全程 → A 写任务书 → B 实现 → C 核验 → （不通过退回 A 重写，最多 3 轮）',
    'L 分流 → A 写任务书 → B 实现 → A 复核 → C 核验 → （不通过退回 A 重写，最多 3 轮）',
  )
  code = code.replace(
    '四个模型接力把一句话目标做成可交付的改动：',
    '四个模型接力把一句话目标做成可交付的改动（L 负责判断这一轮怎么走，A 写任务书并复核 B 的产出，C 独立核验）：',
  )
  writeFileSync(path, code, 'utf8')
  done.push('仓库 README 分工描述')
}

// ---------------------------------------------------------------- 发布说明也改
{
  const path = 'release-notes-3.6.0.md'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    'L 管全程（派活 · 盯进度 · 打回返工）',
    'L   判断这一轮怎么走（走完整流水线 / 直接回答 / 追问）',
  )
  writeFileSync(path, code, 'utf8')
}

console.log(done.join(' / ') || '(无改动)')
