# 与 pi 的对照（已验证）

参考源码：`earendil-works/pi` @ `a731ba8`（2026-10-20），用 gh-proxy 拉取后放在 `.reference/pi`（不进入版本库）。

```bash
# 断点：本机 git 的 schannel 后端拿不到凭据，必须指定 openssl
git -c http.sslBackend=openssl clone --depth 1 --filter=blob:none \
  https://gh-proxy.com/https://github.com/earendil-works/pi.git .reference/pi
cd .reference/pi && git -c http.sslBackend=openssl sparse-checkout set \
  packages/coding-agent/docs packages/tui/src packages/agent/src packages/ai/src packages/coding-agent/src
```

## 包 → 文件

| pi | 本项目 | 说明 |
| --- | --- | --- |
| `packages/tui`（差分渲染、Editor、Markdown、图片、鼠标…） | `src/tui/screen.ts` / `keys.ts` / `app.ts` | 只保留三面板所需：行级 diff、CJK 宽度、转义序列解析、输入行编辑。pi 的 `editor.ts`(84KB)、`markdown.ts`(34KB)、`terminal-image.ts`(25KB) 没搬 |
| `packages/agent`（`agent-loop.ts` 29KB） | `src/agent.ts` | 有界工具循环 + 步数用尽后的收尾总结；没有 pi 的 steering/follow-up 队列和 compaction 触发 |
| `packages/ai`（多厂商 + OAuth + 模型目录） | `src/llm.ts` | 只做 OpenAI 兼容 `/chat/completions` 流式 + tool calls + 重试；没有 OAuth、模型目录、Bedrock/Vertex 专有协议 |
| `packages/coding-agent/src/core/tools/*` | `src/tools.ts` | 工具名与参数对齐（见下），实现是自己写的轻量版 |
| `packages/coding-agent/src/core/extensions/*`（`types.ts` 84KB） | `src/kernel.ts` + `src/plugins/loader.ts` + `src/commands.ts` | 只实现 `registerTool` / `registerCommand` / `on(tool_call|tool_result|…)` / `ui.notify` |
| `packages/coding-agent/src/core/session-manager.ts`（63KB，JSONL 会话树） | 无 | 会话只活在内存 + TUI 面板里 |
| `packages/coding-agent/docs/{extensions,keybindings,usage}.md` | `docs/plugins.md` + README | 只取与本项目相关的部分 |

## 键位

按 `packages/coding-agent/docs/keybindings.md` 对齐了"动作语义"，没有做可配置的 keymap：

| pi action | 默认键 | 本项目 |
| --- | --- | --- |
| `tui.input.submit` | `enter` | ✅ 一样 |
| `app.interrupt` | `escape` | ✅ 一样（运行中取消） |
| `app.clear` | `ctrl+c` | ✅ 一样（先清输入，空输入时再按退出） |
| `app.exit` | `ctrl+d`（输入为空） | ✅ 一样 |
| `tui.editor.cursorLineStart/End` | `home`/`ctrl+a`、`end`/`ctrl+e` | ✅ 一样 |
| `tui.editor.deleteToLineStart/End` | `ctrl+u`、`ctrl+k` | ✅ 一样 |
| `tui.editor.deleteWordBackward` | `ctrl+w` | ✅ 一样 |
| `tui.altScreen.pageUp/pageDown` | `pageUp`/`pageDown` | ✅ 一样（滚的是当前面板） |
| `tui.altScreen.top/bottom` | `ctrl+home`、`ctrl+end` | ✅ 一样 |
| `tui.input.newLine` | `shift+enter`、`ctrl+j` | ❌ 输入框是单行 |
| `tui.editor.yank/yankPop/undo/jumpForward` | `ctrl+y`、`alt+y`、`ctrl+-`、`ctrl+]` | ❌ 没做 |
| 全部 keymap 可配置（`keybindings.json`、`/hotkeys`） | — | ❌ 硬编码 |

## 工具：名字与参数照 pi 对齐

从 `packages/coding-agent/src/core/tools/index.ts` 与各 tool 文件抄的语义：

| 工具 | 参数（与 pi 一致的部分） | 实现位置 |
| --- | --- | --- |
| `read` | `path`、`offset`（1 起）、`limit` | `src/tools.ts` |
| `ls` | `path?`、`limit?`，字母序、目录带 `/`、含点文件 | 同上 |
| `find` | `pattern`（glob）、`path?`、`limit?` | 同上 |
| `grep` | `pattern`、`path?`、`glob?`、`ignoreCase?`、`literal?`、`limit?` | 同上 |
| `write` | `path`、`content` | 同上 |
| `edit` | `path` + `oldText`/`newText`，或 `edits:[{oldText,newText}]`（批量、全部对原文匹配、不可重叠、要么全成要么不改） | 同上 |
| `bash` | `command`、`timeout`（**秒**，跟 pi 一致） | 同上 |

刻意没对齐的：pi 的 `read` 支持图片附件、`bash` 输出截断会写临时文件并返回 `full_output_path`、`powershell` 独立工具（本项目在 `resolveShell()` 里按平台选 shell）、`exposure`/`namespace`/`annotations` 的完整工具治理。

## 扩展 API 映射

| pi API | 本项目 | 状态 |
| --- | --- | --- |
| `pi.registerTool({name,description,parameters,execute})` | `Context.registerTool()`，`execute` 返 `{content,isError}` 会被规范化 | ✅ |
| `pi.registerCommand(name,{description,handler})` | `Context.registerCommand()` → `CommandRegistry`，TUI 里 `/name` 可用、`/help` 会列出 | ✅ |
| `pi.on("tool_call", h)`（可返回 `{block,reason}` 或改 input） | 映射到 `ctx.hook("tool_call")`；`wireHost()` 把它接到 `Toolbox.call` 的 before 阶段 | ✅ |
| `pi.on("tool_result", h)`（可替换 content） | 映射到 `ctx.hook("tool_result")`，after 阶段替换模型看到的文本 | ✅ |
| `pi.on("session_start" / "session_end" / "agent_start" / "agent_end")` | `runPipeline` 会 `emit` 这四个事件 | ✅（由 pipeline 触发） |
| `pi.on("turn_start" / "turn_end" / "message_*" / "before_agent_start" / "context" / "tool_execution_*" / provider 事件)` | 未触发 | ❌ 注册不报错，但永远等不到 |
| `ctx.ui.notify()` | `Context.ui.notify` → `notify` 服务 → TUI 状态行 + 日志条 | ✅ |
| `ctx.ui.select/input/confirm` | 未实现（TUI 没有模态交互） | ❌ |
| `pi.registerShortcut` / `registerFlag` / `registerProvider` / `registerMcpServer` / `registerVirtualModel` / `registerToolRenderer` / `sendMessage` / `appendEntry` / `ctx.executeTool` / `ctx.reload` | 未实现 | ❌ |
| 扩展用到的 `@earendil-works/pi-coding-agent` 类型 | 编译期不存在；用 `any` 或本项目类型 | ⚠️ |

结论：**能直接搬过来的是"加工具 + 加命令 + 用 tool_call/tool_result 做守卫/脱敏/审计"这类扩展**；依赖会话树、渲染器、provider 注册、模态 UI 的扩展搬不动。

## 有意不做的部分

`session-manager`（JSONL 会话树、分支/分叉/克隆）、`compaction`（上下文压缩）、`rpc`/`sdk`/`json` 模式、`codemode`、`mcp`、`themes`、`skills`、`package-manager`（用 npm/git 分发 pi 包的那套）、`export-html`、图片/剪贴板、`proxy`。

理由：这些都在解决"通用单 agent + 长会话 + 多入口"的问题，而本项目的形状是"固定三角色流水线 + 一次性任务"。真需要长会话，应该先做的是 `session-format` + `compaction` 这两块。

## 刷新参考源码

```bash
cd .reference/pi
git -c http.sslBackend=openssl pull --ff-only --depth 1 || \
  git -c http.sslBackend=openssl fetch --depth 1 origin main
git -c http.sslBackend=openssl log -1 --format="%h %ad" --date=short
```

拉完对照上文表格检查：工具 schema 有没有变、`extensions/types.ts` 里 `ExtensionAPI` 有没有新增方法、`how-pi-works.md` 的钩子顺序有没有改。
