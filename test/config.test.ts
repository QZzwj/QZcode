import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandEnv, loadConfig, normalizeConfig, validateConfig } from '../src/config.ts'
import { mockConfig, removeDir, tempWorkspace } from './helpers.ts'

test('expandEnv supports defaults and fallbacks', () => {
  const env = { PRESENT: 'yes', EMPTY: '' } as NodeJS.ProcessEnv
  assert.equal(expandEnv('${PRESENT}', env), 'yes')
  assert.equal(expandEnv('${MISSING:-fallback}', env), 'fallback')
  assert.equal(expandEnv('x-${EMPTY:-d}', env), 'x-d')
  assert.equal(expandEnv('${MISSING}', env), '')
  assert.equal(expandEnv('plain', env), 'plain')
})

test('provider preset fills baseUrl and model', () => {
  const config = normalizeConfig(
    {
      roles: {
        planner: { provider: 'openai' },
        implementer: { provider: 'ollama' },
        verifier: { provider: 'deepseek', model: 'deepseek-reasoner' },
      },
    },
    { mock: true },
  )
  assert.equal(config.roles.planner.baseUrl, 'https://api.openai.com/v1')
  assert.equal(config.roles.planner.model, 'gpt-4.1-mini')
  assert.equal(config.roles.implementer.apiKey, 'local', 'localhost endpoints get a placeholder key')
  assert.equal(config.roles.verifier.model, 'deepseek-reasoner')
})

test('missing roles produce an actionable error', () => {
  assert.throws(() => normalizeConfig({}, {}), /没有任何 roles/)
  assert.throws(
    () => normalizeConfig({ roles: { planner: { apiKey: 'x' } } }, {}),
    /roles\.implementer, roles\.verifier/,
  )
})

test('workspace resolves relative to the config file', () => {
  const config = normalizeConfig(
    { workspace: './sub', roles: { planner: {}, implementer: {}, verifier: {} } },
    { configPath: 'C:\\work\\qzcode.json', mock: true },
  )
  assert.equal(config.workspace.toLowerCase(), 'c:\\work\\sub')
})

test('validateConfig flags missing keys but skips mock roles', () => {
  const config = mockConfig('C:\\work')
  assert.deepEqual(validateConfig(config), [])
  const real = normalizeConfig(
    {
      roles: {
        leader: { apiKey: 'k' },
        planner: { apiKey: '' },
        implementer: { apiKey: 'k' },
        verifier: { apiKey: 'k' },
      },
    },
    { cwd: 'C:\\work' },
  )
  const problems = validateConfig(real)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /roles\.planner\.apiKey/)
})

test('--no-exec and --rounds override the file', () => {
  const config = normalizeConfig(
    { roles: { planner: {}, implementer: {}, verifier: {} }, exec: { enabled: true } },
    { mock: true, exec: false, maxRounds: 7 },
  )
  assert.equal(config.exec.enabled, false)
  assert.equal(config.maxRounds, 7)
})

test('a UTF-8 BOM in the config file does not break parsing', () => {
  const dir = tempWorkspace('config-bom')
  try {
    const file = join(dir, 'qzcode.json')
    const body = JSON.stringify({ roles: { planner: {}, implementer: {}, verifier: {} } }, null, 2)
    writeFileSync(file, '\uFEFF' + body, 'utf8')
    const config = loadConfig({ configPath: file, mock: true })
    assert.equal(config.roles.planner.role, 'planner')
    assert.ok(config.path.endsWith('qzcode.json'))
  } finally {
    removeDir(dir)
  }
})
test('mock 模式下没有 roles 也能跑（零配置）', () => {
  const config = normalizeConfig({}, { mock: true })
  assert.equal(config.roles.planner.mock, true)
  assert.equal(config.roles.verifier.mock, true)
  assert.ok(config.roles.planner.model.length > 0)
  // 非 mock 时必须给出可操作的错误
  assert.throws(() => normalizeConfig({}, {}), /没有任何 roles/)
})
test('默认开着 A 复核，且可以配次数', () => {
  const config = normalizeConfig({ roles: { planner: {}, implementer: {}, verifier: {} } }, { mock: true })
  assert.equal(config.review.enabled, true)
  assert.equal(config.review.maxCorrections, 2)
  const custom = normalizeConfig({ roles: { planner: {}, implementer: {}, verifier: {} }, review: { enabled: false, maxCorrections: 9 } }, { mock: true })
  assert.equal(custom.review.enabled, false)
  assert.equal(custom.review.maxCorrections, 5, '次数要夹在 0..5')
})
test('leader 默认开启且只给很少的输出预算', () => {
  const config = normalizeConfig({ roles: { planner: {}, implementer: {}, verifier: {} } }, { mock: true })
  assert.equal(config.leader.enabled, true)
  assert.ok(config.leader.directMaxTokens <= 1200, '直接回答的预算要小，才能省钱')
  assert.ok(config.leader.workKeywords.length > 10, '预筛关键词要够用')

  const off = normalizeConfig({ roles: { planner: {}, implementer: {}, verifier: {} }, leader: { enabled: false } }, { mock: true })
  assert.equal(off.leader.enabled, false)

  // 坏值要收敛，不能让用户填个 99999 把 token 烧光
  const crazy = normalizeConfig(
    { roles: { planner: {}, implementer: {}, verifier: {} }, leader: { directMaxTokens: 999999 } },
    { mock: true },
  )
  assert.ok(crazy.leader.directMaxTokens <= 4000)
})

test('老配置里没有 leader 也能加载，并继承 planner 的连接', () => {
  const legacy = {
    roles: {
      planner: { provider: 'hhd', baseUrl: 'https://gw.example.com/v1', model: 'gw-model', apiKey: 'sk-hhd' },
      implementer: { provider: 'hhd', baseUrl: 'https://gw.example.com/v1', model: 'gw-model', apiKey: 'sk-hhd' },
      verifier: { provider: 'hhd', baseUrl: 'https://gw.example.com/v1', model: 'gw-model', apiKey: 'sk-hhd' },
    },
  }
  const config = normalizeConfig(legacy, { cwd: 'C:\\work' })
  const leader = config.roles.leader
  assert.equal(leader.provider, 'hhd', '要跟 planner 用同一家，而不是退回 deepseek 预设')
  assert.equal(leader.baseUrl, 'https://gw.example.com/v1')
  assert.equal(leader.apiKey, 'sk-hhd', '没有 key 的话第一步就会 401')
  assert.equal(leader.model, 'gw-model', '模型也要跟上，否则端点不认')
  assert.equal(config.leader.enabled, true)
})

test('缺 planner 才报错（拼错角色名仍然会被抓住）', () => {
  assert.throws(
    () =>
      normalizeConfig(
        { roles: { plannr: { apiKey: 'k' }, implementer: { apiKey: 'k' }, verifier: { apiKey: 'k' } } },
        { cwd: 'C:\\work' },
      ),
    /配置缺少角色/,
  )
})
