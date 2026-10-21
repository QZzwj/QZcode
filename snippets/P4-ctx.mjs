import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/web/server.ts'
let code = readFileSync(path, 'utf8')
const done = []

// 1) POST /api/run：补上 planOnly / presetPlan / files（之前的锚点在预算块插入后不匹配了）
{
  const from = `    const body = await readBody(request)
    const goal = String(body.goal ?? '').trim()
    // 预算硬闸：今天已经花超了就别再开新一轮
    {
      const spent = costLedger.summary(config.cost, config.cost.dailyBudget)`
  const to = `    const body = await readBody(request)
    const goal = String(body.goal ?? '').trim()
    const planOnly = body.planOnly === true
    const presetPlan =
      body.presetPlan && typeof body.presetPlan === 'object' ? (body.presetPlan as Plan) : undefined
    const extraFiles = Array.isArray(body.files)
      ? (body.files as unknown[]).filter((item): item is string => typeof item === 'string')
      : []

    // 预算硬闸：今天已经花超了就别再开新一轮
    {
      const spent = costLedger().summary(config.cost, config.cost.dailyBudget)`
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('planOnly/presetPlan/files + costLedger()')
  } else {
    console.log('⚠ POST /api/run 头锚点未匹配')
  }
}

// 2) lastRunContext：上一轮留下的上下文（每工作区一份，进程内）
{
  if (!code.includes('function lastRunContext')) {
    const anchor = 'function sendJson(response: ServerResponse, status: number, payload: unknown): void {'
    if (!code.includes(anchor)) throw new Error('sendJson 锚点未匹配')
    const helper = `/**
 * 每个工作区记住"上一轮干了什么"：目标、结论、改动过的文件、核验意见。
 * 下一轮开始时把这段塞给 A（不塞给 B/C，省 token），
 * 这样"把它改成深色"这种话不需要重新交代背景。
 */
const lastContextByWorkspace = new Map<string, string>()

function lastRunContext(workspace: string): string | undefined {
  const text = lastContextByWorkspace.get(workspace)
  return text && text.trim() ? text : undefined
}

function rememberRunContext(workspace: string, run: RunState, status: string, result: unknown): void {
  try {
    const events = run.events as Array<Record<string, unknown>>
    const patches = events.filter((event) => event.t === 'patch')
    const files = [...new Set(patches.map((event) => String(event.path ?? '')).filter(Boolean))].slice(0, 12)
    const verdict = events.filter((event) => event.t === 'verdict').pop() as
      | { verdict?: { pass?: boolean; notes?: string } }
      | undefined
    const plan = events.filter((event) => event.t === 'plan').pop() as
      | { plan?: { acceptance?: string[] } }
      | undefined
    const usage = (result as { usage?: { total?: number } } | null)?.usage

    const lines: string[] = []
    lines.push(\`上一轮目标：\${run.goal.slice(0, 120)}\`)
    lines.push(\`上一轮结果：\${status === 'passed' ? '通过' : status === 'planned' ? '只出了任务书' : '未通过'}\`)
    if (files.length > 0) lines.push(\`改过的文件：\${files.join('、')}\`)
    const note = verdict?.verdict?.notes
    if (note) lines.push(\`核验意见：\${String(note).replace(/\\s+/g, ' ').slice(0, 240)}\`)
    const acceptance = plan?.plan?.acceptance ?? []
    if (acceptance.length > 0) lines.push(\`当时的验收标准：\${acceptance.slice(0, 5).join('；')}\`)
    if (usage?.total) lines.push(\`上一轮用量：\${usage.total} tok\`)

    lastContextByWorkspace.set(workspace, lines.join('\\n'))
  } catch {
    // 记不下来不影响下一轮
  }
}

${anchor}`
    code = code.replace(anchor, helper)
    done.push('lastRunContext / rememberRunContext')
  }
}

writeFileSync(path, code, 'utf8')
console.log('server.ts:', done.join(' / ') || '(无改动)')
