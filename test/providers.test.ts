import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { applyProvider, applyRole, copyRole, listProviders, listRoles, persist } from '../src/providers.ts'
import { ROLE_NAMES } from '../src/config.ts'
import { mockConfig, removeDir, tempWorkspace } from './helpers.ts'

function configWithFile(dir: string) {
  const config = mockConfig(dir)
  config.path = join(dir, 'qzcode.json')
  writeFileSync(
    config.path,
    JSON.stringify(
      {
        maxRounds: 2,
        // 故意留一个未知字段，检查写回时不会丢
        custom: { keep: true },
        roles: { planner: { systemAppend: '保持这句话' } },
        plugins: ['./plugins/example-plugin.ts'],
      },
      null,
      2,
    ),
    'utf8',
  )
  return config
}

test('listProviders marks the active one and explains keys', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = mockConfig(dir)
    config.roles.planner.provider = 'deepseek'
    config.roles.planner.apiKey = ''
    const state = listProviders(config)
    const deepseek = state.providers.find((provider) => provider.id === 'deepseek')
    assert.ok(deepseek?.active, 'deepseek 应该是当前供应商')
    assert.equal(state.current.provider, 'deepseek')
    assert.ok(state.providers.length >= 5, '预设供应商都要列出来')
    assert.ok(state.providers.every((provider) => provider.baseUrl.startsWith('http')))
  } finally {
    removeDir(dir)
  }
})

test('applyProvider rewrites all three roles and persists without losing fields', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = configWithFile(dir)
    for (const role of ROLE_NAMES) config.roles[role].mock = true

    const result = applyProvider(config, { provider: 'openrouter', apiKey: 'sk-test-123' })
    assert.deepEqual(result.changed, ['leader', 'planner', 'implementer', 'verifier'])
    for (const role of ROLE_NAMES) {
      assert.equal(config.roles[role].provider, 'openrouter')
      assert.equal(config.roles[role].baseUrl, 'https://openrouter.ai/api/v1')
      assert.equal(config.roles[role].model, 'deepseek/deepseek-chat')
      assert.equal(config.roles[role].apiKey, 'sk-test-123')
      assert.equal(config.roles[role].mock, false, '换到真实供应商要关掉 mock')
    }
    assert.equal(result.persistError, undefined)

    const written = JSON.parse(readFileSync(config.path, 'utf8')) as {
      custom: { keep: boolean }
      plugins: string[]
      roles: Record<string, { systemAppend?: string; provider?: string; apiKey?: string }>
    }
    assert.deepEqual(written.custom, { keep: true }, '未知字段不能被写丢')
    assert.deepEqual(written.plugins, ['./plugins/example-plugin.ts'], '插件列表要保留')
    assert.equal(written.roles.planner.systemAppend, '保持这句话', '角色上的其它字段也要保留')
    assert.equal(written.roles.planner.provider, 'openrouter')
    assert.equal(written.roles.verifier.apiKey, 'sk-test-123')
  } finally {
    removeDir(dir)
  }
})

test('applyProvider keeps existing keys and can override the model', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = mockConfig(dir)
    config.roles.planner.apiKey = 'existing-key'
    const result = applyProvider(config, { provider: 'ollama', model: 'qwen2.5-coder:7b' })
    assert.equal(config.roles.planner.apiKey, 'existing-key', '不传 apiKey 时保留原来的')
    assert.equal(config.roles.planner.baseUrl, 'http://127.0.0.1:11434/v1')
    assert.equal(config.roles.implementer.model, 'qwen2.5-coder:7b')
    assert.equal(result.state.current.model, 'qwen2.5-coder:7b')
  } finally {
    removeDir(dir)
  }
})

test('unknown providers are rejected with the list of known ones', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = mockConfig(dir)
    assert.throws(() => applyProvider(config, { provider: 'nope' }), /未知供应商.*deepseek/s)
  } finally {
    removeDir(dir)
  }
})

test('persist reports a readable error when the file is not JSON', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = mockConfig(dir)
    config.path = join(dir, 'broken.json')
    writeFileSync(config.path, '{ // jsonc 注释\n "maxRounds": 3 }', 'utf8')
    const error = persist(config)
    assert.ok(error && /读不动|失败/.test(error), `应该给出可读原因，实际：${error}`)
  } finally {
    removeDir(dir)
  }
})

test('a config without a path gets one written on switch', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = mockConfig(dir)
    config.path = ''
    applyProvider(config, { provider: 'deepseek', apiKey: 'sk-x' })
    assert.equal(config.path, join(dir, 'qzcode.json'))
    const written = JSON.parse(readFileSync(config.path, 'utf8')) as { roles: Record<string, unknown> }
    assert.ok(written.roles.planner, '应该写出 roles')
  } finally {
    removeDir(dir)
  }
})

test('applyRole 只改一个角色，并可清空 key', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = configWithFile(dir)
    const before = config.roles.verifier.model
    const result = applyRole(config, { role: 'implementer', provider: 'ollama', model: 'qwen2.5-coder:7b' })
    assert.equal(config.roles.implementer.provider, 'ollama')
    assert.equal(config.roles.implementer.model, 'qwen2.5-coder:7b')
    assert.equal(config.roles.implementer.baseUrl, 'http://127.0.0.1:11434/v1')
    assert.equal(config.roles.verifier.model, before, '其它角色不能被动到')
    assert.equal(result.state.roles.find((r) => r.role === 'implementer')?.model, 'qwen2.5-coder:7b')

    config.roles.planner.apiKey = 'sk-abcdefgh1234'
    applyRole(config, { role: 'planner', apiKey: '' })
    assert.equal(config.roles.planner.apiKey, '', '传空字符串要能清掉 key')
  } finally {
    removeDir(dir)
  }
})

test('copyRole 把一套配置复制给其它角色', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = configWithFile(dir)
    config.roles.planner.provider = 'openai'
    config.roles.planner.baseUrl = 'https://api.openai.com/v1'
    config.roles.planner.model = 'gpt-4.1-mini'
    config.roles.planner.apiKey = 'sk-openai'
    const result = copyRole(config, 'planner', ['planner', 'implementer', 'verifier'])
    assert.equal(config.roles.implementer.model, 'gpt-4.1-mini')
    assert.equal(config.roles.verifier.model, 'gpt-4.1-mini')
    assert.equal(config.roles.verifier.apiKey, 'sk-openai')
    assert.equal(result.state.roles.filter((r) => r.model === 'gpt-4.1-mini').length, 3)
  } finally {
    removeDir(dir)
  }
})

test('listRoles 只给打码后的 key', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = mockConfig(dir)
    config.roles.planner.apiKey = 'sk-1234567890abcdef'
    const state = listRoles(config)
    const planner = state.roles.find((role) => role.role === 'planner')
    assert.equal(planner?.hasKey, true)
    assert.match(planner?.keyHint ?? '', /^sk-1…cdef$/)
    assert.ok(!JSON.stringify(state).includes('1234567890abcdef'), '完整 key 不能出现在面板数据里')
  } finally {
    removeDir(dir)
  }
})
test('自定义供应商：全手填，字段都写回配置', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = configWithFile(dir)
    const result = applyRole(config, {
      role: 'planner',
      provider: 'my-gateway',
      baseUrl: 'https://gw.example.com/v1/',
      model: 'custom-model-7b',
      apiKey: 'sk-gw',
      temperature: 0.55,
      maxTokens: 12345,
      headers: { 'X-Gateway-Key': 'abc', 'HTTP-Referer': 'https://example.com' },
      timeoutMs: 120000,
      retries: 4,
    })
    const target = config.roles.planner
    assert.equal(target.provider, 'my-gateway')
    assert.equal(target.baseUrl, 'https://gw.example.com/v1', '末尾斜杠要去掉')
    assert.equal(target.model, 'custom-model-7b')
    assert.deepEqual(target.headers, { 'X-Gateway-Key': 'abc', 'HTTP-Referer': 'https://example.com' })
    assert.equal(target.timeoutMs, 120000)
    assert.equal(target.retries, 4)
    assert.equal(result.state.roles.find((r) => r.role === 'planner')?.custom, true)

    // 面板上改的温度/头/超时要真的落盘（以前漏了）
    const written = JSON.parse(readFileSync(config.path, 'utf8')) as {
      roles: Record<string, { provider: string; temperature: number; headers: Record<string, string>; timeoutMs: number; retries: number }>
    }
    assert.equal(written.roles.planner.provider, 'my-gateway')
    assert.equal(written.roles.planner.temperature, 0.55)
    assert.equal(written.roles.planner.timeoutMs, 120000)
    assert.equal(written.roles.planner.headers['X-Gateway-Key'], 'abc')
  } finally {
    removeDir(dir)
  }
})

test('自定义供应商没给接口地址要报错', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = mockConfig(dir)
    assert.throws(() => applyRole(config, { role: 'planner', provider: 'nowhere' }), /必须填接口地址/)
    assert.throws(() => applyRole(config, { role: 'planner', provider: '  ' }), /provider 不能为空/)
  } finally {
    removeDir(dir)
  }
})
test('接口地址写歪了要直接报错（字段错位的经典事故）', () => {
  const dir = tempWorkspace('providers')
  try {
    const config = mockConfig(dir)
    // 事故现场：baseUrl 里放的是模型名，apiKey 里放的是接口地址
    assert.throws(
      () => applyRole(config, { role: 'planner', provider: 'moonshot', baseUrl: 'kimi-k2-turbo-preview' }),
      /接口地址必须是 http\(s\)/,
    )
    assert.throws(
      () => applyRole(config, { role: 'planner', baseUrl: 'api.moonshot.cn/v1' }),
      /接口地址必须是 http\(s\)/,
    )
    // 只报错、不能把脏数据写进配置
    assert.ok(!config.roles.planner.baseUrl.includes('kimi'))
    // 正常值仍然可以
    applyRole(config, { role: 'planner', provider: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1' })
    assert.equal(config.roles.planner.baseUrl, 'https://api.moonshot.cn/v1')
  } finally {
    removeDir(dir)
  }
})

test('换供应商不会复用上一家的 key，切回来还能取回', () => {
  const dir = tempWorkspace('providers-keys')
  try {
    const config = configWithFile(dir)

    // 先用 gatewaya 这家，存一个 key
    applyRole(config, { role: 'planner', provider: 'gatewaya', baseUrl: 'https://gatewaya.example.com/v1', apiKey: 'sk-demo-1234567890' })
    assert.equal(config.roles.planner.apiKey, 'sk-demo-1234567890')
    assert.equal(config.roles.planner.keyHistory.gatewaya, 'sk-demo-1234567890')

    // 换到 gatewayb（另一个自定义供应商）→ 必须清空，不能把 gatewaya 的 key 拿去用
    const switched = applyRole(config, { role: 'planner', provider: 'gatewayb', baseUrl: 'https://gateway.example.com/v1' })
    assert.equal(config.roles.planner.apiKey, '', '不能复用上一家的 key')
    assert.match(switched.warnings.join(' '), /还没有这家的 key/)
    const detail = switched.state.roles.find((role) => role.role === 'planner')
    assert.equal(detail?.hasKeyForProvider, false)
    assert.deepEqual(detail?.storedKeyProviders, ['gatewaya'], '面板要知道哪家存过 key')

    // 给 gatewayb 填 key
    applyRole(config, { role: 'planner', provider: 'gatewayb', baseUrl: 'https://gateway.example.com/v1', apiKey: 'sk-demo-abcdef' })
    assert.equal(config.roles.planner.keyHistory.gatewayb, 'sk-demo-abcdef')

    // 切回 gatewaya → 自动取回 gatewaya 的 key
    applyRole(config, { role: 'planner', provider: 'gatewaya', baseUrl: 'https://gatewaya.example.com/v1' })
    assert.equal(config.roles.planner.apiKey, 'sk-demo-1234567890', '切回去要能取回原来的 key')

    // key 落盘，重启后仍在
    const written = JSON.parse(readFileSync(config.path, 'utf8')) as {
      roles: Record<string, { keyHistory?: Record<string, string> }>
    }
    assert.equal(written.roles.planner.keyHistory?.gatewayb, 'sk-demo-abcdef')
  } finally {
    removeDir(dir)
  }
})
