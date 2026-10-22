## �?
- **VS Code 市场**：扩展面板搜 `QZcode` �?Install
- **离线 / vsix**：下载下面的 `qzcode-3.6.4.vsix` �?`code --install-extension qzcode-3.6.4.vsix --force`

装完 `Ctrl+Shift+P` �?`Developer: Reload Window`。不需要装 Node�?
## 这一版：图片全部改为 SVG �?
三张图现在都是手�?SVG（可编辑、体积小、随窗口缩放不糊）：

| 文件 | 用�?|
| --- | --- |
| `assets/readme/hero.svg` | 首屏：名�?+ 一句实�?+ 四角色接力带 + 真实工具�?diff/结论 |
| `assets/readme/roles.svg` | 四角色分工图（含"不通过退�?A 重写，最�?3 �?的回路） |
| `assets/readme/sidebar.svg` | 侧栏界面示意 |

**GitHub README 直接引用 SVG**，两�?SVG 都在真渲染器里量过：21�?4 段文字，零出界、零重叠�?
## 但插件描述这条路�?vsce 堵死�?
VS Code 市场**不接�?README 里的 SVG**，不是偏好问题，是硬限制�?
```text
ERROR  SVGs are restricted in README.md; please use other file image formats, such as PNG:
       https://github.com/QZzwj/QZcode/raw/main/vscode/media/readme/hero.svg
```

vsce 源码里的判定（`package.js`）：remote 来源只要路径�?`.svg` 结尾且不在白名单域名内，直接抛错，打包失败�?
所以现在的做法�?*一份源文件、两种产�?*�?
```bash
npm run images:marketplace   # �?vscode/media/readme/*.svg 渲染成同�?PNG，并自动�?vscode/README.md 的引�?```

- `vscode/media/readme/*.svg` —�?唯一的源（改这里�?- `vscode/media/readme/*.png` —�?打包生成物，只有市场�?- GitHub README �?SVG，插件详情页�?PNG

改一�?SVG 跑一条命令就同步，不用手改两处。而且 `npm run readme:check` 现在�?*拦住**"市场 README 里写�?.svg"这种回退——你要是手滑写回 `.svg`，检查会直接�?vsce 那条错�?
## 校验

- `206` 条单元测试通过；侧�?39/39、设�?34/34、断线恢�?5/5
- `readme:check`：仓�?README�? �?SVG）、插件详情页�? �?PNG）都通过
- �?588 KB（三张图 1x 后从 1.19 MB 降到 588 KB�?- 装好�?3.6.4 冒烟：electron 运行�?�?health ok �?跑完一�?�?run1.md 四段齐全
