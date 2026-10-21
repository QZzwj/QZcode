import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/web/server.ts'
const lines = readFileSync(path, 'utf8').split('\n')

// 1) 在 `const goal = ...` 后面插入 planOnly / presetPlan / files
const goalIndex = lines.findIndex(
  (line, index) => index > 790 && line.includes("const goal = String(body.goal ?? '').trim()"),
)
if (goalIndex < 0) throw new Error('找不到 goal 那行')
if (!lines.some((line) => line.includes('const planOnly ='))) {
  lines.splice(
    goalIndex + 1,
    0,
    '    const planOnly = body.planOnly === true',
    '    const presetPlan =',
    "      body.presetPlan && typeof body.presetPlan === 'object' ? (body.presetPlan as Plan) : undefined",
    '    const extraFiles = Array.isArray(body.files)',
    '      ? (body.files as unknown[]).filter((item): item is string => typeof item === \'string\')',
    '      : []',
  )
  console.log('插入 planOnly / presetPlan / files')
}

// 2) costLedger 是函数，要调用；formatMoney 需要币种
for (let i = 0; i < lines.length; i++) {
  lines[i] = lines[i].replace('costLedger.summary(config.cost, config.cost.dailyBudget)', 'costLedger().summary(config.cost, config.cost.dailyBudget)')
  lines[i] = lines[i].replace('formatMoney(spent.today)', 'formatMoney(spent.today, config.cost.currency)')
  lines[i] = lines[i].replace('formatMoney(budget)', 'formatMoney(budget, config.cost.currency)')
}

writeFileSync(path, lines.join('\n'), 'utf8')
console.log('server.ts：修好 costLedger()/formatMoney 参数')
