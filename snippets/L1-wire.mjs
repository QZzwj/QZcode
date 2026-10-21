import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/web/server.ts'
let code = readFileSync(path, 'utf8')
const done = []

// 引入
if (!code.includes("from '../runlog.ts'")) {
  code = code.replace(
    `import { describeImage } from '../vision.ts'`,
    `import { describeImage } from '../vision.ts'\nimport { writeRunLog } from '../runlog.ts'`,
  )
  done.push('引入 writeRunLog')
}

// 跑完写 runN.md（放在记账之后、git 提交之前）
{
  const anchor = `        run.status = result.ok ? 'passed' : 'failed'`
  const to = `        run.status = result.ok ? 'passed' : 'failed'
        // 每轮留一份记录：<工作区>/.qzcode/runN.md（L/A/B/C 各自干了什么）
        {
          const logged = writeRunLog(toolRuntime.workspace, {
            runId: run.id,
            goal,
            startedAt: run.createdAt,
            status: run.status,
            events: run.events,
            steps: run.steps,
            touched: result.touched ?? run.snapshot?.entries.length,
          })
          if (logged.ok) {
            push(run, { t: 'note', level: 'info', message: \`本轮记录已写入 .qzcode/run\${logged.index}.md\` })
            logger.info(\`[runlog] \${logged.path}\`)
          } else {
            push(run, { t: 'note', level: 'warn', message: \`记录文件没写成：\${logged.error}\` })
          }
        }`
  if (code.includes(anchor) && !code.includes('writeRunLog(toolRuntime.workspace')) {
    code = code.replace(anchor, to)
    done.push('跑完写记录')
  } else if (code.includes('writeRunLog(toolRuntime.workspace')) {
    // 已经有了
  } else {
    console.log('⚠ run.status 锚点未匹配')
  }
}

writeFileSync(path, code, 'utf8')
console.log('server.ts:', done.join(' / ') || '(无改动)')
