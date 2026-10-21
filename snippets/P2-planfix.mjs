import { readFileSync, writeFileSync } from 'node:fs'

// 1) 把残留的 planned.plan 全部换成 currentPlan
{
  const path = 'src/pipeline.ts'
  let code = readFileSync(path, 'utf8')
  const before = code
  code = code.replaceAll('plan: planned.plan,', 'plan: currentPlan,')
  code = code.replaceAll('correctionBrief(reviewed.review, planned.plan, round, attempt)', 'correctionBrief(reviewed.review, currentPlan, round, attempt)')
  code = code.replaceAll('{ plan: planned.plan, goal', '{ plan: currentPlan, goal')
  if (code !== before) {
    writeFileSync(path, code, 'utf8')
    console.log('pipeline.ts：残留的 planned.plan → currentPlan')
  } else {
    console.log('⚠ 没找到残留（可能已替换）')
  }
}

// 2) RunResult 加 planned 字段（确认插到对的位置）
{
  const path = 'src/pipeline.ts'
  let code = readFileSync(path, 'utf8')
  const start = code.indexOf('export interface RunResult {')
  const segment = code.slice(start, start + 260)
  if (!segment.includes('planned?: boolean')) {
    code = code.replace(
      'export interface RunResult {',
      'export interface RunResult {\n  /** 计划模式：只出了任务书，还没动手。 */\n  planned?: boolean',
    )
    writeFileSync(path, code, 'utf8')
    console.log('pipeline.ts：RunResult 补上 planned')
  } else {
    console.log('RunResult 已经有 planned 了')
  }
}

// 3) PlanStepInput 支持上一轮上下文
{
  const path = 'src/roles.ts'
  let code = readFileSync(path, 'utf8')
  const anchor = 'export interface PlanStepInput'
  const index = code.indexOf(anchor)
  if (index < 0) throw new Error('PlanStepInput 没找到')
  const end = code.indexOf('}', index)
  const segment = code.slice(index, end)
  if (!segment.includes('previousContext')) {
    code = code.slice(0, end) + `  /** 上一轮留下的上下文：目标、结论、改动清单（跟着 goal 一起给 A）。 */\n  previousContext?: string\n` + code.slice(end)
    writeFileSync(path, code, 'utf8')
    console.log('roles.ts：PlanStepInput 加 previousContext')
  }
}
