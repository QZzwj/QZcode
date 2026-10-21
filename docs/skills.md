# 技能（skill）

每个角色都可以挂一段「方法论」，跟着系统提示词一起下发。内置三个：

| 技能 | 适用角色 | 内容 |
| --- | --- | --- |
| `prompt-writer` | L / A | 先定交付物与完成信号，再写约束；不给口号、不写固定测试次数 |
| `code-implementer` | B | 先读再改、最小改动、真实自证、命令匹配 shell |
| `verified-delivery` | C | 逐条对验收标准、亲自跑命令、blocker 一票否决、只看不改 |

## 导入技能

设置面板右上角 **「导入技能」**，支持四种来源：

| 你填什么 | 走哪条路 |
| --- | --- |
| `~/skills/my-skill/SKILL.md` | 本地文件 |
| `~/skills/my-skill`（目录，含 SKILL.md） | 本地目录 |
| `https://raw.githubusercontent.com/…/SKILL.md` | 下载 |
| 直接粘贴 markdown 正文 | 当成文本 |

导入的技能默认只给 **B 和 C**，用 front matter 可以改：

```markdown
---
name: my-skill
title: 我的技能
roles: implementer, verifier
description: 一句话说明这个技能解决什么
---
正文（会被追加到该角色的系统提示词）
```

## 生效规则

- **内置技能**：只要角色的 front matter 命中就生效，勾选列表管不到它（不会被"勾了一个导入技能"挤掉）
- **导入技能**：按角色勾选生效；一个都没勾 = 按它自己声明的 `roles` 全生效
- **停用**：配置里写 `"skills": { "disabled": ["my-skill"] }`；整体关掉用 `"skills": { "enabled": false }`
- 技能目录：配置 `skills.dir`；不填就用配置文件旁边的 `skills/`

查看当前生效：命令面板 → `QZcode: 诊断侧栏图标` 旁边的输出面板里会打印技能列表，或直接看设置面板每张卡片的「技能」区块。
