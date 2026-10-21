# 插件 / 扩展

一个对象，三种写法都能跑：

| 写法 | 长相 | 适合 |
| --- | --- | --- |
| **pi 扩展** | `export default (pi) => { pi.registerTool(...) }` | 从 pi 搬过来的扩展（差量最小） |
| **cordis 插件** | `export default { name, inject, apply(ctx) }` | 需要按服务依赖决定何时挂载 |
| **cordis 函数** | `export default (ctx) => { ... }` | 最短的几句话 |

宿主传给插件的是**同一个对象**：它既是 cordis 风格的 `Context`（`ctx.get('tools')`、`ctx.plugin()`、`ctx.effect()`），也是 pi 风格的 `ExtensionAPI`（`pi.registerTool()`、`pi.registerCommand()`、`pi.ui.notify()`、`pi.on("tool_call", …)`）。所以两种写法不会互斥。

## pi 扩展格式

```ts
export default function (pi) {
  // 1) 加一个模型可调用的工具
  pi.registerTool({
    name: 'count_lines',
    description: '统计文件行数',
    annotations: { readOnlyHint: true },       // readOnly → 也会下发给 C（核验角色）
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute(input, ctx) {                       // pi 的签名：返回 { content, isError? }
      const text = pi.get('fs').read(String(input.path))
      return { content: `${input.path}: ${text.split(/\r?\n/).length} 行` }
    },
  })

  // 2) 加一个 / 命令（TUI 里直接输入，/help 会列出来）
  pi.registerCommand('trio', {
    description: '说明分工',
    handler(args, ctx) {
      ctx.ui.notify('A 出提示词 → B 实现 → C 核验', 'info')
    },
  })

  // 3) 守卫：可以在调用前拦住工具
  pi.on('tool_call', (event) => {
    if (event.toolName === 'bash' && /rm\s+-rf/.test(String(event.input?.command))) {
      return { block: true, reason: '拒绝破坏性命令' }
    }
  })

  // 4) 脱敏：可以替换模型看到的结果
  pi.on('tool_result', (event) => {
    if (event.toolName === 'read' && event.output.includes('API_KEY=')) {
      return { output: event.output.replace(/API_KEY=\S+/g, 'API_KEY=***') }
    }
  })
}
```

`execute` 也可以返回字符串，或 `{ content: [{type:'text',text}] }`；`isError: true` 会转成失败结果（模型看到 `ERROR:` 前缀）。想用本项目的原生形状也可以：`run(args, runtime) => ({ ok, output })`。

## Host 提供的服务

用 `ctx.get(name)` / `ctx.name` 取：

| 服务 | 形态 | 说明 |
| --- | --- | --- |
| `logger` | `{debug,info,warn,error}` | 写 `.qzcode/debug.log`（仅 `-d`） |
| `config` | `AppConfig` | 解析后的配置（`workspace`、`roles`、`exec`…） |
| `tools` | `{register(tool), list()}` | 注册工具（`registerTool` 底下就是它） |
| `commands` | `CommandRegistry` | `/命令` 注册表（`registerCommand` 底下就是它） |
| `notify` | `(message, level?) => void` | 冒泡到 TUI 状态行与日志条 |
| `fs` | `{read,write,exists}` | 相对 workspace 的便捷读写（不做越界校验） |
| `llm` | `{create(role)}` | 复用配置好的 A/B/C 客户端（含 mock/重试/超时） |
| `dsh` | `{host:'qzcode', version, compatible:false}` | 标记：告诉 DSH 感知的插件"你不是在真 harness 里" |

## Context API（cordis 风格）

| 调用 | 说明 |
| --- | --- |
| `ctx.set(name, value)` / `ctx.get<T>(name)` / `ctx.tryGet` / `ctx.provides` | 服务注册与查找（向下继承） |
| `ctx.on(event, fn)` | 订阅事件；返回取消函数。`tool_call` / `tool_result` 两个名字自动走钩子链 |
| `ctx.emit(event, ...args)` | 发布事件（全树一条 bus） |
| `ctx.hook(name, fn)` / `await ctx.runHook(name, value)` | 有序、可 await、可改写值的钩子 |
| `ctx.effect(fn)` | 绑到作用域生命周期的清理 |
| `ctx.plugin(fnOrObj, config?)` | 挂载子插件，返回卸载函数 |
| `ctx.inject([...deps], fn)` | 依赖就绪后再执行 |
| `ctx.registerTool` / `ctx.registerCommand` / `ctx.ui` | pi 兼容层 |

## 工具的形状

```ts
ctx.get('tools').register({
  name: 'word_count',
  description: '统计字符数/行数/CJK 字符数',
  readOnly: true,                       // true 才会下发给 C（核验角色）
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run(args, runtime) {                  // runtime = { workspace, exec }
    return { ok: true, output: '…' }    // ok:false 会以 "ERROR: " 前缀回给模型
  },
})
```

约定：`run` 可 async；抛异常 = 失败（`Toolbox.call` 兜住并转成 `{ok:false}`）；`output` 截断到 40k 字符；参数是 JSON 字符串解析后的对象。

## 事件与钩子

| 名字 | 类型 | 触发点 |
| --- | --- | --- |
| `session_start` | 通知 | 每次运行开始（payload `{goal}`） |
| `agent_start` / `agent_end` | 通知 | 每个角色回合前后（`{role, round}`） |
| `session_end` | 通知 | 运行结束（`{ok, rounds}`） |
| `tool_call` | 门控 | 工具执行前；返回 `{block,reason}` 阻止，改 `event.input` 可改参数 |
| `tool_result` | 转换 | 工具执行后；返回 `{output}` 替换模型看到的文本 |
| `service` | 通知 | `ctx.set()` |
| `tool:registered` / `command:registered` / `plugins:loaded` | 通知 | 注册/加载完成 |

**只有上面这些会真的触发。** pi 的 `turn_start`、`turn_end`、`message_*`、`context`、`context_with_system`、`before_agent_start`、`tool_execution_*`、provider 系列事件在本项目里不会发生——注册它们不报错，但永远等不到回调。见 [pi-alignment.md](pi-alignment.md) 的完整矩阵。

## 加载与调试

`qzcode.json` 的 `plugins[]` 接受相对路径（相对配置文件）、绝对路径、`file:` URL 和裸包名：

```json
{ "plugins": ["./plugins/pi-style-extension.ts", "@scope/some-plugin"] }
```

```bash
qzcode plugins          # 每个插件的状态与来源
qzcode -d plugins       # 同时写 .qzcode/debug.log
```

失败的插件会带 `detail`（缺依赖、缺服务、没导出插件、用了类型剥离不支持的语法）。TUI 里 `/plugins` 看同一份信息。

## 与 DeepSeek Harness 的兼容度

**能做**

1. **纯 cordis 插件**：只用 `ctx.set/get/on/effect/plugin/inject` 的，改 import 路径就能跑。
2. **复用 DSH 的工具函数包**：`import '@deepseek-ai/cosmokit'` 这类无服务依赖的包，会通过 resolve hook 从本机 DSH 安装里解析（`test/fixtures/dsh-dep-plugin.ts` 就是这条路径的回归测试）。
3. **移植逻辑**：把 `ctx.get('dsh-xxx')` 换成自己的服务实现，主体逻辑通常能保留。

**做不到**

依赖 DSH 会话/工具/审批/沙箱服务（`@deepseek-ai/dsh-session-*`、`dsh-tool-*`、`dsh-agent-*`）的插件跑不起来，但会明确报告原因，不会静默跳过：

```
✘ dsh-tool-bash  ./node_modules/@deepseek-ai/dsh-tool-bash
   detail: 依赖 @deepseek-ai/dsh-session 属于 DeepSeek Harness 运行时，未能在本机找到。设置 config.dshNodeModules 指向 DSH 安装目录（含 node_modules）。
```

## resolve hook 原理

插件里 `import '@deepseek-ai/foo'` 时，Node 从插件所在目录往上找 `node_modules`，找不到就 `ERR_MODULE_NOT_FOUND`。本项目注册一个 ESM `resolve` hook（`src/plugins/dsh-resolver.mjs`，用 `module.register`）：

```
import('@deepseek-ai/foo')
  ├─ nextResolve 成功 → 用默认结果
  └─ 失败 → parentURL 换成 <DSH app>/__pi_trio_plugin_host__.js 再解析一次 → 命中 DSH 的 node_modules
```

不自己实现模块解析：只换父 URL 再问 Node，所以 `exports` 映射、条件导出、符号链接全都照旧生效。

DSH 安装目录探测顺序：配置项 `dshNodeModules`（可指向安装目录或它的 `node_modules`）→ 环境变量 `QZCODE_DSH_ROOT` / `DSH_APP_DIR` → 平台常见路径（Windows `%LOCALAPPDATA%\Programs\DSH Desktop\resources\app`、macOS `/Applications/DSH Desktop.app/Contents/Resources/app`、Linux `~/.local/share/dsh-desktop/resources/app`），命中条件是存在 `node_modules/@deepseek-ai`。`qzcode config` 会打印实际探测到的路径。

仓库里的两个可运行示例：

- [`plugins/pi-style-extension.ts`](../plugins/pi-style-extension.ts)：pi 格式，工具 + 命令 + `tool_call` 守卫 + `tool_result` 脱敏 + 生命周期事件。
- [`plugins/example-plugin.ts`](../plugins/example-plugin.ts)：cordis 格式，`inject` 服务、注册工具、`ctx.effect` 卸载。
