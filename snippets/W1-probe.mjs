import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/probe-installed.mjs'
let code = readFileSync(path, 'utf8')

// 版本号别写死：取磁盘上最新的 qzcode 目录
code = code.replace(
  `const home = process.env.USERPROFILE ?? ''
const base = join(home, '.vscode', 'extensions', 'qzcode.qzcode-3.6.0')`,
  `const home = process.env.USERPROFILE ?? ''
const root = join(home, '.vscode', 'extensions')

// 取磁盘上版本号最大的那个 qzcode 安装目录
const candidates = readdirSync(root)
  .filter((name) => /^qzcode\\.qzcode-\\d+\\.\\d+\\.\\d+$/.test(name))
  .sort((a, b) => {
    const va = a.replace('qzcode.qzcode-', '').split('.').map(Number)
    const vb = b.replace('qzcode.qzcode-', '').split('.').map(Number)
    for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i]
    return 0
  })
const base = join(root, candidates[candidates.length - 1] ?? 'qzcode.qzcode-missing')`,
)

code = code.replace(
  "import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'",
  "import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'",
)

writeFileSync(path, code, 'utf8')
console.log('probe-installed 改成取最新版本目录')
