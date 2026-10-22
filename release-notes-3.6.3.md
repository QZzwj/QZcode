## 装

- **VS Code 市场**：扩展面板搜 `QZcode` → Install
- **离线 / vsix**：下载下面的 `qzcode-3.6.3.vsix` → `code --install-extension qzcode-3.6.3.vsix --force`

装完 `Ctrl+Shift+P` → `Developer: Reload Window`。不需要装 Node。

## 这一版：README 重做

按 [beautify-github-readme](https://github.com/oil-oil/beautify-github-readme) 的方法把首页重排了一遍（内容与顺序，不只是换皮）：

- **首屏**：新增 `assets/readme/hero.svg`（1200×380，纯 SVG）——左侧是名字与一句实话，右侧直接摆四角色接力带、真实工具行 `write OK 96ms`、改动 `+42 −0`、居中的"通过"。视觉素材全部来自产品本身，没有装饰图。
- **顺序**：先给证据（真实侧栏截图）→ 再说它是什么 → 为什么不是一个模型边说边改 → 怎么装 → 第一次用 → 留下什么 → 命令表 → 配置 → 已知限制 → 自己打包。
- **新增** `assets/readme/roles.svg`：四角色分工图，含"不通过退回 A 重写（最多 3 轮）"的虚线回路。
- **删除**：README 里大量重复的承诺句和内部实现细节，架构说明挪到 `docs/architecture.md`。
- **插件详情页**：首屏也换成 hero 图（市场不渲染 SVG，所以用同一张图的 PNG 版本）。

顺带加了两个自检，以后改 README 不用靠眼睛：

```bash
npm run svg:check      # 在真渲染器里量每段文字的包围盒：出界 / 重叠 / 字号过小
npm run readme:check   # 图片存在性、绝对路径、alt、首屏是否有图 + 上面的 SVG 检查
```

## 校验

- `206` 条单元测试通过；侧栏 39/39、设置 34/34、断线恢复 5/5
- `npm run readme:check`：7 张图（本地 3 + 远程 4）全部可解析、无绝对路径、全有 alt、首屏有图；两个 SVG 各 21–24 段文字，**零出界、零重叠**
- 用 Skill 自带的 `audit_readme.py` 也过了一遍：`OK: image references and SVG basics passed`
