import { readFileSync, writeFileSync } from 'node:fs'

const done = []

// 1) 插件详情页：把"最多 N 轮"写成确定的 3 轮
{
  const path = 'vscode/README.md'
  let code = readFileSync(path, 'utf8')
  const from = '                  └→ 不通过就退回 A 重写任务书，最多 N 轮'
  const to = '                  └→ 不通过就退回 A 重写任务书，最多 3 轮'
  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    done.push('vscode/README 轮次文案')
  } else {
    console.log('⚠ 详情页轮次锚点未匹配')
  }

  // 顺手在设置项表里说清"默认 3 轮、怎么改"
  code = readFileSync(path, 'utf8')
  const roundsRow = '| `qzcode.rounds` | `0` | 最大轮次，0 = 用配置文件里的值 |'
  if (code.includes(roundsRow)) {
    code = code.replace(
      roundsRow,
      '| `qzcode.rounds` | `0` | 最大轮次（默认 3 轮：C 不通过 → A 重写 → 重做，最多来回 3 次）。0 = 用配置文件里的值 |',
    )
    writeFileSync(path, code, 'utf8')
    done.push('设置项说明补上默认 3 轮')
  }
}

// 2) 仓库 README 同步
{
  const path = 'README.md'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    '└→ 不通过就退回 A 重写任务书，最多 N 轮',
    '└→ 不通过就退回 A 重写任务书，最多 3 轮（`qzcode.rounds` 可改）',
  )
  code = code.replace(
    'L 管全程 → A 写任务书 → B 实现 → C 核验 → （不通过退回 A，最多 N 轮）',
    'L 管全程 → A 写任务书 → B 实现 → C 核验 → （不通过退回 A 重写，最多 3 轮）',
  )
  writeFileSync(path, code, 'utf8')
  done.push('仓库 README 轮次文案')
}

// 3) 市场描述里也点明
{
  const path = 'vscode/package.json'
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.description =
    '四角色接力把一句话目标做成改动：L 管全程 → A 写任务书 → B 带工具实现 → C 只读核验，不通过就退回 A 重写任务书，最多 3 轮。自带后端，装好即用。'
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  done.push('description 写清最多 3 轮')
}

console.log(done.join(' / ') || '(无改动)')
