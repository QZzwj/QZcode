import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import lib from '../vscode/lib.cjs'

const repoRoot = join(import.meta.dirname, '..')

test('运行时：默认用 VS Code 自带的 Electron（机器上不用装 Node）', () => {
  const resolved = lib.resolveNode({ nodePath: '', execPath: 'C:\\VS Code\\Code.exe', isElectron: true })
  assert.equal(resolved.source, 'electron')
  assert.equal(resolved.command, 'C:\\VS Code\\Code.exe')
  assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, '1', '必须带这个环境变量，否则跑的是图形界面')
  assert.match(resolved.describe, /不需要装 Node/)
})

test('运行时：设置里指定了就听设置的（不再加 ELECTRON 变量）', () => {
  const resolved = lib.resolveNode({
    nodePath: 'C:\\nodejs\\node.exe',
    execPath: 'C:\\VS Code\\Code.exe',
    isElectron: true,
  })
  assert.equal(resolved.source, 'setting')
  assert.equal(resolved.command, 'C:\\nodejs\\node.exe')
  assert.deepEqual(resolved.env, {})
})

test('运行时：设置填 "auto" 或 "node" 当成没填', () => {
  for (const value of ['auto', 'node', '  ']) {
    const resolved = lib.resolveNode({ nodePath: value, execPath: '/opt/code', isElectron: true })
    assert.equal(resolved.source, 'electron', `${JSON.stringify(value)} 应该当作未设置`)
  }
})

test('运行时：非 Electron 环境退回 PATH 里的 node', () => {
  const resolved = lib.resolveNode({ nodePath: '', execPath: '/usr/bin/electron', isElectron: false })
  assert.equal(resolved.source, 'path')
  assert.equal(resolved.command, 'node')
})

test('运行时接线：扩展里真的用了 resolveNode，并且把环境变量带进 spawn', () => {
  const ext = readFileSync(join(repoRoot, 'vscode', 'extension.cjs'), 'utf8')
  assert.match(ext, /lib\.resolveNode\(\{ nodePath: config\.nodePath \}\)/, '要调用 resolveNode')
  assert.match(ext, /spawn\(nodeRuntime\.command, args, \{/, 'spawn 要用解析出来的运行时')
  assert.match(ext, /\.\.\.nodeRuntime\.env/, 'env 要合并运行时变量')
  assert.match(ext, /\[runtime\] \$\{nodeRuntime\.describe\}/, '日志要写清用的哪个运行时')

  // 设置项默认必须是空（空 = 用自带运行时）
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'vscode', 'package.json'), 'utf8'))
  assert.equal(pkg.contributes.configuration.properties['qzcode.nodePath'].default, '')
})
