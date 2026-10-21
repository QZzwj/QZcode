# QZcode for VS Code

> 作者：**QZzwj**

在编辑器里跑 QZcode 的三模型流水线：**A 出提示词与验收标准 → B 带工具实现 → C 只读核验**，不通过就退回 A 重写任务书。

这个扩展**自带后端**：`backend/` 里就是完整的 QZcode（A/B/C 流水线、工具、插件、SSE、GUI 页面），所以装好就能用，**不需要克隆仓库、不需要 npm install、不需要任何构建**。

## 装

**只需要两条命令**（VS Code 1.9x 的 `--install-extension` 只认 vsix）：

```powershell
# 1) 打包（把 src/ 一起打进去，约 160 KB）
npm run bundle:backend
node node_modules\@vscode\vsce\vsce package --allow-missing-repository --no-dependencies --skip-license -o qzcode.vsix --cwd vscode

# 2) 安装
code --install-extension qzcode.vsix --force
code --list-extensions --show-versions | Select-String qzcode   # → qzcode.qzcode@0.3.0
# 卸载：code --uninstall-extension qzcode.qzcode
```

然后 `Ctrl+Shift+P` → `Developer: Reload Window`。

**前置条件只有一个**：机器上有 **Node ≥ 22.19**（后端直接跑 `.ts`，靠 Node 的类型剥离，不需要编译）。`qzcode.nodePath` 可以指定别的 node。

### 为什么以前会报"找不到 src/cli.ts"

早先的版本只是个壳，后端要从"你打开的仓库"里找。现在改成自带后端，查找顺序是：

```
qzcode.cliPath（设置，仅开发时用）
  └→ <扩展目录>/backend/src/cli.ts      ← 自带后端，正常情况下就是它
      └→ <扩展目录>/../src/cli.ts        ← 仓库里的 vscode/ 目录调试用
          └→ <工作区>/src/cli.ts
```

所以**在任意项目里打开都能用**，与你打开哪个文件夹无关。

### 配置放哪

- 工作区里有 `qzcode.json`（或旧名 `pi-trio.json`）→ 用它
- 否则用扩展的**全局存储**目录（`%APPDATA%\Code\User\globalStorage\qzcode.qzcode\qzcode.json`），不污染你的项目
- 都没有 → 自动以 **mock（脚本化模型）** 起来，先能跑；你在聊天窗左下角选一个供应商，就会把配置写出来

**方式二：调试模式（不装扩展）**

用 VS Code 打开 `D:\example\qzcode`，按 `F5`（扩展开发宿主）。仓库里已经带了 `.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "QZcode extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}/vscode"]
    }
  ]
}
```

## 用

**主界面是右侧栏里的对话视图**：装好后 VS Code **右侧**（辅助侧边栏）出现一个 **QZcode** 图标（品牌 logo PNG，透明底，浅色/深色主题都看得清），点开就是一个侧栏聊天，贴着你的主题配色，没有多余的大面板。第一次没看到就 `Ctrl+Shift+P` → `QZcode: 打开侧栏聊天`，它会自动把右侧栏拉出来。

```
┌ 聊天 ─────────────────────────┐
│  A  我理解的目标               │   ← A 的任务书（markdown 渲染）
│  B  → write ok 3ms notes/…    │   ← 工具调用压成一行
│  C  ✔ 通过                    │
│                                │
│ ┌────────────────────────────┐ │
│ │ 描述目标…                  │ │
│ └────────────────────────────┘ │
│ (•) deepseek·deepseek-chat  ▤ ＋ ↑ │  ← 供应商/模型就在输入框旁边
└────────────────────────────────┘
```

- **模型/供应商**：输入框左下角那个 chip 就是当前 `provider · model`，点一下弹 QuickPick（deepseek / openai / openrouter / moonshot / zhipu / ollama / lmstudio），没有 key 会顺便让你粘贴；写回 `qzcode.json`，**下一轮就生效**，不用重启服务
- **▤** 打开完整三栏工作台（历史回放、任务书卡片、判定卡片都在那边）
- **＋** 清空当前对话开新任务；**↑** 发送（Enter 发送，Shift+Enter 换行）
- 底部状态行跟着流水线走：`第 1 轮 · B 实现` → `✔ 完成 · 2 轮 · 0.4s · 3696 tok`

底部状态栏也有一个 `QZcode`（显示当前轮次），点一下回到对话视图。

| 命令（`Ctrl+Shift+P`） | 作用 |
| --- | --- |
| `QZcode: 打开侧栏聊天` | 聚焦右侧对话视图（右侧栏图标是同一个） |
| `QZcode: 打开工作台` | 完整三栏 GUI（大面板，可选） |
| `QZcode: 模型设置` | 打开设置面板：A/B/C 各自配供应商、模型、端点、key、温度（侧栏标题栏的 ⚙ 也是它） |
| `QZcode: 更换 AI 供应商…` | 同输入框旁边的 chip（快速切换，三个角色一起换） |
| `QZcode: 新建任务…` | 输入目标直接开跑 |
| `QZcode: 用选中代码当目标…` | 右键选中代码也能用 |
| `QZcode: 在浏览器打开` | 想用大屏或别的浏览器时 |
| `QZcode: 显示日志` | 看服务端的 stdout/stderr |
| `QZcode: 重启服务` / `停止服务` | 改完配置后用 |

## 模型设置面板

侧栏标题栏的 **⚙**（或命令面板 `QZcode: 模型设置`）打开一个面板，三张卡片对应 A/B/C：

| 字段 | 说明 |
| --- | --- |
| 供应商 | 预设：deepseek / openai / openrouter / moonshot / zhipu / ollama / lmstudio；换供应商会带出默认端点与模型。**选「＋ 自定义（手动填写全部字段）」就全部手填**，连供应商名字都能自己起（如 `my-gateway`） |
| 模型 | 想用预设之外的模型名，直接改这里 |
| 接口地址 | 任何 OpenAI 兼容端点，包括自建网关 |
| API key | 密码框；**留空表示不改**；已保存的只显示打码提示，不进页面数据 |
| temperature / maxTokens | 每个角色单独调 |
| 高级：请求头 | 每行一条 `Key: Value`，自建网关带网关 key / 组织 id 用 |
| 高级：timeoutMs / retries | 单次请求超时与重试次数 |
| 三个都用这套 | 把当前卡片的配置（含请求头、超时、重试）复制给另外两个角色 |

保存后**立刻生效**（下一轮运行就用新配置），并写回 `qzcode.json`；如果配置文件是 JSONC（带注释）写不动，会明确告诉你"只在内存生效"。

## 设置

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `qzcode.cliPath` | 空 | 后端 `cli.ts` 路径。**留空即可**（用自带后端）；只有想跑别处的开发版才填 |
| `qzcode.nodePath` | `node` | 跑 QZcode 的 node（需要 ≥ 22.19） |
| `qzcode.configFile` | 空 | `qzcode.json` 路径，留空用工作区的 |
| `qzcode.mock` | `false` | 用脚本化模型，不联网不需要 key |
| `qzcode.exec` | `true` | 允许 B/C 执行命令（关掉等于 `--no-exec`） |
| `qzcode.rounds` | `0` | 最大轮次，0 = 用配置文件里的值 |
| `qzcode.autoStart` | `false` | 激活扩展就把服务拉起来 |

第一次用建议先打开 `qzcode.mock`，把流程看一遍，再填 API key 跑真模型。

## 插件在 VS Code 里怎么用

**扩展没有自己的插件系统**——它启动的还是 `qzcode web`，插件由 `src/plugins/loader.ts` 从配置文件的 `plugins[]` 加载。所以路径只有一条：

```jsonc
// <工作区>/qzcode.json
{
  "plugins": [
    "./plugins/pi-style-extension.ts",   // pi 格式：registerTool / registerCommand / on(tool_call)
    "./plugins/example-plugin.ts"        // cordis 格式：{ name, inject, apply }
  ]
}
```

步骤：

1. `Ctrl+Shift+P` → **QZcode: 打开配置（插件在这里开关）**。没有 `qzcode.json` 会问你要不要生成模板。
2. 在 `plugins[]` 里写路径（相对配置文件所在目录，也可写绝对路径或裸包名）。
3. `Ctrl+Shift+P` → **QZcode: 重启服务**，让新插件生效。
4. 看效果：
   - GUI 右栏的 **插件** 卡片列出已加载的插件；
   - 命令面板里能输入扩展注册的 `/命令`（在 GUI 输入框里打 `/`）；
   - 加载失败会弹一个警告，点「打开插件配置」跳到配置，点「显示日志」看 `detail`（缺哪个包、缺哪个服务）。

插件能干什么、三种写法、`tool_call` / `tool_result` 钩子、DSH 兼容边界，都在后端仓库的 `docs/plugins.md`。

想验证插件真的生效，最省事的是用自带的两个例子：打开配置加上那两行，重启服务，然后让 B 跑一个任务——`pi-style-extension` 会拦住 `rm -rf` 这类命令、把 `API_KEY=` 打码，并给模型多一个 `count_lines` 工具。

## 注意

- 扩展**不会**替你改 `qzcode.json`；模型、key、插件都在仓库的配置里。
- 扩展把服务当子进程管，`deactivate` 或「停止服务」会杀掉它；端口是随机的，不会占固定端口。
- 需要 Node ≥ 22.19（QZcode 直接跑 `.ts`，不编译）。
- 这个扩展没有构建步骤，`main` 直接指向 `extension.cjs`；改了代码后 `Developer: Reload Window` 生效。
