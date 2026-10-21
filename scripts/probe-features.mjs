import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 端到端：计划模式 / 继续执行 / 预算硬闸 / @文件 / 记录文件 / 按文件回滚 */

const dir = mkdtempSync(join(tmpdir(), 'qz-feat-'))
const configPath = join(dir, 'qzcode.json')
writeFileSync(configPath, JSON.stringify({ cost: { dailyBudget: 0 } }, null, 2), 'utf8')
writeFileSync(join(dir, 'ref.txt'), '这是参考文件的内容：答案 42\n', 'utf8')

const out = join(dir, 'o.log')
const err = join(dir, 'e.log')
const of = openSync(out, 'w')
const ef = openSync(err, 'w')
const child = spawn(
  process.execPath,
  ['D:/hhd/pi/vscode/backend/dist/cli.js', 'web', '--mock', '--no-open', '--port', '0', '--workspace', dir, '--config', configPath],
  { cwd: dir, stdio: ['ignore', of, ef], windowsHide: true, env: { ...process.env, QZCODE_MOCK_DELAY: '0' } },
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
  console.log('后端没起来:', readFileSync(err, 'utf8').slice(0, 300))
  process.exit(1)
}
const api = async (path, body) =>
  body
    ? (await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
    : (await fetch(url + path)).json()
const waitRun = async (id) => {
  let status = 'running'
  for (let i = 0; i < 200 && status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 120))
    status = (await api(`/api/run?id=${id}`)).status
  }
  return status
}

// ① 计划模式
const planned = await api('/api/run', { goal: '写一个说明文件', planOnly: true })
const plannedStatus = await waitRun(planned.runId)
const plannedDetail = await api(`/api/run?id=${planned.runId}`)
console.log('① 计划模式 → 状态:', plannedStatus, '| 有任务书:', Boolean(plannedDetail.events?.find((e) => e.t === 'plan')))
console.log('   记录文件:', plannedDetail.runLogPath ? plannedDetail.runLogPath.split('qz-feat-')[1] : '(无)')

// ①b 继续执行
const continued = await api('/api/continue', { runId: planned.runId })
const continuedStatus = await waitRun(continued.runId)
const continuedDetail = await api(`/api/run?id=${continued.runId}`)
const skippedA = (continuedDetail.events ?? []).some((e) => e.t === 'note' && /沿用你确认过的任务书/.test(e.message ?? ''))
console.log('①b 继续执行 → 状态:', continuedStatus, '| 跳过 A:', skippedA)

// ② 多轮上下文：第二轮应该带上"上一轮目标"
const second = await api('/api/run', { goal: '再改一下' })
const secondStatus = await waitRun(second.runId)
const secondLog = (await api(`/api/run?id=${second.runId}`)).runLogPath
const logText = secondLog ? readFileSync(secondLog, 'utf8') : ''
console.log('② 第二轮状态:', secondStatus, '| 记录里有 L/A 段:', /## A · 任务书/.test(logText))

// ⑧ @文件：目标里写 @ref.txt
const withRef = await api('/api/run', { goal: '看看 @ref.txt 里写了什么' })
await waitRun(withRef.runId)
const refNotes = ((await api(`/api/run?id=${withRef.runId}`)).events ?? [])
  .filter((e) => e.t === 'note')
  .map((e) => e.message)
console.log('⑧ @文件提示:', refNotes.find((m) => /参考文件/.test(m)) ?? '(无)')

// ③ 记录文件个数
const runFiles = readdirSync(join(dir, '.qzcode')).filter((n) => /^run\d+\.md$/.test(n)).sort()
console.log('③ 记录文件:', runFiles.join(', '))

// ⑤ 按文件回滚
const snap = await api(`/api/snapshot?id=${withRef.runId}`)
const entries = snap.entries ?? []
console.log('⑤ 快照条目:', entries.map((e) => `${e.path}(${e.status})`).join(', ') || '(无)')
if (entries.length > 0) {
  const only = await api('/api/rollback', { runId: withRef.runId, paths: [entries[0].path] })
  console.log('   只回滚第一个 →', JSON.stringify({ restored: only.restored, deleted: only.deleted }))
}

// ⑥ 预算硬闸：配置在启动时读，所以重启后端再试
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
  const m = readFileSync(out2, 'utf8').match(/qzcode GUI:\s*(\S+)/)
  if (m) url2 = m[1].replace(/\/+$/, '')
}
const budgetRes = await fetch(url2 + '/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ goal: '预算应该拦住我' }),
})
const budgetBody = await budgetRes.json().catch(() => ({}))
console.log('⑥ 预算硬闸: HTTP', budgetRes.status, '|', (budgetBody.error ?? '').slice(0, 70))
child2.kill()

child.kill()
await new Promise((r) => setTimeout(r, 300))
rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
