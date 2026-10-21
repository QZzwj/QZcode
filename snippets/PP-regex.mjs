import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/reference.ts'
let code = readFileSync(path, 'utf8')

const from = `  const pattern = /@([^\\s@，。；、"'（）()]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(goal)) !== null) {
    const raw = match[1].replace(/[.,;:]+$/, '')`
const to = `  // @ 前面必须有空白或标点（开头也算），否则 me@example.com 这种会被误判
  const pattern = /(^|[\\s（(、，,：:])@([^\\s@，。；、"'（）()]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(goal)) !== null) {
    const raw = match[2].replace(/[.,;:]+$/, '')`

if (code.includes(from)) {
  code = code.replace(from, to)
  writeFileSync(path, code, 'utf8')
  console.log('reference.ts：@ 前必须有空白或标点')
} else {
  console.log('⚠ 正则锚点未匹配')
}
