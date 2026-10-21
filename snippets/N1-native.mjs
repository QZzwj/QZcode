import { readFileSync, writeFileSync } from 'node:fs'

// 1) 轨道节点补上字母（原生风里字母就是唯一标识）
{
  const path = 'vscode/pages.cjs'
  let code = readFileSync(path, 'utf8')
  const letters = { leader: 'L', planner: 'A', implementer: 'B', verifier: 'C' }
  for (const [role, letter] of Object.entries(letters)) {
    code = code.replace(
      `<span class="rail-node" data-role="${role}"></span>`,
      `<span class="rail-node" data-role="${role}">${letter}</span>`,
    )
  }
  writeFileSync(path, code, 'utf8')
  console.log('pages.cjs：轨道节点写上 L/A/B/C')
}

// 2) 消息头里的标题加 class，方便统一成次要色
{
  const path = 'vscode/media/chat.js'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    `  const title = el('span')
  title.textContent = pane === 'planner' ? '任务书' : pane === 'implementer' ? '实现' : '核验'`,
    `  const title = el('span', 'title')
  title.textContent = pane === 'planner' ? '任务书' : pane === 'implementer' ? '实现' : '核验'`,
  )
  writeFileSync(path, code, 'utf8')
  console.log('chat.js：消息头标题带 class')
}

// 3) 按钮保持 30px 命中区（原生工具栏 26px 偏小，a11y 断言要求 ≥30）
{
  const path = 'vscode/media/chat.css'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    `  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--qz-radius);
  background: none;
  color: var(--qz-muted);
  cursor: pointer;
}`,
    `  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--qz-radius);
  background: none;
  color: var(--qz-muted);
  cursor: pointer;
}`,
  )
  writeFileSync(path, code, 'utf8')
  console.log('chat.css：按钮 30px')
}

// 4) 检查脚本：语义色换成主题里的 ok/err
{
  const path = 'scripts/ui-check-chat.mjs'
  const lines = readFileSync(path, 'utf8').split('\n')
  const index = lines.findIndex((line) => line.includes("check('diff 块能展开且有 +/− 配色'"))
  if (index >= 0) {
    lines[index] =
      "check('diff 块能展开且有 +/− 配色', patchUi.expanded === true && /115,\\s*201,\\s*145/.test(patchUi.addColor ?? '') && /244,\\s*135,\\s*113/.test(patchUi.delColor ?? ''), JSON.stringify({ add: patchUi.addColor, del: patchUi.delColor }))"
  }
  writeFileSync(path, lines.join('\n'), 'utf8')
  console.log('ui-check-chat：diff 配色断言换成主题色')
}
