import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/probe-features.mjs'
let code = readFileSync(path, 'utf8')

// 预算改成"重启后端再验证"：配置是启动时读的，热改没用
code = code.replace(
  `// ⑥ 预算硬闸：把预算设成极小再跑
writeFileSync(configPath, JSON.stringify({ cost: { dailyBudget: 0.0000001 } }, null, 2), 'utf8')
await api('/api/reload-config', {}).catch(() => null)
const budgetRes = await fetch(url + '/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ goal: '预算应该拦住我' }),
})
const budgetBody = await budgetRes.json().catch(() => ({}))
console.log('⑥ 预算硬闸: HTTP', budgetRes.status, '|', (budgetBody.error ?? '').slice(0, 60))`,
  `// ⑥ 预算硬闸：配置在启动时读，所以重启后端再试
child.kill()
await new Promise((r) => setTimeout(r, 400))
writeFileSync(configPath, JSON.stringify({ cost: { dailyBudget: 0.0000001 } }, null, 2), 'utf8')

const out2 = join(dir, 'o2.log')
const of2 = openSync(out2, 'w')
const child2 = spawn(
  process.execPath,
  ['D:/hhd/pi/vscode/backend/dist/cli.js', 'web', '--mock', '--no-open', '--port', '0', '--workspace', dir, '--config', configPath],
  { cwd: dir, stdio: ['ignore', of2, 'ignore'], windowsHide: true, env: { ...process.env, QZCODE_MOCK_DELAY: '0' } },
)
closeSync(of2)
let url2 = null
for (let i = 0; i < 100 && !url2; i++) {
  await new Promise((r) => setTimeout(r, 150))
  const m = readFileSync(out2, 'utf8').match(/qzcode GUI:\\s*(\\S+)/)
  if (m) url2 = m[1].replace(/\\/+$/, '')
}
const budgetRes = await fetch(url2 + '/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ goal: '预算应该拦住我' }),
})
const budgetBody = await budgetRes.json().catch(() => ({}))
console.log('⑥ 预算硬闸: HTTP', budgetRes.status, '|', (budgetBody.error ?? '').slice(0, 70))
child2.kill()`,
)

writeFileSync(path, code, 'utf8')
console.log('probe：预算改成重启验证')
