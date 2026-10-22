## 装

- **VS Code 市场**：扩展面板搜 `QZcode` → Install
- **离线 / vsix**：下载下面的 `qzcode-3.6.2.vsix` → `code --install-extension qzcode-3.6.2.vsix --force`

装完 `Ctrl+Shift+P` → `Developer: Reload Window`。

## 四角色接力

```
L   管全程：决定这一轮怎么走（走完整流水线 / 直接回答 / 追问），活儿往下派
      └→ A 写任务书（提示词 + 验收标准）
           └→ B 带工具实现（读/写/改文件、跑命令；本机有 Chrome/Edge 时还能开浏览器验证）
                └→ A 复核 B 的产出，跑偏就退回重做
                     └→ C 只读核验（跑测试、看截图、给结论）
                          └→ 不通过就退回 A 重写任务书，最多 3 轮
```

![侧栏](https://github.com/QZzwj/QZcode/raw/main/vscode/media/readme/sidebar.png)

## 这一版改了什么

只是口径统一，没有功能变化：

- 对外继续用 **L 管全程**，但详情页括号里写清它实际决定的是"这一轮怎么走"（分流 / 直接回答 / 追问），不夸大也不含糊
- 设置面板里 L 的角色标题同步成「L · 管全程（决定这轮怎么走 · 省 token）」
- 仓库 README 与详情页写法对齐

## 前提

- **不需要装 Node**：本地服务跑在 VS Code 自带的运行时上（实测 VS Code 1.139.1 → Electron 43.6.0 → Node 24.20.0）
- **跑真模型要填一次 key**：设置面板里选供应商 + 填 key（写进 `qzcode.json`）；不填可以先用脚本化模型（mock）把流程走一遍
- 浏览器验证依赖本机已有的 Chrome / Edge；找不到时会提示，B 改用命令验证

## 校验

- `206` 条单元测试通过
- 侧栏 UI 39 项、设置 34 项、断线恢复 5 项断言通过
- 装好的包冒烟测试：用 VS Code 自带运行时启动 → `/api/health` ok → 完整跑完一轮 → `.qzcode/run1.md` 四段齐全
