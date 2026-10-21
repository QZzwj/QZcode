import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/snapshot.ts'
const lines = readFileSync(path, 'utf8').split('\n')

// 1) 签名加 only 参数
const sigIndex = lines.findIndex((line) => line.trim() === 'export function restoreFromIndex(')
if (sigIndex < 0) throw new Error('restoreFromIndex 没找到')
const paramIndex = lines.findIndex((line, index) => index > sigIndex && line.trim() === 'index: SnapshotIndex,')
if (paramIndex < 0) throw new Error('index 参数行没找到')
if (!lines[paramIndex + 1].includes('only?')) {
  lines.splice(paramIndex + 1, 0, '  /** 只回滚这些路径（相对工作区）；不传 = 全部回滚。 */', '  only?: string[],')
  console.log('snapshot.ts：签名加 only')
}

// 2) 循环里按 only 过滤
const loopIndex = lines.findIndex((line, index) => index > paramIndex && line.includes('for (const entry of index.entries) {'))
if (loopIndex < 0) throw new Error('entries 循环没找到')
if (!lines[loopIndex + 1].includes('wanted')) {
  lines.splice(
    loopIndex + 1,
    0,
    "    if (wanted && !wanted.has(entry.path)) continue",
  )
  // 在循环前定义 wanted
  lines.splice(
    loopIndex,
    0,
    "  const wanted = only && only.length > 0 ? new Set(only.map((item) => item.split('\\\\').join('/'))) : null",
  )
  console.log('snapshot.ts：按 only 过滤')
}

writeFileSync(path, lines.join('\n'), 'utf8')
