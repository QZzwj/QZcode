import { readFileSync, writeFileSync } from 'node:fs'

const done = []

// 1) 设置项：默认空 = 用 VS Code 自带运行时
{
  const path = 'vscode/package.json'
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  const prop = pkg.contributes.configuration.properties['qzcode.nodePath']
  prop.default = ''
  prop.description =
    '用哪个 Node 跑本地服务。留空（默认）就用 VS Code 自带的运行时，机器上不需要装 Node；只有想指到别的 node 时才填绝对路径。'
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  done.push('nodePath 默认空 + 说明')
}

// 2) 体检里的 Node 检查：说清它是什么运行时
{
  const path = 'src/doctor.ts'
  let code = readFileSync(path, 'utf8')
  const from = `    id: 'runtime.node',
    name: 'Node 版本',
    level: major >= 18 ? 'ok' : 'error',
    detail: \`\${process.version}（\${process.platform} \${process.arch}）\`,
    fix: major >= 18 ? undefined : '升级到 Node 18+（仓库里直接跑 .ts 需要 22.19+）',`
  const to = `    id: 'runtime.node',
    name: '运行时',
    level: major >= 18 ? 'ok' : 'error',
    detail: \`\${process.version}（\${process.platform} \${process.arch}）\${process.env.ELECTRON_RUN_AS_NODE ? ' · 来自 VS Code 自带运行时' : ''}\`,
    fix: major >= 18 ? undefined : '这个运行时太旧；扩展默认用 VS Code 自带运行时，一般不会走到这里',`
  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    done.push('doctor 运行时检查')
  } else {
    console.log('⚠ doctor 锚点未匹配')
  }
}

// 3) 详情页：前置条件改写
{
  const path = 'vscode/README.md'
  let code = readFileSync(path, 'utf8')
  const pairs = [
    [
      '**前置条件：机器上要有 Node。** 扩展会用它来跑自带的本地服务；`qzcode.nodePath` 可以指定别的 node。',
      '**不需要装 Node。** 扩展直接用 VS Code 自带的运行时跑本地服务，装好就能用；想指到别的 node 时在设置里填 `qzcode.nodePath` 即可。',
    ],
    [
      '- 需要机器上装 Node；装好后不需要任何额外安装或配置就能用。',
      '- 不需要装 Node：本地服务跑在 VS Code 自带的运行时上，装好后不需要任何额外安装或配置。',
    ],
    [
      '| `qzcode.nodePath` | `node` | 跑本地服务的 node |',
      '| `qzcode.nodePath` | 空 | 留空 = 用 VS Code 自带的运行时（不需要装 Node）；想用别的 node 才填 |',
    ],
  ]
  for (const [from, to] of pairs) {
    if (code.includes(from)) {
      code = code.replace(from, to)
      done.push('详情页：' + from.slice(0, 12) + '…')
    } else {
      console.log('⚠ 详情页没匹配:', from.slice(0, 30))
    }
  }
  writeFileSync(path, code, 'utf8')
}

// 4) 仓库 README
{
  const path = 'README.md'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    'src/                 后端（Node 直接跑 .ts，无需编译）',
    'src/                 后端（Node 直接跑 .ts，无需编译；扩展里跑的是打包好的 dist/cli.js）',
  )
  writeFileSync(path, code, 'utf8')
}

console.log(done.join(' / ') || '(无改动)')
