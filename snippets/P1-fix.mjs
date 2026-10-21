import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/probe-settings-real.mjs'
let code = readFileSync(path, 'utf8')

code = code.replace(
  "import { existsSync } from 'node:fs'",
  "import { existsSync, mkdirSync } from 'node:fs'",
)
code = code.replace(
  "const dir = join(tmpdir(), 'qz-state-real-' + Date.now())",
  "const dir = join(tmpdir(), 'qz-state-real-' + Date.now())\nmkdirSync(dir, { recursive: true })",
)

writeFileSync(path, code, 'utf8')
console.log('补上 mkdirSync')
