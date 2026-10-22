import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/pipeline.ts'
let code = readFileSync(path, 'utf8')

// presetPlan（用户已确认任务书）时不再花 L 的分流 token —— 这样"跳过 L 和 A"才是真的
const from = `  let route: RouteDecision | undefined
  if (config.leader.enabled) {
    reporter.phase('route', 1)`
const to = `  let route: RouteDecision | undefined
  if (config.leader.enabled && options.presetPlan) {
    // 任务书是用户确认过的：怎么走已经定了，不用再问 L（省一次调用）
    reporter.note('沿用你确认过的任务书，跳过 L 的分流。', 'info')
  } else if (config.leader.enabled) {
    reporter.phase('route', 1)`

if (code.includes(from)) {
  code = code.replace(from, to)
  writeFileSync(path, code, 'utf8')
  console.log('pipeline：presetPlan 时跳过 L')
} else {
  console.log('⚠ 锚点没匹配')
}
