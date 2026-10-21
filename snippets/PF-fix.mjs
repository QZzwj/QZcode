import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/web/server.ts'
const lines = readFileSync(path, 'utf8').split('\n')

// 1) 把误插到 writeRunLog 入参里的两行删掉
const badIndex = lines.findIndex(
  (line, index) => index > 440 && line.trim().startsWith('runLogPath: run.runLogPath ?? null,'),
)
if (badIndex > 0) {
  lines.splice(badIndex, 2)
  console.log('删掉误插的两行')
}

// 2) 在 GET /api/run 的返回体里加（找 id/goal/status 三连）
const getIndex = lines.findIndex(
  (line, index) =>
    line.trim() === 'status: run.status,' &&
    lines[index - 2]?.trim().startsWith('goal: run.goal,'),
)
if (getIndex > 0 && !lines[getIndex + 1].includes('runLogPath')) {
  lines.splice(getIndex + 1, 0, '        runLogPath: run.runLogPath ?? null,', '        runLogIndex: run.runLogIndex ?? null,')
  console.log('GET /api/run 返回体加上 runLogPath')
} else if (getIndex < 0) {
  console.log('⚠ 没找到 GET /api/run 的返回体')
}

writeFileSync(path, lines.join('\n'), 'utf8')
