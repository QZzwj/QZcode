import { readFileSync, writeFileSync } from 'node:fs'

// 1) runtime.test.ts：用 createRequire 引 .cjs，避免 TS7016（.cjs 没有类型声明）
{
  const path = 'test/runtime.test.ts'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    "import lib from '../vscode/lib.cjs'",
    `import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)
interface ResolvedNode {
  command: string
  env: Record<string, string>
  source: 'setting' | 'electron' | 'path'
  describe: string
}
const lib = requireCjs('../vscode/lib.cjs') as {
  resolveNode: (options?: { nodePath?: string; execPath?: string; isElectron?: boolean }) => ResolvedNode
}`,
  )
  writeFileSync(path, code, 'utf8')
  console.log('runtime.test.ts 改用 createRequire')
}

// 2) plan-mode 测试补一条：presetPlan 时连 L 都不调（和文档里"跳过 L 和 A"对上）
{
  const path = 'test/plan-mode.test.ts'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('跳过 L')) {
    const anchor = `    assert.equal(ran.planned, undefined, '第二轮不是计划模式')`
    code = code.replace(
      anchor,
      `${anchor}
    assert.ok(
      second.notes.some((note) => note.includes('跳过 L 的分流')),
      '预设任务书时不该再花 L 的 token',
    )`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('plan-mode.test 加"跳过 L"断言')
  }
}
