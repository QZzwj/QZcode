import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/pipeline.ts'
let code = readFileSync(path, 'utf8')
const done = []

// 1) 选项：计划模式 / 带进来的任务书
{
  const from = `  /** Kernel event sink: extensions observe the run through these events. */
  emit?: (event: string, payload?: unknown) => void
}`
  const to = `  /** Kernel event sink: extensions observe the run through these events. */
  emit?: (event: string, payload?: unknown) => void
  /**
   * 计划模式：只跑到 A 出任务书就停，把任务书交给用户确认。
   * 用户点头后再用 presetPlan 起一轮真正的执行。
   */
  planOnly?: boolean
  /** 已经确认过的任务书：跳过 L 和 A，直接进 B（顺带省掉这两步的 token）。 */
  presetPlan?: Plan
}`
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('PipelineOptions.planOnly/presetPlan')
  } else {
    console.log('⚠ PipelineOptions 锚点未匹配')
  }
}

// 2) 有 presetPlan 就跳过 A
{
  const from = `    reporter.phase('plan', round)
    const planned = await inRole('planner', round, () =>
      planStep(
        { client: clients.planner, toolbox, toolRuntime, config, signal },
        {
          goal,
          round,
          workspace: toolRuntime.workspace,
          previousIssues: verdict?.issues,
          previousSummary: verdict?.summary,
        },
        hooksFor(reporter, 'planner'),
      ),
    )
    trackUsage('planner', planned.usage)
    plan = planned.plan
    reporter.plan?.(round, plan)
    if (!planned.plan.parsed) {
      reporter.note('A 没有按要求输出 JSON，已降级用全文作为任务书（验收标准可能缺失）。', 'warn')
    }
    if (planned.plan.acceptance.length === 0) {
      reporter.note('A 没给验收标准，C 会把这记为 major。', 'warn')
    }`

  const to = `    let currentPlan: Plan
    if (options.presetPlan && round === 1) {
      // 用户已经确认过任务书：直接用它，不再花 A 的 token
      currentPlan = options.presetPlan
      reporter.phase('plan', round)
      reporter.note('沿用你确认过的任务书，跳过 A。', 'info')
      reporter.plan?.(round, currentPlan)
    } else {
      reporter.phase('plan', round)
      const planned = await inRole('planner', round, () =>
        planStep(
          { client: clients.planner, toolbox, toolRuntime, config, signal },
          {
            goal,
            round,
            workspace: toolRuntime.workspace,
            previousIssues: verdict?.issues,
            previousSummary: verdict?.summary,
            previousContext: options.previousContext,
          },
          hooksFor(reporter, 'planner'),
        ),
      )
      trackUsage('planner', planned.usage)
      currentPlan = planned.plan
      reporter.plan?.(round, currentPlan)
      if (!planned.plan.parsed) {
        reporter.note('A 没有按要求输出 JSON，已降级用全文作为任务书（验收标准可能缺失）。', 'warn')
      }
      if (planned.plan.acceptance.length === 0) {
        reporter.note('A 没给验收标准，C 会把这记为 major。', 'warn')
      }
    }
    plan = currentPlan

    // 计划模式：任务书出来了就停，等用户确认
    if (options.planOnly === true) {
      reporter.phase('done', round)
      return finish({
        cost: runCost(config.cost, usageByRole, modelByRole),
        ok: true,
        planned: true,
        rounds: round,
        plan,
        verdict: null,
        usage,
        elapsedMs: Date.now() - startedAt,
        history: [],
        implementerReport: '',
      })
    }`

  if (code.includes(from)) {
    code = code.replace(from, to)

    // 后面用到 planned.plan 的地方改成 currentPlan
    code = code.replace(
      `        { plan: planned.plan, goal, round, messages: implementerMessages },`,
      `        { plan: currentPlan, goal, round, messages: implementerMessages },`,
    )
    code = code.replace(
      `            { plan: planned.plan, goal, round, messages: implementerMessages },`,
      `            { plan: currentPlan, goal, round, messages: implementerMessages },`,
    )
    done.push('跳过 A / 计划模式提前收尾')
  } else {
    console.log('⚠ plan 阶段锚点未匹配')
  }
}

// 3) 多轮上下文（②）：L 和 A 都能看到上一轮
{
  const from = `  /** 已经确认过的任务书：跳过 L 和 A，直接进 B（顺带省掉这两步的 token）。 */
  presetPlan?: Plan
}`
  const to = `  /** 已经确认过的任务书：跳过 L 和 A，直接进 B（顺带省掉这两步的 token）。 */
  presetPlan?: Plan
  /** 上一轮留下的上下文（目标/结论/改动清单），避免每轮从零开始。 */
  previousContext?: string
}`
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('PipelineOptions.previousContext')
  }

  // L 的输入带上上下文
  const routeAnchor = `      { client: clients.leader, toolbox, toolRuntime, config, signal },`
  void routeAnchor
}

// 4) RunResult 增加 planned 标记
{
  const rp = 'src/pipeline.ts'
  let rc = readFileSync(rp, 'utf8')
  if (!rc.includes('planned?: boolean')) {
    rc = rc.replace(
      `export interface RunResult {`,
      `export interface RunResult {
  /** 计划模式：这一轮只出了任务书，还没动手。 */
  planned?: boolean`,
    )
    writeFileSync(rp, rc, 'utf8')
    done.push('RunResult.planned')
  }
}

writeFileSync(path, code, 'utf8')
console.log('pipeline.ts:', done.join(' / ') || '(无改动)')
