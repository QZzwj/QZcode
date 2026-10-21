import { readFileSync, writeFileSync } from 'node:fs'

// 1) UI：开关存在 + 结束后的入口存在
{
  const path = 'scripts/ui-check-chat.mjs'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('先看任务书')) {
    const anchor = "check('输入框下面有 git 自动提交开关'"
    const insert = `const entries = await evaluate(\`(() => {
  const plan = document.getElementById('plan-first');
  const links = [...document.querySelectorAll('.snapshot-actions .link')].map((n) => n.textContent.trim());
  return {
    hasPlanToggle: Boolean(plan) && plan.type === 'checkbox',
    links,
  };
})()\`)
check('输入框下面有「先看任务书」开关', entries.hasPlanToggle === true)
check('结束后有「查看本轮记录」入口', entries.links.some((text) => /本轮记录/.test(text)), JSON.stringify(entries.links))
check('结束后能按单个文件回滚', entries.links.some((text) => /回滚某个文件/.test(text)), JSON.stringify(entries.links))

${anchor}`
    code = code.replace(anchor, insert)
    writeFileSync(path, code, 'utf8')
    console.log('ui-check-chat：加了开关与入口断言')
  }
}

// 2) 结构断言：这次新增的面板/接口都在
{
  const path = 'test/vscode.test.ts'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('计划模式与记录入口')) {
    code += `
test('计划模式与记录入口：前后端都接上了', () => {
  const chat = readFileSync(join(repoRoot, 'vscode', 'media', 'chat.js'), 'utf8')
  const ext = readFileSync(join(repoRoot, 'vscode', 'extension.cjs'), 'utf8')
  const server = readFileSync(join(repoRoot, 'src', 'web', 'server.ts'), 'utf8')
  const page = readFileSync(join(repoRoot, 'vscode', 'pages.cjs'), 'utf8')

  // ① 计划模式
  assert.match(page, /id="plan-first"/, '输入框下面要有"先看任务书"开关')
  assert.match(chat, /planOnly:/, '发送时要带 planOnly')
  assert.match(chat, /按这个做/, '任务书出来后要有确认按钮')
  assert.match(chat, /continuePlan/, '确认按钮要能发 continuePlan')
  assert.match(ext, /message\\.type === 'continuePlan'/, '扩展要处理 continuePlan')
  assert.match(server, /path === '\\/api\\/continue'/, '后端要有 /api/continue')

  // ② 多轮上下文
  assert.match(server, /previousContext/, '要把上一轮上下文传进流水线')
  assert.match(server, /rememberRunContext/, '要记住上一轮')

  // ③ 运行记录入口
  assert.match(chat, /openRunLog/, '侧栏要有打开记录的入口')
  assert.match(ext, /async function openRunLog/, '扩展要能打开记录文件')
  assert.match(ext, /qzcode\\.openRunLog/, '要有命令')
  assert.match(server, /runLogPath/, '接口要回记录路径')

  // ④⑤ 回滚
  assert.match(chat, /rollbackFile/, '要能按文件回滚')
  assert.match(chat, /回滚这次改动/, '取消后也要能回滚')
  assert.match(server, /paths: \\[|body\\.paths/, '回滚接口要接受路径')
  assert.match(readFileSync(join(repoRoot, 'src', 'snapshot.ts'), 'utf8'), /only\\?: string\\[\\]/, '快照还原要支持只还原部分')

  // ⑥ 预算硬闸
  assert.match(server, /今日预算已用完/, '超预算要拒绝启动')

  // ⑦ 运行中切工作区拦截
  assert.match(ext, /hasRunningRun/, '切工作区前要检查有没有任务在跑')
  assert.match(ext, /正在跑任务，切工作区会中断它/, '要弹确认')
  assert.match(server, /path === '\\/api\\/runs'/, '要有运行列表接口')

  // ⑧ @文件
  assert.match(server, /extractFileRefs/, '要解析 @文件')
  assert.match(page, /@src\\/utils\\.ts/, '输入框提示里要提到 @文件')
})
`
    writeFileSync(path, code, 'utf8')
    console.log('vscode.test：加了计划模式/记录/回滚/预算/守卫/@文件 结构断言')
  }
}
