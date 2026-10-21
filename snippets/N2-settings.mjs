import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/media/settings.css'
let code = readFileSync(path, 'utf8')
const done = []

// 1) 角色色换成 VS Code 自带的图表色（会随主题走，不再是我拍的四个人工色）
{
  const hues = {
    '--qz-leader': 'var(--vscode-charts-blue, #3794ff)',
    '--qz-planner': 'var(--vscode-charts-purple, #b180d7)',
    '--qz-implementer': 'var(--vscode-charts-green, #89d185)',
    '--qz-verifier': 'var(--vscode-charts-orange, #d18616)',
  }
  let changed = false
  for (const [token, value] of Object.entries(hues)) {
    const light = new RegExp(`  ${token}: #[0-9a-f]{6};\\n`, 'g')
    code = code.replace(new RegExp(`  ${token}: #[0-9a-f]{6};`, 'g'), `  ${token}: ${value};`)
    void light
  }
  if (code.includes('var(--vscode-charts-blue')) changed = true

  // 浅色主题那一段里的覆盖（如果有）也换掉，免得主题切换后颜色又变成我拍的
  code = code.replace(/\n  --qz-leader: #[0-9a-f]{6};\n  --qz-planner: #[0-9a-f]{6};\n  --qz-implementer: #[0-9a-f]{6};\n  --qz-verifier: #[0-9a-f]{6};/, '')
  if (changed) done.push('角色色 → 图表色')
}

// 2) 主按钮用主题的按钮色
if (code.includes('background: var(--qz-accent);')) {
  code = code.replace(
    /button\.primary \{\n  background: var\(--qz-accent\);\n  border-color: transparent;\n  color: var\(--qz-accent-ink\);/,
    `button.primary {
  background: var(--vscode-button-background, var(--qz-accent));
  border-color: transparent;
  color: var(--vscode-button-foreground, var(--qz-accent-ink));`,
  )
  code = code.replace(
    `button.primary:hover { filter: brightness(1.06); }`,
    `button.primary:hover { background: var(--vscode-button-hoverBackground, var(--qz-accent)); filter: none; }`,
  )
  done.push('主按钮 → 主题按钮色')
}

// 3) 圆角收回原生尺寸
code = code.replace('--qz-radius: 10px;', '--qz-radius: 4px;')
code = code.replace('--qz-radius-sm: 7px;', '--qz-radius-sm: 3px;')

writeFileSync(path, code, 'utf8')
console.log('settings.css:', done.join(' / ') || '(无改动)')
