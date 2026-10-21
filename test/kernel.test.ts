import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext } from '../src/kernel.ts'
import type { Context } from '../src/kernel.ts'

test('plugins mount in child scopes and dispose their effects', () => {
  const root = createContext('root')
  const order: string[] = []
  root.plugin((ctx) => {
    ctx.effect(() => order.push('effect'))
    order.push('applied')
  })
  assert.deepEqual(order, ['applied'])
  assert.equal(root.children.length, 1)
  root.dispose()
  assert.deepEqual(order, ['applied', 'effect'])
})

test('services are visible to children but not to parents', () => {
  const root = createContext('root')
  root.set('config', { workspace: '/tmp' })
  let seen = ''
  root.plugin((ctx) => {
    seen = (ctx.get('config') as { workspace: string }).workspace
    assert.equal(ctx.provides('missing'), false)
  })
  assert.equal(seen, '/tmp')
  const child = root.children[0]
  child.set('local', 1)
  assert.equal(root.tryGet('local'), undefined)
  root.dispose()
})

test('property syntax reaches services', () => {
  const root = createContext('root') as Context & { tools?: { list(): string[] } }
  root.set('tools', { list: () => ['a'] })
  assert.deepEqual(root.tools?.list(), ['a'])
  root.dispose()
})

test('inject waits for the service to appear', () => {
  const root = createContext('root')
  let ran = false
  root.plugin({ name: 'late', inject: ['later'], apply: () => { ran = true } })
  assert.equal(ran, false)
  root.set('later', 42)
  assert.equal(ran, true)
  root.dispose()
})

test('events bubble up and unsubscribe on dispose', () => {
  const root = createContext('root')
  const seen: string[] = []
  root.on('tick', (value) => seen.push(`root:${value}`))
  root.plugin((ctx) => {
    ctx.on('tick', (value) => seen.push(`child:${value}`))
  })
  root.emit('tick', 1)
  assert.deepEqual(seen.sort(), ['child:1', 'root:1'])
  root.dispose()
  root.emit('tick', 2)
  assert.equal(seen.length, 2, 'disposed listeners must not fire')
})

test('plugin records are collected for `plugins list`', () => {
  const root = createContext('root')
  root.records.push({ name: 'p', source: './p.ts', status: 'active' })
  assert.equal(root.records[0].name, 'p')
  root.dispose()
})

test('registerTool accepts pi execute() shape and normalizes readOnly', async () => {
  const root = createContext('root')
  const registered: { name: string; readOnly: boolean; run: Function }[] = []
  root.set('tools', {
    register(tool: { name: string; readOnly: boolean; run: Function }) {
      registered.push(tool)
    },
  })
  const ctx = root as Context
  ctx.registerTool({
    name: 'hello',
    description: 'says hi',
    parameters: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => ({ content: 'hi from pi' }),
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].readOnly, true)
  const outcome = await registered[0].run({}, { workspace: '/tmp' })
  assert.deepEqual(outcome, { ok: true, output: 'hi from pi' })

  // isError becomes ok:false
  registered.length = 0
  ctx.registerTool({ name: 'boom', execute: () => ({ content: 'nope', isError: true }) })
  const failed = await registered[0].run({}, {})
  assert.deepEqual(failed, { ok: false, output: 'nope' })
  root.dispose()
})

test('registerTool rejects incomplete definitions', () => {
  const root = createContext('root')
  root.set('tools', { register() {} })
  assert.throws(() => (root as Context).registerTool({ name: 'x' }), /execute\(\) 或 run\(\)/)
  assert.throws(() => (root as Context).registerTool({ name: '' }), /需要 name/)
  root.dispose()
})

test('registerCommand feeds the command registry and ui.notify routes to notify', async () => {
  const root = createContext('root')
  const registered: { name: string; description: string; handler: Function }[] = []
  root.set('commands', {
    register(def: { name: string; description: string; handler: Function }) {
      registered.push(def)
    },
  })
  const notes: string[] = []
  root.set('notify', (message: string, level?: string) => notes.push(`${level}:${message}`))

  ;(root as Context).registerCommand('greet', {
    description: 'say hello',
    handler: (args: string, ctx: { ui: { notify(m: string, l?: string): void } }) => {
      ctx.ui.notify(`hello ${args || 'world'}`)
    },
  })
  assert.equal(registered[0].name, 'greet')
  await registered[0].handler('pi')
  assert.deepEqual(notes, ['info:hello pi'])
  ;(root as Context).ui.notify('standalone')
  assert.deepEqual(notes[1], 'info:standalone')
  root.dispose()
})

test('hooks run in order, chain object patches, and stop after dispose', async () => {
  const root = createContext('root') as Context
  const off = root.hook<{ value: number }>('sample', (value) => ({ value: value.value + 1 }))
  root.hook<{ value: number }>('sample', (value) => ({ value: value.value * 10 }))
  assert.equal(root.hasHooks, true)
  assert.deepEqual(await root.runHook('sample', { value: 1 }), { value: 20 })

  off()
  assert.deepEqual(await root.runHook('sample', { value: 1 }), { value: 10 })
  root.dispose()
  assert.deepEqual(await root.runHook('sample', { value: 1 }), { value: 1 })
})
