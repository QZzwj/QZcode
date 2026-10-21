## 装

- **VS Code 市场**：扩展面板搜 `QZcode` → Install
- **离线 / vsix**：下载下面的 `qzcode-3.6.0.vsix` → `code --install-extension qzcode-3.6.0.vsix --force`

装完 `Ctrl+Shift+P` → `Developer: Reload Window`。**不需要装 Node**——本地服务跑在 VS Code 自带的运行时上。

## 这一版的重点：不需要装 Node 了

之前本地服务是 `spawn("node", ...)`，所以机器上必须有 Node。现在改成用 VS Code 自己的可执行文件 + `ELECTRON_RUN_AS_NODE=1`，同一个二进制就变成了 Node 运行时：

```
VS Code 1.139.1 / Electron 43.6.0 / Node 24.20.0
```

实测（把 PATH 里所有含 node 的目录剔掉再跑）：后端照常起来、`/api/health` 正常、完整跑完一轮、`.qzcode/run1.md` 正常写出。

想用别的 node（比如想锁版本）：设置里填 `qzcode.nodePath` 即可，留空就用自带的。

## 四角色接力

```
L 管全程（派活 · 盯进度 · 打回返工）
   └→ A 写任务书（提示词 + 验收标准）
        └→ B 带工具实现（读/写/改文件、跑命令、开浏览器验证）
             └→ C 只读核验（跑测试、看截图、给结论）
                  └→ 不通过就退回 A 重写任务书，最多 3 轮
```

![侧栏](https://github.com/QZzwj/QZcode/raw/main/vscode/media/readme/sidebar.png)

## 能力一览

| 能力 | 说明 |
|---|---|
| 计划模式 | 勾「先看任务书」只花 A 的钱出任务书，点「按这个做」才动手 |
| 多轮上下文 | 下一轮自动带上一轮的目标、结论、改动文件、验收标准 |
| `@文件` | 目标里写 `@src/utils.ts` 就把原文附给 A |
| 运行记录 | 每轮写 `.qzcode/runN.md`，记下 L/A/B/C 各自干了什么 |
| 快照 / 回滚 | 整轮回滚，或按文件逐个挑 |
| git 自动提交 | 只提交这次改过的路径；不是仓库会先 `git init` |
| 预算硬闸 | 今日花费超预算直接拒绝启动 |
| 断线恢复 | SSE 断了按 `since` 续传，跑完的补完收尾 |
| 视觉模型 | 给纯文本的 C 挂一个能看图的模型 |
| 停止 | 硬中断（杀进程树） |

## 校验

- `206` 条单元测试通过（新增 5 条运行时解析测试）
- 侧栏 UI 39 项、设置 34 项、断线恢复 5 项断言全部通过
- 包内含 `LICENSE`、`CHANGELOG`、`README`、128×128 图标、自带后端
