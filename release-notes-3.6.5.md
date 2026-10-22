## 装

- **VS Code 市场**：扩展面板搜 `QZcode` → Install
- **离线 / vsix**：下载下面的 `qzcode-3.6.5.vsix` → `code --install-extension qzcode-3.6.5.vsix --force`

装完 `Ctrl+Shift+P` → `Developer: Reload Window`。不需要装 Node。

## 这一版：图片按 2 倍分辨率出

三张图仍是手写 SVG（唯一源），市场上的 PNG 从 1x 提到 **2x**，高分屏上不再发虚：

| 源（SVG） | 市场用 PNG | 尺寸 |
| --- | --- | --- |
| `assets/readme/hero.svg` | `vscode/media/readme/hero.png` | 2400×760（332 KB） |
| `assets/readme/roles.svg` | `vscode/media/readme/roles.png` | 2400×760（143 KB） |
| `assets/readme/sidebar.svg` | `vscode/media/readme/sidebar.png` | 2880×2080（583 KB） |

代价是包从 588 KB 涨到 **1.19 MB**——一个扩展包 1 MB 出头，对市场下载速度没有实际影响。

改图的流程没变：

```bash
# 改 assets/readme/*.svg
npm run images:marketplace     # 渲染 2x PNG + 同步 vscode/README.md 的引用
```

## 校验

- `206` 条单元测试通过；侧栏 39/39、设置 34/34、断线恢复 5/5
- `readme:check` 两处都通过（GitHub 用 SVG、市场用 PNG，且市场 README 里出现 `.svg` 会被这条检查拦住）
- SVG 实测：hero 24 段、roles 21 段、sidebar 20 段文字，零出界、零重叠
- 装好的 3.6.5 冒烟：electron 运行时 → `/api/health` ok → 跑完一轮 → `.qzcode/run1.md` 四段齐全
