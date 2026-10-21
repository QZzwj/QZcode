import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/web/server.ts'
let code = readFileSync(path, 'utf8')
const done = []

// 1) /api/run 支持 planOnly / presetPlan / files，并加预算硬闸
{
  const from = `    const body = await readBody(request)
    const goal = String(body.goal ?? '').trim()`
  const to = `    const body = await readBody(request)
    const goal = String(body.goal ?? '').trim()
    const planOnly = body.planOnly === true
    const presetPlan = body.presetPlan && typeof body.presetPlan === 'object' ? (body.presetPlan as Plan) : undefined
    const extraFiles = Array.isArray(body.files) ? body.files.filter((item: unknown) => typeof item === 'string') : []`
  if (code.includes(from) && !code.includes('const planOnly =')) {
    code = code.replace(from, to)
    done.push('读取 planOnly/presetPlan/files')
  }

  const budgetAnchor = `    if (!goal) {`
  if (code.includes(budgetAnchor) && !code.includes('今日预算')) {
    code = code.replace(
      budgetAnchor,
      `    // 预算硬闸：今天已经花超了就别再开新一轮
    {
      const spent = costLedger.summary(config.cost, config.cost.dailyBudget)
      const budget = Number(config.cost.dailyBudget ?? 0)
      if (budget > 0 && spent.today >= budget) {
        sendJson(response, 402, {
          error: \`今日预算已用完（\${formatMoney(spent.today)} / \${formatMoney(budget)}）。可以在设置 → 成本里调高预算，或明天再跑。\`,
          code: 'budget',
          today: spent.today,
          budget,
        })
        return
      }
    }

${budgetAnchor}`,
    )
    done.push('预算硬闸')
  }
}

// 2) 传给流水线
{
  const from = `        const result = await runPipeline({
          config,
          goal,
          toolbox,
          toolRuntime: runToolRuntime,
          reporter: makeReporter(run),
          signal: run.abort?.signal,
          emit: options.emit,
          clients,
        })`
  const to = `        // 上一轮留下的上下文：让"把它改成深色"这种话不用重新交代背景
        const previousContext = planOnly ? undefined : lastRunContext(toolRuntime.workspace)
        const result = await runPipeline({
          config,
          goal,
          toolbox,
          toolRuntime: runToolRuntime,
          reporter: makeReporter(run),
          signal: run.abort?.signal,
          emit: options.emit,
          clients,
          planOnly,
          presetPlan,
          previousContext,
        })`
  if (code.includes(from) && !code.includes('previousContext,')) {
    code = code.replace(from, to)
    done.push('传 planOnly/presetPlan/previousContext')
  } else if (!code.includes(from)) {
    console.log('⚠ runPipeline 调用锚点未匹配')
  }
}

writeFileSync(path, code, 'utf8')
console.log('server.ts:', done.join(' / ') || '(无改动)')
