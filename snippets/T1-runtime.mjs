import { readFileSync, writeFileSync } from 'node:fs'

const done = []

// ---------------------------------------------------------------- lib.cjs：运行时解析
{
  const path = 'vscode/lib.cjs'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('function resolveNode')) {
    const anchor = 'function resolveCliPath(options) {'
    if (!code.includes(anchor)) throw new Error('resolveCliPath 锚点没找到')
    code = code.replace(
      anchor,
      `/**
 * 决定用哪个 Node 跑后端。
 *
 * 默认**不需要机器上装 Node**：VS Code 自己是 Electron，把 ELECTRON_RUN_AS_NODE=1
 * 塞进去，同一个可执行文件就变成了 Node（实测 Node 24.20 / Electron 43）。
 * 只有设置了 qzcode.nodePath 才用外部 node。
 */
function resolveNode(options = {}) {
  const setting = String(options.nodePath ?? '').trim()
  const execPath = options.execPath ?? process.execPath
  const isElectron = options.isElectron ?? Boolean(process.versions && process.versions.electron)

  if (setting && setting !== 'node' && setting !== 'auto') {
    return { command: setting, env: {}, source: 'setting', describe: \`外部 node（设置里指定）：\${setting}\` }
  }

  if (isElectron && execPath) {
    return {
      command: execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'electron',
      describe: \`VS Code 自带运行时（不需要装 Node）：\${execPath}\`,
    }
  }

  return { command: 'node', env: {}, source: 'path', describe: 'PATH 里的 node（非 Electron 环境）' }
}

${anchor}`,
    )
    // 导出
    code = code.replace(
      'module.exports = {',
      'module.exports = {\n  resolveNode,',
    )
    writeFileSync(path, code, 'utf8')
    done.push('lib.resolveNode')
  }
}

// ---------------------------------------------------------------- extension.cjs：用它
{
  const path = 'vscode/extension.cjs'
  let code = readFileSync(path, 'utf8')

  // 默认值不再是 'node'
  code = code.replace("nodePath: config.get('nodePath') || 'node',", "nodePath: config.get('nodePath') || '',")

  const from = `    const child = spawn(config.nodePath, args, {`
  if (!code.includes(from)) throw new Error('spawn 锚点没找到')
  code = code.replace(
    from,
    `    // 默认用 VS Code 自带的运行时，只有设置里指定了才用外部 node
    const runtime = lib.resolveNode({ nodePath: config.nodePath })
    const child = spawn(runtime.command, args, {`,
  )

  // env 里带上 ELECTRON_RUN_AS_NODE
  const envAnchor = `      env: {`
  const index = code.indexOf(envAnchor, code.indexOf('const child = spawn(runtime.command'))
  if (index > 0) {
    code = code.slice(0, index) + `      env: {\n        ...(typeof env === 'object' && env ? env : {}),\n        ...runtime.env,` + code.slice(index + envAnchor.length)
    done.push('spawn 注入 ELECTRON_RUN_AS_NODE')
  }

  // 日志里写清用的是哪个运行时
  code = code.replace(
    '    output().appendLine(`[start] ${config.nodePath} ${args.join(\' \')}`)',
    '    output().appendLine(`[start] ${runtime.command} ${args.join(\' \')}`)\n    output().appendLine(`[runtime] ${runtime.describe}`)',
  )

  writeFileSync(path, code, 'utf8')
  done.push('extension.cjs 用 resolveNode')
}

console.log(done.join(' / ') || '(无改动)')
