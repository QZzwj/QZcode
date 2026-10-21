## 装

- **VS Code 市场**：扩展面板搜 `QZcode` → Install
- **离线 / vsix**：下载下面的 `qzcode-3.5.8.vsix` → `code --install-extension qzcode-3.5.8.vsix --force`

装完 `Ctrl+Shift+P` → `Developer: Reload Window`。前置条件只有一个：机器上有 **Node**。

## 这一版有什么

四角色接力：**L 管全程 → A 写任务书 → B 带工具实现 → C 只读核验**，C 不通过就退回 A 重写任务书，**最多 3 轮**。

![侧栏](https://github.com/QZzwj/QZcode/raw/main/vscode/media/readme/sidebar.png)

近期能力（3.3 → 3.5）：

| 能力 | 说明 |
|---|---|
| 计划模式 | 勾「先看任务书」只花 A 的钱出任务书，点「按这个做」才动手（这一轮跳过 L 和 A） |
| 多轮上下文 | 下一轮自动带上一轮的目标、结论、改动文件、验收标准 |
| `@文件` | 目标里写 `@src/utils.ts` 就把原文附给 A（最多 4 个、每个 6000 字） |
| 运行记录 | 每轮写 `.qzcode/runN.md`，记下 L/A/B/C 各自干了什么；侧栏可一键打开 |
| 快照 / 回滚 | 整轮回滚，或「回滚某个文件」逐个挑；新建文件回滚时删掉 |
| git 自动提交 | 只提交这次改过的路径；工作区不是仓库会先 `git init` |
| 预算硬闸 | 今日花费超 `cost.dailyBudget` 直接拒绝启动 |
| 断线恢复 | SSE 断了按 `since` 续传，跑完的补完收尾，后端重启过则明确告知 |
| 视觉模型 | 给纯文本的 C 挂一个能看图的模型，截图先转成文字描述 |
| 停止 | 硬中断（杀进程树），不是"发出取消请求后等它自己停" |

## 完整变更

见 [`CHANGELOG.md`](https://github.com/QZzwj/QZcode/blob/main/vscode/CHANGELOG.md)。

## 校验

- `201` 条单元测试通过；侧栏 UI 39 项、设置 34 项、断线恢复 5 项断言全部通过
- 包内含 `LICENSE`、`CHANGELOG`、`README`、128×128 图标、以及**自带的后端**（`backend/dist/cli.js`），装好即用，不需要克隆或构建
