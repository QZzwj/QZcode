import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/README.md'
let code = readFileSync(path, 'utf8')
const done = []

const pairs = [
  // 1) 流程图里"开浏览器验证"要写清前提（本机得真有 Chrome/Edge）
  [
    '└→ B 带工具实现（读/写/改文件、跑命令、开浏览器验证）',
    '└→ B 带工具实现（读/写/改文件、跑命令；本机有 Chrome/Edge 时还能开浏览器验证）',
  ],
  // 2) "装好就能用"要如实：没有 key 只能先看 mock
  [
    '装好就能用：**扩展自带后端**，不需要额外安装任何东西，也不需要准备仓库。',
    '**自带后端**：不需要额外安装运行时或依赖，也不需要准备仓库。填一次模型 key 就能跑真模型；没填也能用脚本化模型（mock）把流程走一遍。',
  ],
  // 3) 体检那行别写"四个角色 / 网络"这种不准的
  [
    '| `QZcode: 体检（环境自检）` | 检查 node / 配置 / 写权限 / shell / 四个角色 / 网络 |',
    '| `QZcode: 体检（环境自检）` | 9 项：运行时、配置文件、工作区写权限、shell、技能、插件、安全护栏 |',
  ],
  // 4) 前置条件段落：把"装好就能用"说准
  [
    '**不需要装 Node。** 扩展直接用 VS Code 自带的运行时跑本地服务，装好就能用；想指到别的 node 时在设置里填 `qzcode.nodePath` 即可。',
    '**不需要装 Node。** 本地服务跑在 VS Code 自带的运行时上（实测 VS Code 1.139.1 → Electron 43.6.0 → Node 24.20.0）。想指定别的 node 时填 `qzcode.nodePath`。',
  ],
  // 5) 注意段：删掉"不需要任何额外配置"这种不实的说法
  [
    `## 注意

- 设置面板保存时会把配置写进 \`qzcode.json\`；插件、模型、key 都在那个文件里。
- 本地服务是扩展的子进程：「停止服务」或关掉编辑器会杀掉它；端口随机，不占固定端口。
- 不需要装 Node：本地服务跑在 VS Code 自带的运行时上，装好后不需要任何额外安装或配置。`,
    `## 注意

- **跑真模型要填一次配置**：供应商 + API key（设置面板里填，会写进 \`qzcode.json\`）。不填就只能跑脚本化模型。
- 本地服务是扩展的子进程：「停止服务」或关掉编辑器会杀掉它；端口随机，不占固定端口。
- **不需要装 Node**，也不需要任何额外运行时；但浏览器验证这一步依赖本机已有的 Chrome / Edge（找不到会明确告诉你，不会静默跳过）。
- 市场页那张示意图是从 GitHub 仓库拉取渲染的，所以仓库要保持公开。`,
  ],
]

for (const [from, to] of pairs) {
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('改：' + from.slice(0, 16).replace(/\n/g, ' ') + '…')
  } else {
    console.log('⚠ 没匹配:', from.slice(0, 40))
  }
}

// 6) 已知限制补两条真实的（这两条来自代码和实测，不是拍脑袋）
const limitAnchor = '- 视觉模型要填一个真的能看图的模型名，填文本模型会报错。'
const limitAdd = `- 视觉模型要填一个真的能看图的模型名，填文本模型会报错。
- **视觉模型没在真实网关上验证过**：只用单元测试和本地截图跑通过，接你自己的多模态端点后第一次用建议先看一眼输出。
- **浏览器验证需要本机有 Chromium**：优先用 Playwright 缓存里的，其次 Chrome，再次 Edge；三个都没有时这一步会失败并提示，B 会改用命令验证。
- 供应商清单里少数平台的兼容地址（Astron / BaiLing / 千问AI平台 / QwenCloud / Xiaomi MiMo）没有实测，选中后报 401/404 就按官方文档改「接口地址」。`
if (code.includes(limitAnchor)) {
  code = code.replace(limitAnchor, limitAdd)
  done.push('已知限制：补 3 条真实限制')
}

writeFileSync(path, code, 'utf8')
console.log(done.join('\n') || '(无改动)')
