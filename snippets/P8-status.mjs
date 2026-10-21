import { readFileSync, writeFileSync } from 'node:fs'

// RunStatus 加上 planned
{
  const path = 'src/web/server.ts'
  let code = readFileSync(path, 'utf8')
  const match = code.match(/type RunStatus = ([^\n]+)/)
  if (!match) throw new Error('RunStatus 没找到')
  if (!match[1].includes('planned')) {
    const updated = match[1].includes("'")
      ? `${match[1]} | 'planned'`
      : `${match[1]} | 'planned'`
    code = code.replace(match[0], `type RunStatus = ${updated}`)
    writeFileSync(path, code, 'utf8')
    console.log('RunStatus 加上 planned:', updated)
  } else {
    console.log('RunStatus 已经有 planned')
  }
}
