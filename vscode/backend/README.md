# QZcode

> 作者：**QZzwj**

把 [pi](https://github.com/earendil-works/pi) 那套「极简、可扩展的 agent harness」改造成**三模型分工的 TUI**：

| 角色 | 谁 | 负责什么 | 拿到什么 |
| --- | --- | --- | --- |
| **A** `planner` | 任意强模型 | 把用户目标翻译成**给 B 的提示词** + 指导 + **可执行的验收标准**；B 实现完再做一次**跑偏复核** | 目标、工作区快照、上一轮 C 的意见、B 的汇报与工具记录（复核时） |
| **B** `implementer` | 擅长工具调用的模型 | 照任务书动手改代码、跑命令、给汇报 | A 的任务书（**看不到用户原话**）、全套工具、A 的修正词（被退回时） |
| **C** `verifier` | 推理型模型 | 只读核验 + **亲自跑命令**，给 pass/fail 判定 | A 的验收标准、B 的汇报、只读工具 + `bash` |

**最前面还有一个 L（调度）**：先判断这条请求值不值得动流水线。

| 角色 | 谁 | 负责什么 | 花多少 token |
| --- | --- | --- | --- |
| **L** `leader` | 最便宜的模型 | 分流：问答类自己答完，动手类交给 A | 几百（预筛命中时 **0**） |

- **零成本预筛**：目标里出现动作词 / 文件名 / 代码块 / 报错 → 直接判"要动手"，**不调模型**（省掉这次调用）
- L 判 `direct` → 直接交付答案，**A/B/C 一次都不跑**（实测 1083 token vs 完整流程 7000+）
- L 判 `work` → 正常进 A/B/C，还能给 A 留一句话提示
- **宁可多花钱也不吞任务**：解析失败、答案太短、拿不准 → 全部按 `work` 走

两道路闸，都在同一个循环里：

```
       ┌──────────────── 跑偏就退回修正（最多 N 次，默认 2）────────────────┐
       ↓                                                                     │
A 规划 → B 实现 → A 复核 ──对齐──→ C 核验 ──pass──→ 结束                     │
                    │                   │                                    │
                    └──跑偏：给修正词────┘                                    │
                                        └──fail──→ 意见带回 A ────────────────┘
```

- **A 复核**（`review.enabled`，默认开）：拿自己写的验收标准去对 B 的产出，跑偏就产出**可直接执行的修正词**退回 B；只读工具，不改代码、不跑命令（跑命令是 C 的活）。
- **C 核验**：亲自看文件、亲自跑命令，`blocker` 会覆盖模型自己写的 `pass:true`。
- 轮次用完之后以 `failed` 收尾，不会无限烧钱。

零运行时依赖：只用 Node 自带的模块跑；仓库里直接跑 `.ts`（需要 Node ≥ 22.19 的类型剥离），打进扩展的那一份是**已编译的 JS**（Node ≥ 18 即可）。

```
+ QZcode ---------- A 规划 → B 实现 → C 核验 -------------- mock ------- 结束 2/3 · 12.4s · 8.1k tok +
| 目标：给 src/utils.ts 加 parseDuration 并补测试                                                          |
+---------------------------------------------------------------------------------------------------------+
| ▌ A · 规划 (prompt + guidance)    |  B · 实现 (tools)             |  C · 核验 (read-only + tests)        |
| ── 第 1 轮 · A 规划 ──            |  ── 第 1 轮 · B 实现 ──       |  ── 第 1 轮 · C 核验 ──              |
| 我先勘察仓库再写任务书。          |  我先看 utils.ts 现在什么样。 |  先读验收标准，再跑测试。            |
| ```json                           |    → read {"path":"src/util…  |    → bash {"command":"node --… |
| {"prompt": "在 src/utils.ts 中新  |    ← read ok 2ms …            |    ← bash ok 831ms …         |
|  增 parseDuration(input:string)…  |  我新增了 parseDuration 并补  |  [major] src/utils.test.ts: 只覆盖   |
| ```                               |  了 3 个用例。               |  了 "30s"，没覆盖非法输入。          |
+---------------------------------------------------------------------------------------------------------+
| ─ 日志 -------------------------------------------------------------------------------------------------|
|  第 1 轮未通过：1. [major] src/utils.test.ts: 只覆盖了 "30s"，没覆盖非法输入。                          |
|  第 2 轮 · C 核验                                                                                       |
+---------------------------------------------------------------------------------------------------------+
| › 输入目标后回车，Ctrl+C 退出                                                                           |
| Enter 运行 · /help 命令 · Tab 切面板 · Alt+1/2/3 定位 · PgUp/PgDn 滚动 · Ctrl+C 退出                    |
+---------------------------------------------------------------------------------------------------------+
```

## 主入口：VS Code 扩展

| 入口 | 怎么开 | 定位 |
| --- | --- | --- |
| **TUI** | `node src/cli.ts` | 远程 / 没有 VS Code / 纯键盘 |
| 浏览器页面 | `node src/cli.ts web --open` | **降级为调试用**：扩展的后端就是它，页面只在想脱离编辑器看一眼时用 |

三者共用同一个 `runPipeline`、同一套工具与插件、同一个本地服务；扩展自带后端（已编译 JS），装好即用。

## 快速开始

```bash
# 1. 零配置先看看效果（脚本化模型，不联网、不需要 key）
node src/cli.ts --mock            # TUI
node src/cli.ts web --mock --open # 想在浏览器里看一眼（调试）

# 2. 生成配置，填 key
node src/cli.ts init              # → ./qzcode.json
#    编辑 roles.*.apiKey，或者直接 export DEEPSEEK_API_KEY=...

# 3. 正常使用
node src/cli.ts                   # TUI
node src/cli.ts run "把 README 里的 TODO 都实现掉"   # 一次性，纯文本输出
# 装扩展开 VS Code → 右侧栏 QZ 图标（主入口）
```

想当命令用：`npm link` 之后可以直接 `qzcode` / `qzcode web` / `qzcode run "..."`。

需要 Node **≥ 22.19** 才能在仓库里直接跑 `.ts`；打进扩展的那份是编译好的 JS（**Node ≥ 18** 即可）。

## VS Code

```powershell
# 打包成 vsix 再装（VS Code 1.9x 的 --install-extension 只认 vsix）
node node_modules\@vscode\vsce\vsce package --allow-missing-repository --no-dependencies --skip-license -o qzcode-0.1.0.vsix --cwd vscode
code --install-extension D:\hhd\pi\qzcode-0.1.0.vsix --force
# 卸载：code --uninstall-extension qzcode.qzcode
```



## TUI

三个面板并排（终端宽度 ≥ 96 列时自动分列，否则上下堆叠），下方是日志条，再下面是一行输入框。

| 按键 | 作用 |
| --- | --- |
| `Enter` | 提交目标 / 执行 `/命令` |
| `Ctrl+C` | 运行中：请求取消；空闲：清空输入；空输入：退出 |
| `Ctrl+D` | 空输入时退出 |
| `Tab` / `Shift+Tab` | 切换焦点面板 |
| `Alt+1/2/3` | 直接定位 A / B / C 面板 |
| `PgUp` / `PgDn`、`Alt+↑/↓` | 滚动当前面板（手动滚动后不再自动追随，`Ctrl+L` 恢复） |
| `Ctrl+Home` / `Ctrl+End` | 跳到当前面板顶部 / 回到尾部并恢复追随 |
| `↑` / `↓` | 输入历史 |
| `Ctrl+A/E/U/K/W` | 行首 / 行尾 / 删到行尾 / 删到行首 / 删一个词 |
| `Esc` | 取消运行 / 清空输入 |

`Esc` 取消、`Ctrl+C` 先清输入再退出、空输入时 `Ctrl+D` 退出、`Enter` 提交——这几个与 pi 的 `app.interrupt` / `app.clear` / `app.exit` / `tui.input.submit` 默认键位一致（见 [keybindings 对照](docs/pi-alignment.md)）。

内置命令：

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/demo` | 切 mock 并跑一个演示任务 |
| `/mock` | 在 mock 与真实模型之间切换（不用改配置） |
| `/exec on\|off` | 允许 / 禁止 agent 执行 shell 命令 |
| `/rounds 1..10` | 设置 A→B→C 最大轮次 |
| `/config` | 显示三个角色的端点、模型、key 状态 |
| `/plugins` | 显示已加载插件及其来源 |
| `/clear` | 清空面板与 token 统计 |
| `/quit` | 退出 |

## 技能（skill）

每个角色都能挂一段「方法论」，跟着系统提示词一起下发。内置三个：

| 技能 | 角色 | 内容 |
| --- | --- | --- |
| `prompt-writer` | L / A | 先定交付物与完成信号，再写约束；不给口号、不写固定测试次数 |
| `code-implementer` | B | 先读再改、最小改动、真实自证、命令匹配 shell |
| `verified-delivery` | C | 逐条对验收标准、亲自跑命令、blocker 一票否决、只看不改 |

**导入**：设置面板右上角「导入技能」，可填本地文件 / 文件夹（含 SKILL.md）/ https 链接，或直接粘贴 markdown。
导入的技能默认只给 B 和 C（front matter 的 `roles` 可改）。规则：内置技能按角色始终生效；导入技能按勾选生效；
停用写在配置里 `"skills": { "disabled": ["名字"] }`。详见 [docs/skills.md](docs/skills.md)。

## 只做插件（没有网页端）

QZcode 现在是**纯 VS Code 插件**：界面只有右侧栏那个面板，加上设置面板（模型 / 技能 / 成本三个页签）。

- 曾经有一套浏览器版三栏工作台，已经删掉，减少两套界面同时维护的负担
- 后端仍然是一个本地 HTTP 服务（`qzcode web`），但它只提供 `/api/*`，不再提供任何 HTML 页面
- 想看后端在干什么：命令 `QZcode: 显示日志`（输出面板里有后端地址和启动参数）

## 配置

`qzcode.json`（`qzcode init` 生成；找不到配置时会退回内置默认值）：

```json
{
  "workspace": ".",
  "maxRounds": 3,
  "maxSteps": 40,
  "exec": { "enabled": true, "timeoutMs": 300000 },
  "tui": { "columns": "auto", "showTokens": true },
  "review": { "enabled": true, "maxCorrections": 2 },
  "leader": { "enabled": true, "directMaxTokens": 900, "directMaxChars": 80 },
  "roles": {
    "leader":      { "provider": "deepseek", "model": "deepseek-chat",     "apiKey": "${DEEPSEEK_API_KEY}", "temperature": 0.1, "maxTokens": 1024 },
    "planner":     { "provider": "deepseek", "model": "deepseek-chat",     "apiKey": "${DEEPSEEK_API_KEY}", "temperature": 0.3, "maxTokens": 4096 },
    "implementer": { "provider": "deepseek", "model": "deepseek-chat",     "apiKey": "${DEEPSEEK_API_KEY}", "temperature": 0.2, "maxTokens": 8192 },
    "verifier":    { "provider": "deepseek", "model": "deepseek-reasoner", "apiKey": "${DEEPSEEK_API_KEY}", "temperature": 0.1, "maxTokens": 4096 }
  },
  "plugins": ["./plugins/example-plugin.ts"]
}
```

- **每个角色独立配置**：可以三个都用同一个模型，也可以 A 用 DeepSeek、B 用 Kimi、C 用本地 Ollama——只要端点兼容 OpenAI 的 `/chat/completions`（流式 + function calling）。
- `provider` 是快捷预设（`deepseek` / `openai` / `openrouter` / `moonshot` / `zhipu` / `ollama` / `lmstudio`），填了 `baseUrl` / `model` 就覆盖预设；**写任意其它名字 + baseUrl 就是自定义供应商**，所有字段（headers / timeoutMs / retries / temperature / maxTokens）都可以手填。
- 字符串支持 `${VAR}` 和 `${VAR:-缺省值}` 展开，`~` 展开为 home。
- `localhost` 端点自动补一个占位 key（本地模型不在乎）。
- 其它字段：`headers`（自定义请求头）、`timeoutMs`、`retries`、`systemAppend`（追加到该角色系统提示词）、`maxSteps`（该角色工具步数上限）。
- 顶层 `roleDefaults` 会合并进每个角色，省得重复写。
- `review`：`enabled` 控制要不要 A 复核（默认开）；`maxCorrections` 是每轮最多退回 B 修正几次（0–5，默认 2，0 等于关掉回环但仍会复核）。复核用的是 A 自己的模型，多一次调用；想省钱可以设 `enabled: false`。

命令行覆盖：`-c/--config`、`-w/--workspace`、`-r/--rounds`、`--no-exec`、`--mock`、`-g/--goal`、`--json`（`run` 输出 JSON）、`-d/--debug`（写 `.qzcode/debug.log`）。

## 一次运行发生了什么

```
用户目标
   │
   ├─► A 规划：读工作区快照（文件树）→ 输出 prompt / guidance / acceptance / steps / risks
   │        └ 没有 JSON？降级用全文当任务书并提示；验收标准为空？C 会记 major
   ├─► B 实现：runAgent 工具循环（read / write / edit / bash / ls / find / grep）
   │        └ 步数用尽 → 强制要一段"收尾总结"，而不是空手返回
   ├─► C 核验：只读工具 + bash，输出 {pass, summary, issues[], evidence[]}
   │        └ 有 blocker 时，即使它写了 pass:true 也算不通过
   └─ 不通过 → 把 issues 拼进 A 的下一轮输入（A 必须逐条回应）
```

预算：`maxRounds` 控制 A→B→C 的轮数，`maxSteps` 控制每个 agent 的工具调用步数（C 用一半）。中途 `Ctrl+C` 通过 `AbortSignal` 打断，正在跑的 LLM 请求和 shell 都会停。

## 插件 / 扩展

三种写法都能跑，宿主传给插件的是**同一个对象**（既是 cordis 的 `Context`，也是 pi 的 `ExtensionAPI`）：

```ts
// 1) pi 扩展格式（推荐，从 pi 搬过来差量最小）
export default function (pi) {
  pi.registerTool({
    name: 'count_lines',
    description: '统计文件行数',
    annotations: { readOnlyHint: true },
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: (input) => ({ content: `${input.path} 有 N 行` }),
  })
  pi.registerCommand('trio', { description: '说明分工', handler: (args, ctx) => ctx.ui.notify('A→B→C') })
  pi.on('tool_call', (e) => (e.toolName === 'bash' && /rm\s+-rf/.test(e.input?.command) ? { block: true, reason: '拒绝' } : undefined))
  pi.on('tool_result', (e) => (e.toolName === 'read' ? { output: e.output.replace(/KEY=\S+/g, 'KEY=***') } : undefined))
}

// 2) cordis 格式（需要按服务依赖决定何时挂载）
export default {
  name: 'my-plugin',
  inject: ['tools', 'logger'],
  apply(ctx) {
    ctx.get('tools').register({ name: 'hello', readOnly: true, parameters: {}, run: () => ({ ok: true, output: 'hi' }) })
  },
}
```

`tool_call` 可以拦截调用（返回 `{block:true,reason}`），`tool_result` 可以脱敏/改写模型看到的结果——所以"保护 .env""审计所有 bash 命令"这类扩展是真的能生效的。完整 API、事件表、工具形状见 [docs/plugins.md](docs/plugins.md)。

## 和 pi / DeepSeek Harness 的关系

### pi

已按真实源码对齐（`earendil-works/pi` @ `a731ba8`，源码用 gh-proxy 拉到 `.reference/pi`，不进入版本库）。逐项对照见 **[docs/pi-alignment.md](docs/pi-alignment.md)**，摘要：

| pi | 本项目 |
| --- | --- |
| `packages/tui` | [`src/tui/screen.ts`](src/tui/screen.ts) + [`keys.ts`](src/tui/keys.ts) + [`app.ts`](src/tui/app.ts)：行级 diff、CJK 宽度、转义序列、输入行编辑 |
| `packages/agent` | [`src/agent.ts`](src/agent.ts)：有界工具循环 |
| `packages/ai` | [`src/llm.ts`](src/llm.ts)：OpenAI 兼容 + SSE 流 + tool calls + 重试 |
| `coding-agent/src/core/tools/*` | [`src/tools.ts`](src/tools.ts)：**工具名与参数照抄**（`read`/`ls`/`find`/`grep`/`write`/`edit`/`bash`，`bash.timeout` 也是秒） |
| `coding-agent/src/core/extensions/*` | [`src/kernel.ts`](src/kernel.ts) + [`src/commands.ts`](src/commands.ts) + [`src/plugins/loader.ts`](src/plugins/loader.ts)：`registerTool` / `registerCommand` / `on(tool_call|tool_result|…)` / `ui.notify` |
| 会话树（JSONL、分支、compaction）、RPC/SDK、codemode、MCP、themes、skills、包管理 | 没做，见对齐文档的"有意不做" |

和 pi 的定位差别：pi 是通用单 agent + 扩展；本项目把「谁写提示词、谁写代码、谁验收」固化成流水线，用模型间的独立性换取更少的自我确认。

### DeepSeek Harness

- ✅ 纯 cordis 风格的插件（只用 `ctx.set/get/on/effect/plugin`）可以直接加载。
- ✅ 插件里 `import '@deepseek-ai/*'`（或 `@earendil-works/*`）时，会通过一个 ESM resolve hook 到本机 DSH 安装的 `node_modules` 里解析——`test/fixtures/dsh-dep-plugin.ts` 用真实的 `@deepseek-ai/cosmokit` 守住这条路径。
- ⚠️ 依赖 DSH 专有服务（`dsh-agent`、`dsh-session`、`dsh-tool-*` 那套接口）的插件**跑不起来**——加载失败会明确报告「缺哪个包/哪个服务」，不会静默跳过。
- DSH 安装位置自动探测（Windows/macOS/Linux 常见路径、`QZCODE_DSH_ROOT`、`DSH_APP_DIR`），也可在配置里写 `dshNodeModules`。

## 目录结构

```
src/
  cli.ts            参数解析、模式分发、日志、退出码
  config.ts         配置加载/校验/预设/环境变量展开
  kernel.ts         插件内核：cordis 风格 Context + pi 风格 ExtensionAPI + 钩子链
  commands.ts       `/命令` 注册表（扩展可以注册命令）
  host.ts           把内核的 tool_call / tool_result 钩子接到 toolbox
  llm.ts            OpenAI 兼容客户端（SSE 流、tool calls、重试、错误解释）
  mock.ts           脚本化后端：无 key 也能跑通全流程（故意第一轮不通过）
  agent.ts          有界工具调用循环
  tools.ts          工具（read/ls/find/grep/write/edit/bash）+ 工作区沙箱 + shell 解析 + 钩子
  roles.ts          A/B/C 三个回合：提示词、任务书拼装、JSON 解析与降级
  pipeline.ts       A→B→C 的编排、修复轮、Reporter 协议、生命周期事件
  skills/           prompt-writer / code-implementer / verified-delivery（按角色追加的方法论）
  prompts/          leader.md / planner.md / planner-review.md / implementer.md / verifier.md
  tui/              screen.ts（差分渲染）、keys.ts（转义序列）、app.ts（布局与交互）
  web/              server.ts（HTTP + SSE）、assets/（无构建的 GUI：app.js / app.css / md.js）
  plugins/          loader.ts（宿主服务 + 加载）、dsh-resolver.mjs（ESM resolve hook）
vscode/             VS Code 扩展（主入口）：extension.cjs + lib.cjs + media/（侧栏聊天、设置面板、成本页）
plugins/
  pi-style-extension.ts  pi 格式示例（工具 + 命令 + tool_call 守卫 + 结果脱敏）
  example-plugin.ts      cordis 格式示例（inject + 注册工具 + effect）
test/               node:test 用例（132 个）
docs/               architecture.md / plugins.md / pi-alignment.md
.reference/pi       pi 源码快照（gitignore，仅作对照）
```

## 测试

```bash
npm test           # node --test，带 30s 超时（防挂死）
npm run check      # typecheck + 前端脚本语法 + 测试
```

78 个用例覆盖：

- **内核/插件**：挂载、依赖注入、事件、卸载、`registerTool` 规范化、钩子链顺序、cordis 与 pi 两种格式、真实 `@deepseek-ai/*` 解析
- **工具**：`read` 的 offset/limit、`edit` 批量与重叠拒绝、路径越界、`--no-exec`、`bash` 超时、钩子拦截与脱敏
- **流水线**：修复轮、轮次上限、取消、生命周期事件、Reporter 协议
- **GUI**：HTTP 外壳与 CSP、`/api/state`、通过 HTTP 跑完一整轮并获得事件序列、SSE 重放、配置开关与错误路径；客户端用**假 DOM** 把 `app.js` 真跑一遍（流式文本 → markdown、工具卡片、任务书卡片、判定卡片、状态栏、用量）
- **VS Code**：manifest、`parseServerUrl` / `buildServerArgs` / `resolveCliPath` / `webviewHtml` 的 CSP，以及按扩展的方式真起一次服务并跑完任务
- **TUI**：CJK 宽度与换行、转义序列、三面板布局（假终端驱动，不需要真 TTY）

`--test-isolation=none` 是因为每个测试文件单独起进程在某些沙箱里会被拒绝（pipe stdio）；单进程跑更快。若你的环境没有限制，`node --test test/` 也行。

## 已知限制

- 只有 OpenAI 兼容协议。Anthropic / Gemini 原生协议没接（换成它们的 OpenAI 兼容端点即可）。
- C 的"只读"靠工具白名单 + 提示词约束，不是内核级隔离。要硬隔离请容器化（pi 也是同样的立场）。
- 工作区沙箱只防路径越界，不防命令本身干坏事；不确定就 `--no-exec` 或容器里跑。
- 上下文不做自动压缩，没有会话树/分支：超长任务靠 `maxSteps` / `maxRounds` 控制，或换长上下文模型。
- pi 扩展只支持工具/命令/工具钩子/四个生命周期事件这一层，渲染器、provider 注册、模态 UI、会话操作都没有（[docs/pi-alignment.md](docs/pi-alignment.md) 有完整矩阵）。
- GUI 没有做鉴权，只监听回环地址；`--host 0.0.0.0` 时请自己加防火墙或反代。
- GUI 的视觉是在代码和假 DOM 层面验证的（沙箱里起不了浏览器），第一眼效果请你自己确认；VS Code 扩展同理，需要一次 `code --install-extension` 在宿主里验证。

MIT © **QZzwj**
