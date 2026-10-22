import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 冒烟测试"装到机器上的那份"（不是仓库里的）：
 * 用安装目录里的 lib.resolveNode 决定运行时，跑安装目录里的 backend/dist/cli.js，
 * 完整走一轮。等价于扩展在 VS Code 里做的事。
 */

const home = process.env.USERPROFILE ?? ''
const root = join(home, '.vscode', 'extensions')

// 取磁盘上版本号最大的那个 qzcode 安装目录
const candidates = readdirSync(root)
  .filter((name) => /^qzcode\.qzcode-\d+\.\d+\.\d+$/.test(name))
  .sort((a, b) => {
    const va = a.replace('qzcode.qzcode-', '').split('.').map(Number)
    const vb = b.replace('qzcode.qzcode-', '').split('.').map(Number)
    for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i]
    return 0
  })
const base = join(root, candidates[candidates.length - 1] ?? 'qzcode.qzcode-missing')
if (!existsSync(base)) {
  console.log('✘ 没有安装目录:', base)
  process.exit(1)
}

const lib = (await import('file:///' + join(base, 'lib.cjs').replace(/\\/g, '/'))).default
const cliPath = join(base, 'backend', 'dist', 'cli.js')
const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))

console.log('安装版本:', pkg.version)
console.log('后端入口:', cliPath.replace(home, '%USERPROFILE%'))

const nodeRuntime = lib.resolveNode({ nodePath: '', execPath: process.execPath, isElectron: true })
console.log('运行时:', nodeRuntime.source, '→', nodeRuntime.command.replace(home, '%USERPROFILE%'))
console.log('  说明:', nodeRuntime.describe.replace(home, '%USERPROFILE%'))

const dir = mkdtempSync(join(tmpdir(), 'qz-installed-'))
const child = spawn(nodeRuntime.command, [cliPath, 'web', '--mock', '--no-open', '--port', '0', '--workspace', dir], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, ...nodeRuntime.env, QZCODE_MOCK_DELAY: '0' },
})

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (c) => {
  stdout += c
})
child.stderr.on('data', (c) => {
  stderr += c
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let url = null
for (let i = 0; i < 80 && !url; i++) {
  await sleep(200)
  const m = /qzcode GUI:\s*(\S+)/.exec(stdout)
  if (m) url = m[1].replace(/\/+$/, '')
}
if (!url) {
  console.log('✘ 后端没起来')
  console.log('stdout:', stdout.slice(0, 200))
  console.log('stderr:', stderr.slice(0, 500))
  child.kill()
  process.exit(1)
}

console.log('✔ 服务起来了:', url)
const health = await fetch(`${url}/api/health`).then((r) => r.json())
console.log('✔ /api/health:', JSON.stringify(health))

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

const logFile = join(dir, '.qzcode', 'run1.md')
if (existsSync(logFile)) {
  const text = readFileSync(logFile, 'utf8')
  console.log('✔ 运行记录已写:', text.split('\n')[0])
  console.log('   四段都在:', ['L · 调度', 'A · 任务书', 'B · 实现', 'C · 核验'].every((t) => text.includes(t)))
}

const procs = ['node', 'Code']
void procs
child.kill()
await sleep(400)
rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
