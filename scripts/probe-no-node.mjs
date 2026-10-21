import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import lib from '../vscode/lib.cjs'

/**
 * 极端验证：把 PATH 里的 node 全部剔掉，只用 VS Code 自带运行时跑后端。
 * 这个脚本本身也是用 Code.exe（ELECTRON_RUN_AS_NODE=1）跑的，
 * 所以 process.execPath 就是 Code.exe，和扩展里的实际情形一致。
 */

const dir = mkdtempSync(join(tmpdir(), 'qz-no-node-'))
const workspace = join(dir, 'ws')

// 1) 构造一个"没有 node"的 PATH
const pathParts = (process.env.PATH ?? '').split(';').filter(Boolean)
const cleanPath = pathParts
  .filter((part) => !existsSync(join(part, 'node.exe')) && !existsSync(join(part, 'node.cmd')))
  .join(';')

console.log('原 PATH 段数:', pathParts.length, '| 去掉含 node 的段后:', cleanPath.split(';').filter(Boolean).length)
console.log('这台机器上还能直接找到 node 吗:', cleanPath.split(';').filter(Boolean).some((p) => existsSync(join(p, 'node.exe'))) ? '能' : '不能')

// 2) 用扩展里同一套解析逻辑
const nodeRuntime = lib.resolveNode({ nodePath: '', execPath: process.execPath, isElectron: true })
console.log('解析出来的运行时:', nodeRuntime.source, '→', nodeRuntime.command)

const child = spawn(nodeRuntime.command, ['D:/hhd/pi/vscode/backend/dist/cli.js', 'web', '--mock', '--no-open', '--port', '0', '--workspace', workspace], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...process.env,
    PATH: cleanPath,
    ...nodeRuntime.env,
    QZCODE_MOCK_DELAY: '0',
  },
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
for (let i = 0; i < 80 && !url; i++) {
  await sleep(200)
  const match = /qzcode GUI:\s*(\S+)/.exec(stdout)
  if (match) url = match[1].replace(/\/+$/, '')
}

if (!url) {
  console.log('✘ 起不来')
  console.log('stdout:', stdout.slice(0, 300))
  console.log('stderr:', stderr.slice(0, 600))
  child.kill()
  process.exit(1)
}

console.log('✔ 没有外部 node，后端照样起来了:', url)
console.log('  后端自报版本:', (await fetch(`${url}/api/health`).then((r) => r.json())).ok ? 'health ok' : 'health 异常')

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

const logFile = join(workspace, '.qzcode', 'run1.md')
if (existsSync(logFile)) {
  console.log('✔ 运行记录:', readFileSync(logFile, 'utf8').split('\n')[0])
  writeFileSync(join(dir, 'ok.txt'), 'ok')
}

child.kill()
await sleep(500)
rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
