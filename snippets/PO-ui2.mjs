import { readFileSync, writeFileSync } from 'node:fs'

// 1) 输入框提示：告诉用户可以用 @文件
{
  const path = 'vscode/pages.cjs'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    'placeholder="描述你想完成的事…"',
    'placeholder="描述你想完成的事…（可以用 @src/utils.ts 附上文件原文）"',
  )
  writeFileSync(path, code, 'utf8')
  console.log('pages.cjs：输入提示带上 @文件')
}

// 2) server：把上下文相关的两个函数导出，方便单测
{
  const path = 'src/web/server.ts'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    'function lastRunContext(workspace: string): string | undefined {',
    'export function lastRunContext(workspace: string): string | undefined {',
  )
  code = code.replace(
    'function rememberRunContext(workspace: string, run: RunState, status: string, result: unknown): void {',
    'export function rememberRunContext(workspace: string, run: RunState, status: string, result: unknown): void {',
  )
  writeFileSync(path, code, 'utf8')
  console.log('server.ts：导出 lastRunContext / rememberRunContext')
}

// 3) 侧栏：plan 模式的开关文案更明确
{
  const path = 'vscode/media/chat.js'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('plan-first')) {
    code = code.replace(
      `const gitBox = $("git-auto")`,
      `// 「先看任务书」开关：只在这次运行生效，不改配置
const planBox = $('plan-first')
if (planBox) {
  planBox.addEventListener('change', () => {
    setStatus(planBox.checked ? '这次只出任务书，确认后再动手' : '直接执行', 'live')
  })
}

const gitBox = $("git-auto")`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('chat.js：先看任务书开关的反馈')
  }
}
