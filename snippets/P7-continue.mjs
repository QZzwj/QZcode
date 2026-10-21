import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/web/server.ts'
let code = readFileSync(path, 'utf8')
const done = []

// 1) 计划模式的运行状态是 planned：不提交 git，但记上下文和运行记录
{
  const from = `        run.status = result.ok ? 'passed' : 'failed'`
  const to = `        run.status = result.planned === true ? 'planned' : result.ok ? 'passed' : 'failed'`
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('状态 planned')
  }

  // 计划模式不改文件，不需要提交
  const gitFrom = `        if (config.git.autoCommit) {`
  if (code.includes(gitFrom) && !code.includes("run.status === 'planned'")) {
    code = code.replace(
      gitFrom,
      `        if (config.git.autoCommit && run.status !== 'planned') {`,
    )
    done.push('计划模式不提交 git')
  }

  // 记住这一轮的上下文，给下一轮用
  const ctxFrom = `        run.steps = meter.snapshot()`
  const ctxTo = `        rememberRunContext(toolRuntime.workspace, run, run.status, result)
        run.steps = meter.snapshot()`
  if (code.includes(ctxFrom) && !code.includes('rememberRunContext(toolRuntime.workspace')) {
    code = code.replace(ctxFrom, ctxTo)
    done.push('记录上一轮上下文')
  }
}

// 2) 计划模式：侧栏给一句明确的话
{
  const from = `          if (logged.ok) {`
  const to = `          if (logged.ok) {`
  void from
  const noteFrom = `            push(run, { t: 'note', level: 'info', message: \`本轮记录已写入 .qzcode/run\${logged.index}.md\` })`
  const noteTo = `            push(run, { t: 'note', level: 'info', message: \`本轮记录已写入 .qzcode/run\${logged.index}.md\` })
            if (run.status === 'planned') {
              push(run, {
                t: 'note',
                level: 'info',
                message: '这是计划模式：任务书已经出来，确认后点「按这个做」我再动手。',
              })
            }`
  if (code.includes(noteFrom) && !code.includes('这是计划模式')) {
    code = code.replace(noteFrom, noteTo)
    done.push('计划模式提示')
  }
}

// 3) POST /api/continue：拿上一轮的任务书，跳过 L/A 直接执行
{
  if (!code.includes("path === '/api/continue'")) {
    const anchor = `        if (request.method === 'POST' && path === '/api/run') {`
    if (!code.includes(anchor)) throw new Error('/api/run 锚点未匹配')
    const block = `        if (request.method === 'POST' && path === '/api/continue') {
          const body = await readBody(request)
          const sourceId = String(body.runId ?? '')
          const planned = runs.get(sourceId)
          if (!planned) {
            sendJson(response, 404, { error: \`没有这个运行: \${sourceId}\` })
            return
          }
          const planEvent = [...planned.events].reverse().find((event) => event.t === 'plan') as
            | { plan?: { acceptance?: string[] } }
            | undefined
          const plan = (planEvent as unknown as { plan?: unknown })?.plan
          if (!plan) {
            sendJson(response, 400, { error: '这个运行没有任务书，不能继续执行' })
            return
          }
          const run = startRun(planned.goal, { presetPlan: plan })
          sendJson(response, 200, { ok: true, runId: run.id, goal: run.goal })
          return
        }

${anchor}`
    code = code.replace(anchor, block)
    done.push('POST /api/continue')
  }
}

writeFileSync(path, code, 'utf8')
console.log('server.ts:', done.join(' / ') || '(无改动)')
