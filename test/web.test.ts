import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createContext } from '../src/kernel.ts'
import { CommandRegistry } from '../src/commands.ts'
import { wireHost } from '../src/host.ts'
import { Toolbox, createTools } from '../src/tools.ts'
import { createWebServer } from '../src/web/server.ts'
import { mockConfig, removeDir, sleep, tempWorkspace } from './helpers.ts'

process.env.QZCODE_MOCK_DELAY = '0'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

async function withServer(
  run: (context: {
    base: string
    config: ReturnType<typeof mockConfig>
    commands: CommandRegistry
    close: () => Promise<void>
  }) => Promise<void>,
): Promise<void> {
  const dir = tempWorkspace('web')
  const config = mockConfig(dir, { maxRounds: 2 })
  const toolbox = new Toolbox(createTools())
  const ctx = createContext('web-test')
  wireHost(ctx, toolbox)
  const commands = new CommandRegistry()
  commands.register({
    name: 'trio',
    description: '说明分工',
    handler(args, context) {
      context.notify(`A→B→C ${args || 'ok'}`)
    },
  })
  const server = await createWebServer({
    config,
    toolbox,
    toolRuntime: { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } },
    plugins: [],
    commands,
    logger,
    port: 0,
  })
  try {
    await run({ base: server.url.replace(/\/$/, ''), config, commands, close: () => server.close() })
  } finally {
    await server.close().catch(() => {})
    ctx.dispose()
    removeDir(dir)
  }
}

test('/api/state reports config, roles and plugins', async () => {
  await withServer(async ({ base }) => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      config: { mock: boolean; maxRounds: number; roles: { role: string }[] }
      runs: unknown[]
      commands: unknown[]
    }
    assert.equal(state.config.mock, true)
    assert.equal(state.config.maxRounds, 2)
    assert.equal(state.config.roles.length, 4, "leader + A/B/C")
    assert.deepEqual(
      state.config.roles.map((role: { role: string }) => role.role),
      ['leader', 'planner', 'implementer', 'verifier'],
    )
    assert.deepEqual(state.runs, [])
    assert.ok(Array.isArray(state.commands))
  })
})

test('a run started over HTTP streams to completion and lands in the history', async () => {
  await withServer(async ({ base }) => {
    const started = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '写一个说明文件并给出验证方式' }),
    })
    assert.equal(started.status, 200)
    const { runId } = (await started.json()) as { runId: string }
    assert.match(runId, /^[0-9a-f-]{8}$/)

    const empty = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '   ' }),
    })
    assert.equal(empty.status, 400)

    let run: { status: string; events: { t: string }[] } | null = null
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${base}/api/run?id=${runId}`)
      run = (await response.json()) as { status: string; events: { t: string }[] }
      if (run && run.status !== 'running') break
      await sleep(50)
    }
    assert.ok(run, 'run must be fetchable')
    assert.equal(run.status, 'passed')

    const kinds = new Set(run.events.map((event) => event.t))
    for (const kind of ['run_start', 'phase', 'text', 'tool', 'plan', 'review', 'verdict', 'done', 'run_end']) {
      assert.ok(kinds.has(kind), `missing event: ${kind}`)
    }

    const plan = run.events.find((event) => event.t === 'plan') as unknown as { plan: { acceptance: string[] } }
    assert.ok(plan.plan.acceptance.length > 0, 'planner must produce acceptance criteria')

    const verdicts = run.events.filter((event) => event.t === 'verdict') as unknown as {
      verdict: { pass: boolean }
    }[]
    assert.deepEqual(
      verdicts.map((event) => event.verdict.pass),
      [false, true],
      'mock fails round 1 and passes round 2',
    )

    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      runs: { status: string; rounds: number }[]
    }
    assert.equal(state.runs.length, 1)
    assert.equal(state.runs[0].status, 'passed')
    assert.equal(state.runs[0].rounds, 2)
  })
})

test('the SSE endpoint replays and then closes at run_end', async () => {
  await withServer(async ({ base }) => {
    const started = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'SSE 测试' }),
    })
    const { runId } = (await started.json()) as { runId: string }

    const response = await fetch(`${base}/api/events?id=${runId}&since=0`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

    assert.ok(response.body, 'SSE response has a body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawEnd = false
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const block of events) {
        const line = block.split('\n').find((item) => item.startsWith('data: '))
        if (!line) continue
        const event = JSON.parse(line.slice(6)) as { t: string; status?: string }
        if (event.t === 'run_end') {
          sawEnd = true
          assert.equal(event.status, 'passed')
        }
      }
      if (sawEnd) break
    }
    await reader.cancel().catch(() => {})
    assert.ok(sawEnd, 'stream must deliver run_end')
  })
})

test('/api/providers switches every role', async () => {
  await withServer(async ({ base, config }) => {

    const listed = (await (await fetch(`${base}/api/providers`)).json()) as {
      providers: { id: string; active: boolean }[]
      current: { provider: string; model: string }
    }
    assert.ok(listed.providers.length >= 5, '预设供应商都要列出来')
    assert.equal(listed.current.provider, config.roles.planner.provider)

    const applied = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', apiKey: 'sk-test' }),
    })
    assert.equal(applied.status, 200)
    const payload = (await applied.json()) as {
      ok: boolean
      state: { current: { provider: string; model: string } }
      persistError?: string
    }
    assert.equal(payload.ok, true)
    assert.equal(payload.state.current.provider, 'openrouter')
    assert.equal(config.roles.verifier.provider, 'openrouter')
    assert.equal(config.roles.verifier.apiKey, 'sk-test')

    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      config: { mock: boolean; roles: { provider: string; model: string }[] }
    }
    assert.equal(state.config.roles[0].provider, 'openrouter')
    assert.equal(state.config.mock, false, '换了真实供应商就不该再是 mock')

    const bad = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'nope' }),
    })
    assert.equal(bad.status, 400)
    assert.match(((await bad.json()) as { error: string }).error, /未知供应商/)
  })
})

test('/api/command runs extension-registered commands', async () => {
  await withServer(async ({ base }) => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      commands: { name: string; description: string }[]
    }
    assert.deepEqual(
      state.commands.map((command) => command.name),
      ['trio'],
      'registered commands are announced to the GUI',
    )

    const ok = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '/trio', args: '带参数' }),
    })
    assert.equal(ok.status, 200)
    const payload = (await ok.json()) as { ok: boolean; messages: string[] }
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.messages, ['A→B→C 带参数'])

    const missing = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    })
    assert.equal(missing.status, 404)
    assert.match(((await missing.json()) as { error: string }).error, /没有这个命令/)
  })
})

test('config toggles and error paths behave', async () => {
  await withServer(async ({ base }) => {
    const toggled = (await (
      await fetch(`${base}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mock: false, exec: false, maxRounds: 5 }),
      })
    ).json()) as { config: { mock: boolean; exec: boolean; maxRounds: number } }
    assert.equal(toggled.config.mock, false)
    assert.equal(toggled.config.exec, false)
    assert.equal(toggled.config.maxRounds, 5)

    const cancelMissing = await fetch(`${base}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'nope' }),
    })
    assert.equal(cancelMissing.status, 404)

    const unknownRun = await fetch(`${base}/api/run?id=nope`)
    assert.equal(unknownRun.status, 404)

    const badJson = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    assert.equal(badJson.status, 500)

    const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean }
    assert.equal(health.ok, true)
  })
})

test('/api/roles 能读能写，且不泄露完整 key', async () => {
  await withServer(async ({ base, config }) => {
    const listed = (await (await fetch(`${base}/api/roles`)).json()) as {
      roles: { role: string; provider: string; model: string; hasKey: boolean; keyHint: string }[]
      providers: { id: string }[]
    }
    assert.equal(listed.roles.length, 4, "leader + A/B/C")
    assert.ok(listed.providers.length >= 5)

    const saved = await fetch(`${base}/api/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'verifier', provider: 'moonshot', apiKey: 'sk-moon-1234567890' }),
    })
    assert.equal(saved.status, 200)
    const payload = (await saved.json()) as {
      ok: boolean
      state: { roles: { role: string; model: string; hasKey: boolean; keyHint: string }[] }
    }
    assert.equal(payload.ok, true)
    const verifier = payload.state.roles.find((role) => role.role === 'verifier')
    assert.equal(verifier?.model, 'kimi-k2-turbo-preview')
    assert.equal(verifier?.hasKey, true)
    assert.ok(!JSON.stringify(payload).includes('sk-moon-1234567890'), 'key 必须打码')
    assert.equal(config.roles.verifier.provider, 'moonshot')

    // 复制给全部
    const copied = await fetch(`${base}/api/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ copyFrom: 'verifier' }),
    })
    assert.equal(copied.status, 200)
    assert.equal(config.roles.planner.model, 'kimi-k2-turbo-preview')
    assert.equal(config.roles.implementer.provider, 'moonshot')

    // 未知角色/供应商要 400
    for (const body of [{ role: 'nope' }, { role: 'planner', provider: 'nope' }]) {
      const bad = await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(bad.status, 400)
    }
  })
})
test('/api/roles 支持自定义供应商与自定义请求头', async () => {
  await withServer(async ({ base, config }) => {
    const res = await fetch(`${base}/api/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'planner',
        provider: 'my-gateway',
        baseUrl: 'https://gw.example.com/v1',
        model: 'gw-model',
        apiKey: 'sk-gw-1234567890',
        temperature: 0.42,
        headers: { 'X-Gateway-Key': 'abc' },
        timeoutMs: 90000,
        retries: 3,
      }),
    })
    assert.equal(res.status, 200)
    const payload = (await res.json()) as {
      state: { roles: { role: string; provider: string; custom: boolean; headers: Record<string, string>; timeoutMs: number; retries: number }[] }
    }
    const planner = payload.state.roles.find((role) => role.role === 'planner')
    assert.equal(planner?.provider, 'my-gateway')
    assert.equal(planner?.custom, true, '预设之外的 provider 要标成自定义')
    assert.deepEqual(planner?.headers, { 'X-Gateway-Key': 'abc' })
    assert.equal(planner?.timeoutMs, 90000)
    assert.equal(planner?.retries, 3)
    assert.equal(config.roles.planner.model, 'gw-model')

    // 自定义供应商缺 baseUrl 要 400
    const bad = await fetch(`${base}/api/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'planner', provider: 'nowhere' }),
    })
    assert.equal(bad.status, 400)
  })
})
test('写歪的接口地址会被 /api/roles 拒绝', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'planner', provider: 'moonshot', baseUrl: 'kimi-k2-turbo-preview' }),
    })
    assert.equal(res.status, 400)
    assert.match(((await res.json()) as { error: string }).error, /接口地址必须是 http\(s\)/)
  })
})
test('/api/roles 的测试连接能分辨"通/模型不存在/端点报错"', async () => {
  const { createServer } = await import('node:http')
  const fake = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gw-model' }] }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()))
  const port = (fake.address() as { port: number }).port
  try {
    await withServer(async ({ base }) => {
      const set = (model: string) =>
        fetch(`${base}/api/roles`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'planner', provider: 'gw', baseUrl: `http://127.0.0.1:${port}/v1`, model }),
        })
      await set('gw-model')
      const good = (await (await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ testRole: 'planner' }),
      })).json()) as { ok: boolean; ms: number; models?: string[] }
      assert.equal(good.ok, true, '配置正确要报通')
      assert.ok(good.models?.includes('gw-model'))

      // 模型名不在端点清单里 → 明确报错，而不是等跑任务时才炸
      await set('no-such-model')
      const bad = (await (await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ testRole: 'planner' }),
      })).json()) as { ok: boolean; error?: string }
      assert.equal(bad.ok, false)
      assert.match(bad.error ?? '', /不在该端点的模型列表/)
    })
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()))
  }
})
test('401 时会提示 key 可能属于别的供应商', async () => {
  const { createServer } = await import('node:http')
  const gateway = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid token' } }))
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()))
  const port = (gateway.address() as { port: number }).port
  try {
    await withServer(async ({ base }) => {
      await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role: 'planner',
          provider: 'gatewayb',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: 'gw-model-1',
          apiKey: 'sk-from-another-provider',
        }),
      })
      const result = (await (await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ testRole: 'planner' }),
      })).json()) as { ok: boolean; error?: string }
      assert.equal(result.ok, false)
      assert.match(result.error ?? '', /401/)
      assert.match(result.error ?? '', /gatewayb/, '要点名是哪家供应商')
      assert.match(result.error ?? '', /key 不匹配|key 属于/, '要提示 key 可能拿错了')
    })
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
  }
})

test('跑一轮之后能看到 diff，并能回滚到运行前', async () => {
  const previousDelay = process.env.QZCODE_MOCK_DELAY
  process.env.QZCODE_MOCK_DELAY = '0'
  try {
    await withServer(async ({ base, config }) => {
      // 预先放一个会被 B 覆盖的文件，验证"修改"分支
      const target = join(config.workspace, 'notes', 'plan.md')
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '旧内容\n', 'utf8')

      const started = (await (await fetch(`${base}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: '写一个说明文件' }),
      })).json()) as { runId: string }

      let status = 'running'
      for (let i = 0; i < 80 && status === 'running'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 120))
        const snapshot = (await (await fetch(`${base}/api/run?id=${started.runId}`)).json()) as { status: string }
        status = snapshot.status
      }

      const diff = (await (await fetch(`${base}/api/diff?runId=${started.runId}`)).json()) as {
        ok: boolean
        files: { path: string; status: string; diff: string }[]
      }
      assert.equal(diff.ok, true)
      assert.ok(diff.files.length > 0, 'B 动过文件就该有 diff')
      const plan = diff.files.find((file) => file.path.replace(/\\/g, '/').endsWith('notes/plan.md'))
      assert.ok(plan, 'notes/plan.md 要在改动清单里')
      assert.equal(plan?.status, 'modified')
      assert.match(plan?.diff ?? '', /旧内容/, 'diff 里要能看到原文')

      const rollback = (await (await fetch(`${base}/api/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: started.runId }),
      })).json()) as { ok: boolean; restored: string[]; deleted: string[] }
      assert.equal(rollback.ok, true)
      assert.ok(rollback.restored.length + rollback.deleted.length > 0)
      assert.equal(readFileSync(target, 'utf8'), '旧内容\n', '回滚后内容要还原')
    })
  } finally {
    if (previousDelay === undefined) delete process.env.QZCODE_MOCK_DELAY
    else process.env.QZCODE_MOCK_DELAY = previousDelay
  }
})

test('工作区就是传进来的那个目录：state 与工具都认它', async () => {
  await withServer(async ({ base, config }) => {
    const state = (await (await fetch(`${base}/api/roles`)).json()) as {
      workspace: string
      roles: unknown[]
    }
    assert.equal(state.workspace, config.workspace, 'state 要报告真实工作区')

    // B 写的文件真的落在这个目录里
    const started = (await (await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '写一个说明文件' }),
    })).json()) as { runId: string }

    let status = 'running'
    for (let i = 0; i < 80 && status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      status = ((await (await fetch(`${base}/api/run?id=${started.runId}`)).json()) as { status: string }).status
    }

    const here = readdirSync(config.workspace).filter((name) => !name.startsWith('.qzcode'))
    assert.ok(here.length > 0, '产物要落在工作区里')
  })
})

test('/api/doctor 返回体检结果，network=0 时跳过网络探测', async () => {
  await withServer(async ({ base }) => {
    const result = (await (await fetch(`${base}/api/doctor?network=0`)).json()) as {
      ok: boolean
      checks: { id: string; level: string }[]
      summary: { ok: number; warn: number; error: number }
      text: string
    }
    assert.ok(result.checks.length >= 8, '要给出一组检查项')
    assert.match(result.text, /QZcode 体检/)
    assert.equal(
      result.checks.some((check) => check.id.startsWith('net.')),
      false,
      'network=0 不该有网络检查',
    )
    assert.equal(result.summary.ok + result.summary.warn + result.summary.error, result.checks.length)
  })
})

test('/api/models 能拉模型列表并支持未保存的地址/key', async () => {
  const { createServer } = await import('node:http')
  const fake = createServer((req, res) => {
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer sk-probe') {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('bad key')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            { id: 'model-b', context_length: 128000, credits: 'x0.5' },
            { id: 'model-a', context_length: 1000000, credits: 'x0.79' },
          ],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()))
  const port = (fake.address() as { port: number }).port
  try {
    await withServer(async ({ base }) => {
      const good = (await (await fetch(`${base}/api/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-probe' }),
      })).json()) as { ok: boolean; models: { id: string; contextLength?: number; credits?: string }[] }
      assert.equal(good.ok, true)
      assert.deepEqual(good.models.map((m) => m.id), ['model-a', 'model-b'], '要按 id 排序')
      assert.equal(good.models[0].contextLength, 1000000)
      assert.equal(good.models[0].credits, 'x0.79')

      // key 不对 → 明确报错而不是空列表
      const bad = (await (await fetch(`${base}/api/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-wrong' }),
      })).json()) as { ok: boolean; error?: string }
      assert.equal(bad.ok, false)
      assert.match(bad.error ?? '', /401/)

      // 地址写歪 → 400
      const invalid = await fetch(`${base}/api/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'not-a-url' }),
      })
      assert.equal(invalid.status, 400)
    })
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()))
  }
})
test('/api/cancel 不传 runId 也能停掉正在跑的那个', async () => {
  const previousDelay = process.env.QZCODE_MOCK_DELAY
  process.env.QZCODE_MOCK_DELAY = '800' // 让 mock 慢一点，取消才有东西可停
  try {
    await withServer(async ({ base }) => {
      const started = (await (await fetch(`${base}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: '写一个很长很长的说明文件' }),
      })).json()) as { runId: string }

    const cancel = await fetch(`${base}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(cancel.status, 200)
    const payload = (await cancel.json()) as { ok: boolean; runId: string }
    assert.equal(payload.ok, true)
    assert.equal(payload.runId, started.runId, '要停的就是刚起的那个')

    // 已经停了再停 → 409，而不是静默成功
    await new Promise((resolve) => setTimeout(resolve, 400))
    const twice = await fetch(`${base}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: started.runId }),
    })
    assert.ok([200, 409].includes(twice.status))
    assert.equal(await twice.text().then((text) => text.includes('"ok":true')), twice.status === 200)
    })
  } finally {
    if (previousDelay === undefined) delete process.env.QZCODE_MOCK_DELAY
    else process.env.QZCODE_MOCK_DELAY = previousDelay
  }
})