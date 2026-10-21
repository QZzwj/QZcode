# 架构

## 不变量

设计上只有四条硬约束，其它都是实现细节：

1. **B 看不到用户原话**，只能看到 A 写的任务书。这逼着 A 把提示词写成自包含的，而不是复述一遍再让 B 自己猜。
2. **C 必须能自己跑命令**，所以它拿到的是只读工具 + `bash` 的**白名单**，而不是"提示词里求它别改文件"。
3. **判定权只在 C 手里**：只要 `issues` 里出现 `blocker`，即使模型写了 `pass: true` 也算不通过（见 `parseVerdict`）。
4. **一切能力都是插件**：内置工具、三个角色、TUI 都通过同一套 `Context` 拿到服务；没有"特权模块"。

## 依赖方向

```
cli.ts ──► config.ts
   │           │
   ├──► kernel.ts ◄──── plugins/loader.ts ──► tools.ts
   │        ▲                                   ▲
   │        └── host.ts（tool_call/tool_result 钩子）──┘
   ├──► commands.ts（扩展注册 /命令）
   ├──► pipeline.ts ──► roles.ts ──► agent.ts ──► tools.ts
   │        │              │            │
   │        │              └──► prompts/*.md
   │        └──► llm.ts
   └──► tui/app.ts ──► tui/screen.ts, tui/keys.ts
```

单向：`llm` 不知道 `agent` 的存在，`agent` 不知道谁在调度它，`pipeline` 是唯一持有策略的地方，`tui` 只消费 `Reporter` 事件。想换成 RPC / Web / CI 输出，实现一个 `Reporter` 就行（`createPlainReporter` 就是这么来的）。

## 一次运行的数据流

```
runPipeline({config, goal, toolbox, toolRuntime, reporter, signal})
│
├─ round = 1..maxRounds
│   ├─ reporter.phase('plan', round)
│   │   planStep(ctx, {goal, round, workspace, previousIssues})
│   │     └ 单次 LLM 调用（无工具）→ parsePlan() → Plan{prompt, guidance, acceptance, steps, risks}
│   │         ├ 解析失败 → plan.parsed = false，用全文当 prompt，reporter.note 警告
│   │         └ acceptance 为空 → note 警告（C 会据此记 major）
│   │
│   ├─ reporter.phase('implement', round)
│   │   implementStep(ctx, {plan, goal, round, messages})
│   │     ├ 首轮：messages = [implementerBrief(plan)]；修复轮：追加一段"只改必要部分"
│   │     └ runAgent()：LLM ⇄ 工具，直到没有 tool_call 或步数用尽
│   │         └ 每步 hooks.onToolStart/onToolEnd → Reporter.tool → 面板里一行 ─→/─←
│   │
│   ├─ reporter.phase('verify', round)
│   │   verifyStep(ctx, {plan, goal, round, implementerReport, implementerMessages})
│   │     └ 只读工具 + bash，messages 里带上 B 的工具调用记录（用于交叉验证汇报是否属实）
│   │         └ parseVerdict() → {pass, summary, issues[], evidence[]}
│   │
│   └─ pass ? done : 把 issues 交给下一轮的 A
└─ done(result) → 退出码（run 模式）或日志条（TUI）
```

`Reporter` 是唯一的输出协议：

```ts
phase(phase, round)            // 阶段切换（plan/implement/verify/done）
text(pane, delta)              // 流式文本增量
textEnd(pane)
tool({pane, stage, name, args, ok, output, ms})
note(message, level)
verdict(round, verdict)
usage(pane, usage)
done(result)
```

TUI 用它把三个面板喂饱，`createPlainReporter` 用它打纯文本日志，测试用它断言。

并行还有一条事件流给扩展（`emit`）：

```
session_start{goal} → 每轮：[agent_start{role} → agent_end{role}] × 3 → session_end{ok,rounds}
```

工具层的事件走 `wireHost()` 接的钩子：`tool_call`（可 `{block:true}` 或改 input）与 `tool_result`（可替换 output）。

## 关键决策

| 决策 | 理由 | 代价 |
| --- | --- | --- |
| 零运行时依赖，Node 原生跑 `.ts` | 不需要构建、不会因为依赖腐烂而跑不起来；改一行立刻生效 | 不能用 `enum` / `namespace` / 参数属性（类型剥离限制），必须写显式的 `.ts` 后缀和 `import type` |
| 自己写 TUI（不用 blessed/ink） | 需要 CJK 宽度精确、行级 diff、可注入流以便测试 | 约 900 行渲染/布局代码是自有资产 |
| 行级差分而不是字符级 | 三面板同时流式输出时字符级 diff 的收益很小，行级就够快 | 同一行频繁变化时会重绘整行 |
| 策略集中在 `pipeline.ts` | `agent` 可复用、可单测；A/B/C 的顺序与预算只在一个地方 | pipeline 稍厚 |
| A/C 用 JSON 契约 + 降级 | 结构化字段能被机器验证；模型不听话时也不能崩 | 需要 `extractJson` 的括号扫描和 heuristic |
| 事件总线是全局的（root 上单一 bus） | 插件要能听见宿主事件，宿主也要能听见插件事件；按作用域隔离会让"谁在听"变得难猜 | 事件名要自己加命名空间前缀 |
| 工具名与参数照 pi 抄 | 给 pi 写的任务书、提示词、扩展可以直接用；模型的工具使用习惯也能迁移 | 受制于 pi 的 schema 形状（比如 `bash.timeout` 是秒） |
| `tool_call`/`tool_result` 用可 await 的钩子链 | 守卫和脱敏必须能影响真实执行，不能只是旁听 | 每次工具调用多两次 await（无钩子时几乎为零成本） |
| 工具工作区沙箱只防路径越界 | 硬隔离应该由容器/沙箱做，不该假装在进程里做成 | 命令本身仍可能干坏事 → `--no-exec` |

## 失败与取消

错误分三层，互不吞噬：

- **传输层** `LlmError`：401/403/404/429/5xx 有各自的提示文案（带 baseUrl、model、响应片段）；429/5xx/网络错误按 `retries` 指数退避重试；401/404 直接抛。
- **工具层**：任何 `run()` 抛错都被 `Toolbox.call` 转成 `{ok:false, output:"工具执行失败: …"}` 喂回模型——模型自己看得见错误，能换方法。
- **插件层**：加载失败记 `PluginRecord{status:'failed', detail}` 并继续；`apply()` 抛错只卸载该插件作用域。

取消：一个 `AbortController` 贯穿 `runPipeline → agent → client.chat → fetch`，`AbortSignal.any([外部, timeout])` 同时管超时。`AbortError` 不被重试、不被当成运行失败，TUI 里显示"已取消"。

步数用尽不是失败：`runAgent` 会追加一条"预算用完了，直接总结"的 user 消息再要一段收尾文本，这样 C 至少能拿到 B 的说明。

## 渲染管线

```
PaneState.spans（带样式的追加式日志）
  → wrap(spans, width)        按显示宽度折行（CJK 占 2 格，英文优先在空格断）
  → decorate(lines, accent)   轻量 markdown：代码块/标题/列表/数字步骤
  → paneBlock()               取可视窗口（scroll 从底部计）
  → composePaneRows()         分列或堆叠拼接成整行
  → Screen.draw(rows)         与上一帧逐行比对，只重写变化的行
```

性能相关：

- `wrappedLines` 按 `{version, width}` 缓存，流式追加时才失效。
- 绘制循环 40ms 一次，仅在有变更时真正下发；`timer.unref()` 保证 UI 不会在无人使用时吊住进程（真实终端由 stdin 保活）。
- 单个面板超过 400k 字符会砍掉头部并留一条提示，避免长会话把内存和渲染时间拖垮。

## 安全边界

| 面 | 措施 |
| --- | --- |
| 文件路径 | `resolveInside()`：解析后必须落在 workspace 内，否则报"路径越界" |
| 命令执行 | 全局 `exec.enabled` 开关（`--no-exec` / `/exec off`），超时强杀，输出上限 40k |
| C 越权 | 工具白名单（`read/grep/find/ls/bash`），写工具根本不下发给它 |
| 凭据 | 配置里的 `${ENV}` 展开，`qzcode config` 只打印 `abcd…wxyz` 掩码；日志默认不落盘（`-d` 才写） |
| 沙箱 | 平台沙箱拒绝 piped stdio 时，`bash` 自动退回"输出重定向到临时文件"的模式（`src/tools.ts` 的 `execShell`） |
| 扩展越权 | `tool_call` 钩子可以拦任何调用（包括 `bash`）；但扩展本身跑在进程内，信任边界等同于 pi 的扩展 |

## Node 类型剥离的约束

`node src/cli.ts` 直接执行 TS，靠的是 Node 22.19+/24 的 type stripping，因此代码里**不能出现**：

- `enum`（用 `const` 对象 + `as const`）
- `namespace`
- 构造函数参数属性（`constructor(private x: number)`）
- 未标 `import type` 的类型导入（`verbatimModuleSyntax`）
- 省略 `.ts` 后缀的相对导入

对应地在 `tsconfig.json` 里开了 `erasableSyntaxOnly`，`npm run typecheck` 会把这类问题提前抓出来。
