import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 验证：不装 Node，用 VS Code 自带的 Electron（ELECTRON_RUN_AS_NODE）能不能跑起后端。 */

const code = 'D:\\Microsoft VS Code\\Code.exe'
if (!existsSync(code)) {
  console.log('找不到 Code.exe')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'qz-electron-'))
const child = spawn(code, ['D:/hhd/pi/vscode/backend/dist/cli.js', 'web', '--mock', '--no-open', '--port', '0', '--workspace', dir], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', QZCODE_MOCK_DELAY: '0' },
})

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  stdout += chunk
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let url = null
for (let i = 0; i < 60 && !url; i++) {
  await sleep(200)
  const match = /qzcode GUI:\s*(\S+)/.exec(stdout)
  if (match) url = match[1].replace(/\/+$/, '')
}

if (!url) {
  console.log('✘ 没起来')
  console.log('stdout:', stdout.slice(0, 300))
  console.log('stderr:', stderr.slice(0, 500))
  child.kill()
  process.exit(1)
}

console.log('✔ 后端起来了:', url)
console.log('  运行它的 node 版本，由后端自己报:')
const health = await fetch(`${url}/api/health`).then((r) => r.json()).catch(() => null)
console.log('  /api/health:', JSON.stringify(health).slice(0, 160))

// 真跑一轮，确认流水线在 Electron 的 node 下也能干活
const started = await fetch(`${url}/api/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ goal: '写一个说明文件' }),
}).then((r) => r.json())
let status = 'running'
for (let i = 0; i < 150 && status === 'running'; i++) {
  await sleep(150)
  status = (await fetch(`${url}/api/run?id=${started.runId}`).then((r) => r.json())).status
}
console.log('✔ 跑完一轮:', status)
console.log('  运行记录:', readFileSync(join(dir, '.qzcode', 'run1.md'), 'utf8').split('\n')[0])

child.kill()
await sleep(400)
rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
