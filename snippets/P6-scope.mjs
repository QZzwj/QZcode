import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/web/server.ts'
const lines = readFileSync(path, 'utf8').split('\n')

// startRun 接收运行选项（计划模式 / 预设任务书）
const startIndex = lines.findIndex((line) => line.trim().startsWith('const startRun = (goal: string): RunState => {'))
if (startIndex < 0) throw new Error('startRun 定义没找到')

if (line0(lines, startIndex).includes('goal: string)')) {
  lines[startIndex] = lines[startIndex].replace(
    'const startRun = (goal: string): RunState => {',
    'const startRun = (\n    goal: string,\n    options2: { planOnly?: boolean; presetPlan?: unknown } = {},\n  ): RunState => {',
  )
  console.log('startRun：接受运行选项')
}

function line0(all, index) {
  return all[index]
}

// 帮助函数：在 startRun 内部用 options2
const bodyIndex = lines.findIndex((line, index) => index > startIndex && line.includes('const previousContext = planOnly'))
if (bodyIndex < 0) throw new Error('previousContext 那行没找到')
lines[bodyIndex] = '        // 上一轮留下的上下文：让"把它改成深色"这种话不用重新交代背景'
lines.splice(
  bodyIndex + 1,
  0,
  '        const previousContext = options2.planOnly === true ? undefined : lastRunContext(toolRuntime.workspace)',
)
console.log('previousContext 改用 options2')

const callIndex = lines.findIndex((line) => line.includes('          planOnly,'))
if (callIndex < 0) throw new Error('planOnly 传参没找到')
lines[callIndex] = '          planOnly: options2.planOnly === true,'
lines[callIndex + 1] = '          presetPlan: options2.presetPlan as never,'
console.log('runPipeline 传参改用 options2')

// 调用点带上选项
const invokeIndex = lines.findIndex((line) => line.trim() === 'const run = startRun(goal)')
if (invokeIndex >= 0) {
  lines[invokeIndex] = '          const run = startRun(goal, { planOnly, presetPlan })'
  console.log('调用点传入 planOnly / presetPlan')
}

writeFileSync(path, lines.join('\n'), 'utf8')
