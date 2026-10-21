import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'qz-boot-'))
const out = join(dir, 'o.log')
const err = join(dir, 'e.log')
const of = openSync(out, 'w')
const ef = openSync(err, 'w')

const t0 = Date.now()
const child = spawn(
  process.execPath,
  ['D:/hhd/pi/vscode/backend/dist/cli.js', 'web', '--mock', '--no-open', '--port', '0', '--workspace', dir, '--config', join(dir, 'qzcode.json')],
  { cwd: dir, stdio: ['ignore', of, ef], windowsHide: true },
)
closeSync(of)
closeSync(ef)

let url = null
let tUrl = 0
for (let i = 0; i < 200 && !url; i++) {
  await new Promise((r) => setTimeout(r, 20))
  const match = readFileSync(out, 'utf8').match(/qzcode GUI:\s*(\S+)/)
  if (match) {
    url = match[1].replace(/\/+$/, '')
    tUrl = Date.now()
  }
}
console.log('打印 URL 用时:', tUrl - t0, 'ms')
if (!url) {
  console.log('没起来:', readFileSync(err, 'utf8').slice(0, 300))
  process.exit(1)
}

const t1 = Date.now()
const health = await fetch(url + '/api/health')
await health.json()
console.log('/api/health 首次响应:', Date.now() - t1, 'ms')

const t2 = Date.now()
await (await fetch(url + '/api/roles')).json()
console.log('/api/roles 首次响应:', Date.now() - t2, 'ms')

child.kill()
await new Promise((r) => setTimeout(r, 200))
rmSync(dir, { recursive: true, force: true })
