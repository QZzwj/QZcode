import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createContext } from '../src/kernel.ts'
import { CommandRegistry } from '../src/commands.ts'
import { wireHost } from '../src/host.ts'
import { detectDshAppDir, loadPlugins } from '../src/plugins/loader.ts'
import { Toolbox, createTools } from '../src/tools.ts'
import { mockConfig, removeDir, tempWorkspace } from './helpers.ts'

process.env.QZCODE_MOCK_DELAY = '0'

const examplePlugin = fileURLToPath(new URL('../plugins/example-plugin.ts', import.meta.url))
const piStylePlugin = fileURLToPath(new URL('../plugins/pi-style-extension.ts', import.meta.url))
const dshFixture = fileURLToPath(new URL('./fixtures/dsh-dep-plugin.ts', import.meta.url))

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

test('a project plugin mounts, injects services and registers a tool', async () => {
  const dir = tempWorkspace('plugins')
  const toolbox = new Toolbox(createTools())
  const config = mockConfig(dir, { plugins: [examplePlugin] })
  const ctx = createContext('test')
  const notices: string[] = []
  try {
    const records = await loadPlugins({
      ctx,
      config,
      toolbox,
      logger: silentLogger,
      notify: (message) => notices.push(message),
    })
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'active', records[0].detail)
    assert.equal(records[0].name, 'example-plugin')

    const tool = toolbox.get('word_count')
    assert.ok(tool, 'plugin tool must be registered in the shared toolbox')

    writeFileSync(join(dir, 'sample.txt'), '你好 hello\n世界\n', 'utf8')
    const result = await toolbox.call('word_count', JSON.stringify({ path: 'sample.txt' }), {
      workspace: dir,
      exec: { enabled: false, timeoutMs: 5000 },
    })
    assert.equal(result.ok, true)
    assert.match(result.output, /CJK/)

    // services the host injected are reachable from the plugin's context
    assert.ok(ctx.provides('tools'))
    assert.ok(ctx.provides('config'))
    assert.ok(ctx.provides('llm'))
    assert.ok(ctx.provides('fs'))
    assert.deepEqual(ctx.records, records)
  } finally {
    ctx.dispose()
    removeDir(dir)
  }
})

test('a broken plugin is reported instead of crashing the host', async () => {
  const dir = tempWorkspace('plugins-bad')
  const toolbox = new Toolbox(createTools())
  const config = mockConfig(dir, { plugins: ['./does-not-exist.ts'] })
  const ctx = createContext('test')
  try {
    const records = await loadPlugins({
      ctx,
      config,
      toolbox,
      logger: silentLogger,
      notify() {},
    })
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'failed')
    assert.ok(records[0].detail && records[0].detail.length > 0)
  } finally {
    ctx.dispose()
    removeDir(dir)
  }
})

const dshDir = detectDshAppDir()
test(
  'a plugin importing @deepseek-ai/* resolves against the local DSH install',
  { skip: dshDir ? false : 'no DeepSeek Harness install on this machine' },
  async () => {
    const dir = tempWorkspace('plugins-dsh')
    const toolbox = new Toolbox(createTools())
    const config = mockConfig(dir, { plugins: [dshFixture] })
    const ctx = createContext('test')
    try {
      const records = await loadPlugins({
        ctx,
        config,
        toolbox,
        logger: silentLogger,
        notify() {},
      })
      assert.equal(records[0].status, 'active', records[0].detail)
      const result = await toolbox.call('camel_probe', JSON.stringify({ text: 'hello-world' }), {
        workspace: dir,
        exec: { enabled: false, timeoutMs: 5000 },
      })
      assert.equal(result.ok, true)
      assert.equal(result.output, 'helloWorld')
    } finally {
      ctx.dispose()
      removeDir(dir)
    }
  },
)

test('a pi-style extension registers tools, commands and tool hooks', async () => {
  const dir = tempWorkspace('plugins-pi')
  const toolbox = new Toolbox(createTools())
  const commands = new CommandRegistry()
  const config = mockConfig(dir, { plugins: [piStylePlugin] })
  const ctx = createContext('test')
  ctx.set('commands', commands)
  wireHost(ctx, toolbox)
  const notifications: string[] = []
  const notify = (message: string) => notifications.push(message)
  try {
    const records = await loadPlugins({ ctx, config, toolbox, logger: silentLogger, notify })
    assert.equal(records[0].status, 'active', records[0].detail)
    assert.equal(records[0].name, 'pi-style-extension')

    // 1) pi.registerTool({... execute }) became a normal toolbox entry
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    const counted = await toolbox.call('count_lines', JSON.stringify({ path: 'a.txt' }), {
      workspace: dir,
      exec: { enabled: false, timeoutMs: 5000 },
    })
    assert.equal(counted.ok, true)
    assert.match(counted.output, /4 行/)

    // 2) pi.registerCommand shows up in the registry the TUI reads
    const command = commands.get('trio')
    assert.ok(command, 'command must be registered')
    assert.match(command.description, /分工/)
    await command.handler('', { notify, config })
    assert.match(notifications.join('\n'), /C 只读核验/)

    // 3) pi.on("tool_call") can block a call
    const blocked = await toolbox.call('bash', JSON.stringify({ command: 'rm -rf /tmp/x' }), {
      workspace: dir,
      exec: { enabled: true, timeoutMs: 5000 },
    })
    assert.equal(blocked.ok, false)
    assert.match(blocked.output, /被扩展阻止.*破坏性命令/)

    // 4) pi.on("tool_result") can redact what the model sees
    writeFileSync(join(dir, 'secret.txt'), 'API_KEY=abcdef123456\n', 'utf8')
    const redacted = await toolbox.call('read', JSON.stringify({ path: 'secret.txt' }), {
      workspace: dir,
      exec: { enabled: false, timeoutMs: 5000 },
    })
    assert.equal(redacted.ok, true)
    assert.match(redacted.output, /API_KEY=\*\*\*/)
    assert.ok(!redacted.output.includes('abcdef123456'))
  } finally {
    ctx.dispose()
    removeDir(dir)
  }
})
