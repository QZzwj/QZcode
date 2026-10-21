import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/extension.cjs'
let code = readFileSync(path, 'utf8')

// 1) 变量名撞了模块级的 runtime（那个是扩展自己的状态对象），改名 + 提到使用之前
code = code.replace(
  `    const serverStarted = Date.now()
    output().appendLine(\`[start] \${runtime.command} \${args.join(' ')}\`)
    output().appendLine(\`[runtime] \${runtime.describe}\`)
    setStatus('$(sync~spin) QZcode 启动中')

    // 默认用 VS Code 自带的运行时，只有设置里指定了才用外部 node
    const runtime = lib.resolveNode({ nodePath: config.nodePath })`,
  `    const serverStarted = Date.now()
    // 默认用 VS Code 自带的运行时（不需要装 Node），只有设置里指定了才用外部 node
    const nodeRuntime = lib.resolveNode({ nodePath: config.nodePath })
    output().appendLine(\`[start] \${nodeRuntime.command} \${args.join(' ')}\`)
    output().appendLine(\`[runtime] \${nodeRuntime.describe}\`)
    setStatus('$(sync~spin) QZcode 启动中')
`,
)

// 2) spawn 用 nodeRuntime，env 顺序修正（process.env 先铺底，运行时变量最后覆盖）
code = code.replace(
  `    const child = spawn(runtime.command, args, {
      cwd: root || path.dirname(resolved.path),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...(typeof env === 'object' && env ? env : {}),
        ...runtime.env, ...process.env, QZCODE_VSCODE: '1' },
      windowsHide: true,
    })`,
  `    const child = spawn(nodeRuntime.command, args, {
      cwd: root || path.dirname(resolved.path),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(typeof env === 'object' && env ? env : {}),
        ...nodeRuntime.env,
        QZCODE_VSCODE: '1',
      },
      windowsHide: true,
    })`,
)

writeFileSync(path, code, 'utf8')

// 3) 复查：不该再有裸的 runtime.command
const check = readFileSync(path, 'utf8')
console.log('  nodeRuntime 用了几次:', (check.match(/nodeRuntime/g) ?? []).length)
console.log('  还有裸的 runtime.command 吗:', /[^A-Za-z]runtime\.command/.test(check) ? '✘ 有' : '✔ 没有')
console.log('  模块级 runtime 仍在用:', /runtime\.workspace = root/.test(check) ? '✔' : '✘')
