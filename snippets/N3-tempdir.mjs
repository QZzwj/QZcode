import { readFileSync, writeFileSync } from 'node:fs'

// 我在 D:\hhd\pi 建了 git 仓库 → 测试用的 test/.tmp 现在"位于 git 仓库内"，
// 于是"不是 git 仓库"那条用例必然失败。测试临时目录改到系统临时区，和仓库彻底解耦。
{
  const path = 'test/helpers.ts'
  let code = readFileSync(path, 'utf8')
  const from = `export function tempWorkspace(name: string): string {
  const dir = join(
    here,
    '.tmp',
    \`\${name}-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 6)}\`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}`
  const to = `export function tempWorkspace(name: string): string {
  // 放系统临时区：这些目录不能位于任何 git 仓库里，
  // 否则 git / doctor 相关的用例会被外层仓库的存在带偏。
  const dir = join(
    tmpdir(),
    'qzcode-test',
    \`\${name}-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 6)}\`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}`
  if (!code.includes('from \'node:os\'')) {
    code = code.replace(`import { join } from 'node:path'`, `import { join } from 'node:path'\nimport { tmpdir } from 'node:os'`)
  }
  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('helpers.ts：临时目录改到系统临时区')
  } else {
    console.log('⚠ tempWorkspace 锚点未匹配')
  }
}
