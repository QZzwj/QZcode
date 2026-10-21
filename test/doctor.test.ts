import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { EXAMPLE_CONFIG, normalizeConfig } from '../src/config.ts'
import { formatDoctor, runDoctor, sortChecks } from '../src/doctor.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

function configFor(workspace: string, roles: Record<string, unknown>) {
  return normalizeConfig(
    { ...EXAMPLE_CONFIG, roles: { ...EXAMPLE_CONFIG.roles, ...roles } },
    { mock: false, workspace },
  )
}

test('体检：mock 配置下没有错误项', async () => {
  const dir = tempWorkspace('doctor-ok')
  try {
    const config = normalizeConfig({ ...EXAMPLE_CONFIG }, { mock: true, workspace: dir })
    const result = await runDoctor({ config, network: false })
    assert.equal(result.ok, true)
    assert.equal(result.summary.error, 0)
    // 关键项都在
    const ids = result.checks.map((check) => check.id)
    for (const id of ['runtime.node', 'config.file', 'workspace.write', 'shell', 'skills', 'guards']) {
      assert.ok(ids.includes(id), `缺少体检项 ${id}`)
    }
    for (const role of ['leader', 'planner', 'implementer', 'verifier']) {
      assert.ok(ids.includes(`role.${role}`), `缺少角色检查 ${role}`)
    }
    assert.match(formatDoctor(result), /QZcode 体检/)
  } finally {
    removeDir(dir)
  }
})

test('体检：没有 key 的真实角色要报错并给出修法', async () => {
  const dir = tempWorkspace('doctor-nokey')
  try {
    const config = configFor(dir, {
      planner: { provider: 'ruoli', baseUrl: 'https://ruoli.dev/v1', model: 'gpt-6.1-sol', apiKey: '' },
    })
    const result = await runDoctor({ config, network: false })
    assert.equal(result.ok, false)
    const check = result.checks.find((item) => item.id === 'role.planner')
    assert.equal(check?.level, 'error')
    assert.match(check?.detail ?? '', /还没有 key/)
    assert.ok(check?.fix && check.fix.length > 0, '要给出下一步')
  } finally {
    removeDir(dir)
  }
})

test('体检：模型名不在端点清单里要点名', async () => {
  const dir = tempWorkspace('doctor-model')
  const gateway = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'real-model' }] }))
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()))
  const port = (gateway.address() as { port: number }).port
  try {
    const config = configFor(dir, {
      planner: { provider: 'fake', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'typo-model', apiKey: 'sk-x' },
    })
    const result = await runDoctor({ config })
    const check = result.checks.find((item) => item.id === 'net.planner')
    assert.equal(check?.level, 'error')
    assert.match(check?.detail ?? '', /不在端点清单里/)
    assert.match(check?.fix ?? '', /获取模型/)
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    removeDir(dir)
  }
})

test('体检：401 要说清是 key 拿错了', async () => {
  const dir = tempWorkspace('doctor-401')
  const gateway = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid token' } }))
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()))
  const port = (gateway.address() as { port: number }).port
  try {
    const config = configFor(dir, {
      verifier: { provider: 'ruoli', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'sk-wrong' },
    })
    const result = await runDoctor({ config })
    const check = result.checks.find((item) => item.id === 'net.verifier')
    assert.equal(check?.level, 'error')
    assert.match(check?.detail ?? '', /401/)
    assert.match(check?.fix ?? '', /属于 "ruoli"/)
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    removeDir(dir)
  }
})

test('体检：排序把错误排在最前', () => {
  const sorted = sortChecks([
    { id: 'a', name: 'a', level: 'ok', detail: '' },
    { id: 'b', name: 'b', level: 'error', detail: '' },
    { id: 'c', name: 'c', level: 'warn', detail: '' },
  ])
  assert.deepEqual(
    sorted.map((check) => check.level),
    ['error', 'warn', 'ok'],
  )
})
