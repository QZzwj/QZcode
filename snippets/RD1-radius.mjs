import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/media/chat.css'
let code = readFileSync(path, 'utf8')
const done = []

// 圆角整体放大一档：从"硬邦邦的 2px"到"有点柔软的 6px"，其余不动
const replaces = [
  [`  --qz-radius: 2px;`, `  --qz-radius: 6px;\n  --qz-radius-sm: 4px;\n  --qz-radius-pill: 999px;`, '圆角令牌'],
  // 你的话
  [`.msg.user .text {
  padding: 6px 8px;
  border-radius: var(--qz-radius);`, `.msg.user .text {
  padding: 7px 10px;
  border-radius: var(--qz-radius) var(--qz-radius) var(--qz-radius-sm) var(--qz-radius);`, '消息块'],
  // 行内代码
  [`.text code {
  padding: 0 3px;
  border-radius: var(--qz-radius);`, `.text code {
  padding: 1px 4px;
  border-radius: var(--qz-radius-sm);`, '行内代码'],
  // 代码块
  [`.text pre {
  margin: 6px 0;
  padding: 6px 8px;
  border: 1px solid var(--qz-line-soft);
  border-radius: var(--qz-radius);`, `.text pre {
  margin: 6px 0;
  padding: 7px 9px;
  border: 1px solid var(--qz-line-soft);
  border-radius: var(--qz-radius-sm);`, '代码块'],
  // 标签做成胶囊
  [`.tag {
  padding: 0 5px;
  border: 1px solid var(--qz-line);
  border-radius: var(--qz-radius);`, `.tag {
  padding: 1px 7px;
  border: 1px solid var(--qz-line);
  border-radius: var(--qz-radius-pill);`, '标签'],
  // diff 块
  [`.patch-body {
  margin: 3px 0 0;
  padding: 6px 8px;
  border: 1px solid var(--qz-line-soft);
  border-radius: var(--qz-radius);`, `.patch-body {
  margin: 4px 0 0;
  padding: 7px 9px;
  border: 1px solid var(--qz-line-soft);
  border-radius: var(--qz-radius-sm);`, 'diff 块'],
  // 输入框
  [`.composer-box {
  border: 1px solid var(--qz-input-border);
  border-radius: var(--qz-radius);`, `.composer-box {
  border: 1px solid var(--qz-input-border);
  border-radius: var(--qz-radius);`, '输入框（沿用令牌）'],
  // 供应商 chip 做成胶囊
  [`.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 64%;
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: var(--qz-radius);`, `.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 64%;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: var(--qz-radius-pill);`, 'chip'],
  // 按钮
  [`  border: 1px solid transparent;
  border-radius: var(--qz-radius);
  background: none;
  color: var(--qz-muted);
  cursor: pointer;
}`, `  border: 1px solid transparent;
  border-radius: var(--qz-radius-sm);
  background: none;
  color: var(--qz-muted);
  cursor: pointer;
}`, '图标按钮'],
]

for (const [from, to, label] of replaces) {
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push(label)
  }
}

// 呼吸感：消息间距和输入区留白各加一点点（只是"软"的体感，不动结构）
code = code.replace(`.msg {
  margin-bottom: 10px;`, `.msg {
  margin-bottom: 12px;`)
code = code.replace(`.thread {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 10px 12px;`, `.thread {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px 11px 14px;`)

writeFileSync(path, code, 'utf8')
console.log('chat.css 圆角/留白:', done.join('、') || '(无改动)')

// 设置面板同步放宽：4px → 6px
{
  const settingPath = 'vscode/media/settings.css'
  let css = readFileSync(settingPath, 'utf8')
  css = css.replace('--qz-radius: 4px;', '--qz-radius: 6px;')
  css = css.replace('--qz-radius-sm: 3px;', '--qz-radius-sm: 4px;')
  writeFileSync(settingPath, css, 'utf8')
  console.log('settings.css：圆角 6px / 4px')
}
