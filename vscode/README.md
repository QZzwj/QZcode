# QZcode for VS Code

> 作者：**QZzwj**

在编辑器里跑一条**四角色接力**的流水线：

```
L 管全程（派活 · 盯进度 · 打回返工）
   └→ A 写任务书（提示词 + 验收标准）
        └→ B 带工具实现（读/写/改文件、跑命令、开浏览器验证）
             └→ C 只读核验（跑测试、看截图、给结论）
                  └→ 不通过就退回 A 重写任务书，最多 N 轮
```

装好即用：**扩展自带后端**（`backend/` 里是打好包的 QZcode 服务），不需要克隆仓库、不需要 `npm install`、不需要构建。

---

## 装

```powershell
# 1) 打包（把后端一起打进去，约 200 KB）
npm run bundle:backend
cd vscode
node ../node_modules/@vscode/vsce/vsce package --allow-missing-repository --no-dependencies --skip-license -o ../qzcode.vsix
cd ..

# 2) 安装
code --install-extension qzcode.vsix --force
code --list-extensions --show-versions | Select-String qzcode    # → qzcode.qzcode@<版本>
# 卸载：code --uninstall-extension qzcode.qzcode
```

然后 `Ctrl+Shift+P` → `Developer: Reload Window`。

**前置条件只有一个：机器上有 Node。**

- 扩展跑的是 `backend/dist/cli.js`（已打包成纯 JS），**不需要** Node 的类型剥离能力；本机实测 Node 24.19。
- 只有"开发版"直接跑 `src/*.ts` 时才需要 **Node ≥ 22.19**（靠类型剥离）。
- `qzcode.nodePath` 可以指定别的 node。

---

## 第一次用：先看流程，再填 key

`Ctrl+Shift+P` → `QZcode: 设置（模型 / 技能）` → 把三个角色的供应商选上、填 key。或者先不填：

```powershell
# 设置里打开「用脚本化模型」，或命令行起 mock
```

打开 `qzcode.mock` 后是脚本化模型（不联网、不需要 key），可以完整看一遍 L→A→B→C 的接力、工具调用、diff、核验结论，再切真模型。

---

## 界面：右侧栏一个聊天

装好后 VS Code 右侧（辅助侧边栏）出现 QZcode 图标（品牌 logo，透明底，深浅色主题都看得清）。第一次没看到就 `Ctrl+Shift+P` → `QZcode: 打开侧栏聊天`。

```
┌ QZ 接力 ──────────────── D:\work\demo ┐
│                          ← 顶部：品牌 / 模式 / 当前工作区
│  A 写好了，B 去做                       │   ← 模型输出（markdown）
│  → write OK 96ms index.html            │   ← 工具调用压成一行
│  ▸ 修改 index.html +42 −0   展开        │   ← 文件改动，点开看 diff
│                                        │
│  ✔ 通过                                │   ← 结论单独一行、居中
│                                        │
│ ┌────────────────────────────────────┐ │
│ │ 描述你想完成的事…（可用 @文件）     │ │
│ │ (•) hhd·deepseek  ▤  ＋  ↑/■       │ │
│ └────────────────────────────────────┘ │
│ ☐ 先看任务书   ☐ 每次改动自动 git 提交 │
│                          已运行 12.3s  │
└────────────────────────────────────────┘
```

| 控件 | 作用 |
|---|---|
| 供应商 chip | 当前 `provider · model`，点一下弹选择器（换一家会顺便问 key），下一轮生效，不用重启 |
| ＋ | 清空当前对话，开新任务 |
| ↑ / ■ | 同一个按钮：空闲=发送（Enter），运行中=停止（也是 Esc）。停止是**硬中断**，正在跑的 shell 命令会被掐掉 |
| 先看任务书 | 计划模式：只跑到 A 出任务书就停，等你点「按这个做」才动手 |
| 每次改动自动 git 提交 | 只提交这次真改过的文件；工作区没有仓库时会先 `git init` |
| 底部状态行 | 跟着流水线走：`第 1 轮 · B 实现` → `✔ 完成 · 1 轮 · 18.4s · 6997 tok` |

发出去到第一个字之间会显示 **正在思考中 ···**；断线会自动续传（先问后端"这次运行还在吗"，在跑就补齐丢的事件，跑完就收尾，后端重启过就明确告诉你"进度丢了"并给「重新发送 / 重启后端」）。

---

## 命令（Ctrl+Shift+P）

| 命令 | 作用 |
|---|---|
| `QZcode: 打开侧栏聊天` | 聚焦右侧对话视图（同一个图标） |
| `QZcode: 新建任务…` | 输入目标直接开跑 |
| `QZcode: 用选中代码当目标…` | 右键选中代码也能用 |
| `QZcode: 设置（模型 / 技能）` | 模型 / 技能 / 成本三个页签的设置面板 |
| `QZcode: 更换 AI 供应商…` | 快速切换（四个角色一起换） |
| `QZcode: 打开配置（插件在这里开关）` | 打开 `qzcode.json`，没有就问要不要生成模板 |
| `QZcode: 强制停止当前运行` | 同侧栏那个 ■ |
| `QZcode: 查看本次改动（diff）` | VS Code 原生 diff：左快照、右现状 |
| `QZcode: 回滚本次运行的文件改动` | 模态确认后整轮还原（新建的文件会删掉） |
| `QZcode: 打开运行记录` | 挑一轮 `.qzcode/runN.md` 打开 |
| `QZcode: 体检（环境自检）` | 15 项检查：node / 配置 / 工作区写权限 / shell / 四个角色 / 网络 / 技能 / 插件 |
| `QZcode: 显示日志` | 服务端 stdout/stderr |
| `QZcode: 重启服务` / `停止服务` | 改完配置后用 |
| `QZcode: 诊断侧栏图标（为什么有两个）` | 排查图标重复 |

---

## 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| `qzcode.cliPath` | 空 | 后端入口。留空即可（用自带后端）；只有想跑别处的开发版才填 |
| `qzcode.nodePath` | `node` | 跑 QZcode 的 node |
| `qzcode.configFile` | 空 | `qzcode.json` 路径，留空用工作区的 |
| `qzcode.mock` | `false` | 脚本化模型，不联网不需要 key |
| `qzcode.exec` | `true` | 允许 B/C 执行 shell 命令（关掉等于 `--no-exec`） |
| `qzcode.rounds` | `0` | 最大轮次，0 = 用配置文件里的值 |
| `qzcode.autoStart` | `false` | 激活扩展就延迟 1.5s 把服务拉起来 |
| `qzcode.log` | `false` | 诊断日志写进 `.qzcode/debug.log` |

---

## 配置放哪

| 位置 | 何时用 |
|---|---|
| `<工作区>/qzcode.json`（或旧名 `pi-trio.json`） | 有就用它 |
| `%APPDATA%\Code\User\globalStorage\qzcode.qzcode\qzcode.json` | 工作区没有就用全局的，不污染你的项目 |
| 都没有 | 自动以 mock 起来，先用；在设置里选供应商会把配置写出来 |

**供应商**：内置 16 家平台的清单（Astron Coding Plan / Baidu Qianfan / BaiLing / BytePlus / DeepSeek / 火山 Agent Plan / Kimi / Longcat / MiniMax / 千问AI平台 / QwenCloud / StepFun / 腾讯云 / Xiaomi MiMo / Zhipu GLM / OpenAI）+「自定义（手动填写全部字段）」。选中会把接口地址和模型填上，key 还要自己填。你正在用的那家（比如自建的 `hhd`）会排在最前面。

> 清单里少数平台的兼容地址我没实测过，选中后如果"测试连接"报 401/404，按官方文档改一下「接口地址」即可。

---

## 每次运行会留下什么

```
<工作区>/.qzcode/
  run1.md                 ← 这一轮 L / A / B / C 各自干了什么（决策、任务书、工具调用、改动、结论、各步速度）
  run2.md
  snapshots/<runId>/      ← 改之前的原件，回滚用
  shots/                  ← 浏览器验证的截图
  debug.log               ← 开了 qzcode.log 才有
```

- **运行记录**：每轮一份，编号跟着工作区里已有的 `runN.md` 往后排。侧栏结束后有「查看本轮记录」。
- **快照 / 回滚**：B 第一次改某个文件前先存原件（同一文件只存一次）。结束后可以整轮回滚，也可以「回滚某个文件」逐个挑；新建的文件回滚时删掉。
- **git**：开了自动提交就只提交这次改过的路径，绝不用 `git add -A`；工作区不是仓库会先 `git init`（提交身份缺失时只对这次命令临时补 `Qzcode <qzcode@local>`，不改你的 git 配置）。

---

## 几个用起来有用的细节

- **计划模式**：勾「先看任务书」→ 只花 A 的钱，看完不满意可以直接改目标重跑；点「按这个做」时才花 B/C 的钱（这一轮跳过 L 和 A）。
- **多轮上下文**：下一轮自动带上一轮的目标、结论、改动文件、验收标准，所以「把它改成深色」这种话不用重新交代背景。
- **@文件**：目标里写 `@src/utils.ts`，后端会把原文附给 A（最多 4 个、每个 6000 字，超长截断；路径越界/二进制会拒绝并说明）。
- **预算硬闸**：今日花费达到 `cost.dailyBudget` 时直接拒绝启动，告诉你花到多少了。改预算后要 `QZcode: 重启服务` 才生效。
- **视觉模型（C 的双模型）**：设置 → 模型 → C 卡片最下面勾「挂一个视觉模型」，填一个能看图的模型名。之后 C 每次截图都会先让视觉模型看一遍，把文字描述塞进工具输出——纯文本的 C 也能"看"画面。默认关闭，每次运行最多看几张图可设上限。
- **成本与速度**：设置 → 成本按步骤列出 L/A/B/C 各自的「最快 / 平均 tok/s、用时、调用次数」，只算输出 token、只算模型时间（不含跑命令的时间）。
- **技能**：设置 → 技能可以按角色启用内置技能（实现纪律 / 核验纪律 / 任务书写作），也能导入自己的（本地路径、https 链接、直接粘贴 markdown）。
- **插件**：由后端的 `src/plugins/loader.ts` 从配置文件的 `plugins[]` 加载，支持 pi 格式（`registerTool` / `registerCommand` / `on('tool_call')`）和 cordis 格式（`{ name, inject, apply }`）。改完 `QZcode: 重启服务` 生效。

---

## 从旧版升级要知道的

| 旧版（0.3.x） | 现在 |
|---|---|
| 三模型 A/B/C | **四角色 L/A/B/C**，L 是管全程的主控（分流、派活、打回返工） |
| 有"三栏工作台"大面板 | **已移除**，只保留侧栏聊天 |
| 后端提供 GUI 网页 | **已移除**，后端只提供 API + SSE |
| 扩展从"你打开的工作区"找 `src/cli.ts` | **自带后端**，查找顺序：`qzcode.cliPath` → `<扩展>/backend/dist/cli.js` → `<扩展>/backend/src/cli.ts` → 同级仓库 → 工作区 |
| 供应商只有 6 个预设 | 16 家平台清单 + 自定义 |

---

## 已知限制

- 计划模式那一轮**不改任何文件**，也不会做 git 提交（记录文件照写）。
- 「运行中切工作区会中断任务」的确认只在**切文件夹**时弹；同一文件夹内切文件不会触发。
- 断线恢复靠后端内存里的运行对象：如果后端重启过，那次运行的实时进度就找不回来了（已改的文件和 `runN.md` 还在）。
- 预算硬闸读的是启动时的配置，改完要重启服务。
- 视觉模型需要你自己填一个"能看图"的模型名；填了文本模型会报错。

---

## 开发 / 调试（不装扩展）

用 VS Code 打开仓库，按 F5（扩展开发宿主）。仓库里带了 `.vscode/launch.json`：

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

改了 `extension.cjs` / `media/*` 用 `Developer: Reload Window`；改了 `src/`（后端）要重新 `npm run bundle:backend` 并 `QZcode: 重启服务`。

---

## 注意

- 扩展**不会替你改** `qzcode.json`：模型、key、插件都在配置里（设置面板保存时会写）。
- 扩展把后端当子进程管：`deactivate` 或「停止服务」会杀掉它；端口随机，不占固定端口。
- 这个扩展没有构建步骤，`main` 直接指向 `extension.cjs`。
