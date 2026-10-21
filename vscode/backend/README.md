# QZcode

四个模型接力把一句话目标做成可交付的改动：

```
L 管全程 → A 写任务书 → B 实现 → C 核验 → （不通过退回 A 重写，最多 3 轮）
```

- **侧栏聊天**是唯一界面（VS Code 右侧栏，跟着你的主题配色）。
- **后端自带**：扩展里打包好了 `backend/dist/cli.js`，装完就能用，不需要克隆、不需要构建。
- 用户文档见 [`vscode/README.md`](vscode/README.md)（打包时就是它进 vsix）。

---

## 目录

```
src/                 后端（Node 直接跑 .ts，无需编译；扩展里跑的是打包好的 dist/cli.js）
  kernel.ts          插件/工具/命令的装配
  agent.ts           单个角色的工具循环
  llm.ts             OpenAI 兼容 SSE 客户端（含截断重试、心跳）
  roles.ts           L/A/B/C 四个角色的提示词与步骤
  pipeline.ts        流水线：路由 → 计划 → 实现 → 复核 → 核验
  tools.ts           read/write/edit/grep/find/ls/bash/browser
  browser.ts         CDP 驱动的真浏览器（截图、点按、按住蓄力）
  snapshot.ts        改动前快照 / 回滚 / diff
  git.ts             自动提交（只提交这次改过的路径，必要时 git init）
  runlog.ts          每轮写 .qzcode/runN.md
  cost.ts            记账与按步骤的速度统计
  steps.ts           每步的模型耗时 / 输出 token 计量
  reference.ts       @文件 引用解析
  vision.ts          视觉模型（给纯文本的 C 当"第二双眼睛"）
  doctor.ts          体检（15 项）
  config.ts          配置归一化与默认值
  web/server.ts      HTTP + SSE（侧栏直连它）

vscode/              扩展
  extension.cjs      激活、命令、订阅、后端进程管理
  lib.cjs            页面 HTML、cli 路径解析、csp
  pages.cjs          两个页面的 HTML 模板（安装包里没有 .html 文件）
  media/chat.*       侧栏聊天（js/css）
  media/settings.*   设置面板（模型 / 技能 / 成本）
  backend/           打包进 vsix 的后端（dist + prompts + skills + plugins）

test/                201 条测试（node --test）
scripts/             打包、清理、UI 验收、预览、探针
docs/                架构说明
snippets/            临时补丁脚本（gitignore）
vsix-history/        每个版本的安装包存档
```

---

## 开发

```powershell
npm run typecheck          # tsc --noEmit
npm test                   # 201 条：node --test
npm run check              # typecheck + test
npm run ui:check           # 三个真实渲染的 UI 验收（侧栏 / 设置 / 断线恢复）
npm run demo               # mock 跑一轮（脚本化模型，不联网）
npm run start              # 起后端（TUI）
npm run web                # 起后端（只提供 API + SSE）
```

UI 验收不是看截图，而是用 CDP 打开真页面量数值：对比度、焦点环、触摸命中区、横向溢出、圆角下限、空状态是否居中、结论是否居中、事件顺序……主模型看不了图，所以这套量化断言是唯一能保证"没画歪"的手段。

---

## 打包与发布

```powershell
npm run bundle:backend     # 把 src/ 打成一个 dist/cli.js
cd vscode
node ../node_modules/@vscode/vsce/vsce package --allow-missing-repository --no-dependencies --skip-license -o ../qzcode.vsix
cd ..
code --install-extension qzcode.vsix --force
```

`vscode/.vscodeignore` 是**白名单**（`*` + `!xxx`）。新增后端文件后一定要确认它在白名单里，否则装完 require 失败、面板打不开——这条有测试守着（`打包清单必须覆盖所有 require`）。

每版都往 `vsix-history/` 留一份安装包，回退就是装回旧包。

---

## 关键设计决定

| 决定 | 为什么 |
|---|---|
| 后端只提供 API + SSE，页面在扩展里 | 减少一份要维护的 GUI；侧栏才是每天用的地方 |
| 页面 HTML 放在 `pages.cjs` 而不是 `.html` | 安装包里不出现 html 文件；预览/验收脚本直接调 `lib.chatWebviewHtml()`，不会和产品漂移 |
| 停止 = 硬中断（abort → 杀进程树） | `write` 是同步写，不会写出半个文件；等工具自然结束会让"停止"看起来像没反应 |
| 预算超了直接拒绝启动 | 跑到一半因预算停更糟 |
| 自动提交只 `git add <这次改过的路径>` | 不把用户自己未提交的改动卷进提交 |
| 每步速度只算输出 token、只算模型时间 | 输入 token 不是"生成"的；跑命令的时间不是模型在生成 |
| 运行记录写 markdown | 人可读、git 可 diff、不需要数据库 |

---

## 收尾检查清单（改完代码照着走）

1. `npm run check` 全绿
2. `npm run ui:check` 全绿
3. `npm run bundle:backend` → 打包 → 装 → **Reload Window**
4. 跑一轮 mock，确认：侧栏出结果、`.qzcode/runN.md` 有内容、有 diff 入口
5. `Copy-Item qzcode-*.vsix vsix-history\` 并 `git commit`
