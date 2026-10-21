import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 把 checker 里的 stub() 抠出来跑一遍，看它生成的脚本有没有语法错
const src = readFileSync('scripts/ui-check-reconnect.mjs', 'utf8')
const start = src.indexOf('function stub(')
const end = src.indexOf('const chrome =')
if (start < 0 || end < 0) throw new Error('没找到 stub 定义')
const body = src.slice(start, end)

const factory = new Function('fullEvents', `${body}\nreturn stub({ dropAfter: 4, snapshot: { status: 'passed', events: fullEvents } })`)
const fullEvents = [{ t: 'route', decision: { route: 'pipeline' } }]
const output = factory(fullEvents)
console.log('stub 生成长度:', output.length)
const file = join(tmpdir(), 'qz-stub-out.js')
writeFileSync(file, output, 'utf8')

try {
  new Function(output)
  console.log('stub 脚本语法 OK')
} catch (error) {
  console.log('stub 脚本语法错误:', error.message)
  const lines = output.split('\n')
  const match = /line (\d+)/.exec(error.message)
  if (match) {
    const n = Number(match[1])
    for (let i = Math.max(0, n - 3); i < Math.min(lines.length, n + 2); i++) console.log(`${i + 1}: ${lines[i]}`)
  }
}
