import { spawn } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 用你真实的配置起一次后端，把 /api/cost 的真实载荷打出来看有没有坏字段。 */

const dir = mkdtempSync(join(tmpdir(), 'qz-cost-probe-'))
const userConfig = join(process.env.APPDATA ?? '', 'Code', 'User', 'globalStorage', 'qzcode.qzcode', 'qzcode.json')
const configCopy = join(dir, 'qzcode.json')
if (existsSync(userConfig)) copyFileSync(userConfig, configCopy)

const out = join(dir, 'o.log')
const err = join(dir, 'e.log')
const of = openSync(out, 'w')
const ef = openSync(err, 'w')
const child = spawn(
  process.execPath,
  ['D:/hhd/pi/vscode/backend/dist/cli.js', 'web', '--no-open', '--port', '0', '--workspace', dir, '--config', configCopy],
  { cwd: dir, stdio: ['ignore', of, ef], windowsHide: true },
)
closeSync(of)
closeSync(ef)

let url = null
for (let i = 0; i < 100 && !url; i++) {
  await new Promise((r) => setTimeout(r, 150))
  const m = readFileSync(out, 'utf8').match(/qzcode GUI:\s*(\S+)/)
  if (m) url = m[1].replace(/\/+$/, '')
}
if (!url) {
  console.log('后端没起来：', readFileSync(err, 'utf8').slice(0, 400))
  process.exit(1)
}

const response = await fetch(url + '/api/cost')
console.log('/api/cost 状态:', response.status)
const payload = await response.json()
console.log('顶层字段:', Object.keys(payload).join(', '))
console.log('runs:', payload.runs, '| today:', payload.today, '| budget:', payload.budget, '| remaining:', payload.remaining)
console.log('steps 条数:', (payload.steps ?? []).length)
for (const step of (payload.steps ?? []).slice(0, 4)) console.log('  ', JSON.stringify(step))
console.log('recent 条数:', (payload.recent ?? []).length)
if (payload.recent?.[0]) {
  const first = payload.recent[0]
  console.log('recent[0] keys:', Object.keys(first).join(','))
  console.log('recent[0].steps:', JSON.stringify(first.steps)?.slice(0, 120))
}
// 有没有 NaN / undefined 混进 JSON
const text = JSON.stringify(payload)
console.log('含 NaN/Infinity 字样:', /NaN|Infinity/.test(text))

child.kill()
await new Promise((r) => setTimeout(r, 300))
rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
