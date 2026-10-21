import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/web/server.ts'
const lines = readFileSync(path, 'utf8').split('\n')

// GET /api/run 的返回体在 783 行附近（含 events），把 runLogPath 加在 status 之后
const index = lines.findIndex(
  (line, i) => line.trim() === 'status: run.status,' && lines[i + 1]?.includes('error: run.error'),
)
if (index < 0) throw new Error('GET /api/run 返回体没找到')
if (!lines[index + 1].includes('runLogPath')) {
  lines.splice(index + 1, 0, '        runLogPath: run.runLogPath ?? null,', '        runLogIndex: run.runLogIndex ?? null,')
  writeFileSync(path, lines.join('\n'), 'utf8')
  console.log('GET /api/run 返回 runLogPath')
}
