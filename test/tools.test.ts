import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Toolbox, createTools, globToRegExp, resolveInside } from '../src/tools.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

test('resolveInside rejects escaping the workspace', () => {
  const root = process.cwd()
  assert.throws(() => resolveInside(root, '../outside.txt'), /路径越界/)
  assert.ok(resolveInside(root, 'nested/ok.txt').endsWith('ok.txt'))
})

test('glob patterns compile as expected', () => {
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'))
  assert.ok(globToRegExp('*.md').test('README.md'))
  assert.ok(!globToRegExp('*.md').test('a/README.md'))
  assert.ok(globToRegExp('**/*.{ts,js}').test('deep/x.js'))
})

test('built-in tools use the pi tool names', () => {
  const names = createTools().map((tool) => tool.name).sort()
  assert.deepEqual(names, ['bash', 'browser', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
})

test('read / write / ls / find / grep work inside the workspace', async () => {
  const dir = tempWorkspace('tools')
  const toolbox = new Toolbox(createTools())
  const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
  try {
    const write = await toolbox.call('write', JSON.stringify({ path: 'src/a.ts', content: 'export const x = 1\n' }), runtime)
    assert.equal(write.ok, true)
    assert.ok(readFileSync(join(dir, 'src', 'a.ts'), 'utf8').includes('const x'))

    const read = await toolbox.call('read', JSON.stringify({ path: 'src/a.ts' }), runtime)
    assert.equal(read.ok, true)
    assert.match(read.output, /1\s+export const x = 1/)

    const offset = await toolbox.call('read', JSON.stringify({ path: 'src/a.ts', offset: 2, limit: 1 }), runtime)
    assert.equal(offset.ok, true)

    const ls = await toolbox.call('ls', JSON.stringify({ path: '.' }), runtime)
    assert.match(ls.output, /src\//)

    const find = await toolbox.call('find', JSON.stringify({ pattern: '**/*.ts' }), runtime)
    assert.match(find.output, /src[\\/]a\.ts/)

    const grep = await toolbox.call('grep', JSON.stringify({ pattern: 'const x' }), runtime)
    assert.match(grep.output, /a\.ts:1/)

    const literal = await toolbox.call('grep', JSON.stringify({ pattern: 'const x', literal: true, glob: '*.ts' }), runtime)
    assert.match(literal.output, /a\.ts:1/)
  } finally {
    removeDir(dir)
  }
})

test('edit replaces a unique snippet and supports batches', async () => {
  const dir = tempWorkspace('edit')
  const toolbox = new Toolbox(createTools())
  const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
  const file = join(dir, 'src', 'a.ts')
  try {
    writeFileSync(join(dir, 'seed'), '', { flag: 'w' })
    await toolbox.call('write', JSON.stringify({ path: 'src/a.ts', content: 'const x = 1\nconst y = 2\n' }), runtime)

    const single = await toolbox.call('edit', JSON.stringify({ path: 'src/a.ts', oldText: 'x = 1', newText: 'x = 10' }), runtime)
    assert.equal(single.ok, true)
    assert.match(readFileSync(file, 'utf8'), /x = 10/)

    const batch = await toolbox.call(
      'edit',
      JSON.stringify({
        path: 'src/a.ts',
        edits: [
          { oldText: 'x = 10', newText: 'x = 100' },
          { oldText: 'y = 2', newText: 'y = 20' },
        ],
      }),
      runtime,
    )
    assert.equal(batch.ok, true, batch.output)
    const text = readFileSync(file, 'utf8')
    assert.match(text, /x = 100/)
    assert.match(text, /y = 20/)

    // oldText must be unique in the ORIGINAL text
    const ambiguous = await toolbox.call('edit', JSON.stringify({ path: 'src/a.ts', oldText: 'const ', newText: 'var ' }), runtime)
    assert.equal(ambiguous.ok, false)
    assert.match(ambiguous.output, /多次/)

    const missing = await toolbox.call('edit', JSON.stringify({ path: 'src/a.ts', oldText: 'nope', newText: 'x' }), runtime)
    assert.equal(missing.ok, false)

    // all-or-nothing: one bad edit must not write a partial result
    const before = readFileSync(file, 'utf8')
    const partial = await toolbox.call(
      'edit',
      JSON.stringify({
        path: 'src/a.ts',
        edits: [
          { oldText: 'x = 100', newText: 'x = 111' },
          { oldText: 'does-not-exist', newText: 'z' },
        ],
      }),
      runtime,
    )
    assert.equal(partial.ok, false)
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    removeDir(dir)
  }
})

test('unknown tools and bad JSON fail softly', async () => {
  const dir = tempWorkspace('tools-bad')
  const toolbox = new Toolbox(createTools())
  const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
  try {
    assert.equal((await toolbox.call('nope', '{}', runtime)).ok, false)
    assert.equal((await toolbox.call('read', '{not json', runtime)).ok, false)
    assert.equal((await toolbox.call('read', JSON.stringify({ path: 'missing.txt' }), runtime)).ok, false)
  } finally {
    removeDir(dir)
  }
})

test('bash respects the exec switch', async () => {
  const dir = tempWorkspace('exec')
  writeFileSync(join(dir, 'file.txt'), 'hi', 'utf8')
  const toolbox = new Toolbox(createTools())
  try {
    const off = await toolbox.call('bash', JSON.stringify({ command: 'echo hi' }), {
      workspace: dir,
      exec: { enabled: false, timeoutMs: 5000 },
    })
    assert.equal(off.ok, false)
    assert.match(off.output, /禁用/)

    const on = await toolbox.call('bash', JSON.stringify({ command: 'echo qzcode-ok', timeout: 20 }), {
      workspace: dir,
      exec: { enabled: true, timeoutMs: 20000 },
    })
    assert.equal(on.ok, true)
    assert.match(on.output, /qzcode-ok/)
  } finally {
    removeDir(dir)
  }
})

test('tool hooks can block a call and rewrite a result', async () => {
  const dir = tempWorkspace('hooks')
  const toolbox = new Toolbox(createTools())
  const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } }
  try {
    toolbox.hooks = {
      before(event) {
        if (event.toolName === 'write' && String(event.input.path ?? '').includes('.env')) {
          return { block: true, reason: '不允许写 .env' }
        }
        return undefined
      },
      after(event) {
        return event.toolName === 'read' ? { output: '[已脱敏]' } : undefined
      },
    }

    const blocked = await toolbox.call('write', JSON.stringify({ path: '.env', content: 'SECRET=1' }), runtime)
    assert.equal(blocked.ok, false)
    assert.match(blocked.output, /被扩展阻止.*\.env/)

    const allowed = await toolbox.call('write', JSON.stringify({ path: 'ok.txt', content: 'hello' }), runtime)
    assert.equal(allowed.ok, true)

    const redacted = await toolbox.call('read', JSON.stringify({ path: 'ok.txt' }), runtime)
    assert.equal(redacted.ok, true)
    assert.equal(redacted.output, '[已脱敏]')
  } finally {
    removeDir(dir)
  }
})

test('the verifier gets read-only tools plus bash', () => {
  const toolbox = new Toolbox(createTools())
  const verifierNames = ['read', 'grep', 'find', 'ls', 'bash', 'browser']
  const defs = toolbox.defs({ names: verifierNames })
  assert.deepEqual(defs.map((d) => d.name).sort(), [...verifierNames].sort())
  assert.ok(defs.every((d) => d.parameters.type === 'object'))
  assert.deepEqual(
    toolbox.list({ readOnly: true }).map((tool) => tool.name).sort(),
    ['browser', 'find', 'grep', 'ls', 'read'],
  )
})
