import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/* 把后端编译成纯 JS 并塞进扩展包，让扩展真正独立：
 *   vscode/backend/dist/**       ← tsc 输出（.ts 导入已被改写成 .js）
 *   vscode/backend/dist/prompts  ← 三个角色提示词
 *   vscode/backend/package.json  ← {"type":"module"}
 * 好处：运行时不再需要 Node 的 TS 类型剥离（Node ≥ 18 就能跑），也不依赖仓库。
 */

const repo = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const target = join(repo, 'vscode', 'backend')
const dist = join(target, 'dist')

rmSync(target, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  console.error('缺少 typescript，先跑 npm install')
  process.exit(1)
}

console.log('· 编译 src/ → vscode/backend/dist（tsc 会把 ./x.ts 改写成 ./x.js）')
const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: repo, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('编译失败')
  process.exit(build.status ?? 1)
}

// tsc 只搬 .ts 的结果，非代码资源要手动复制到对应位置
cpSync(join(repo, 'src', 'prompts'), join(dist, 'prompts'), { recursive: true })
cpSync(join(repo, 'src', 'skills'), join(dist, 'skills'), { recursive: true })

writeFileSync(
  join(target, 'package.json'),
  `${JSON.stringify({ name: 'qzcode-backend', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
  'utf8',
)
if (existsSync(join(repo, 'qzcode.example.json'))) {
  cpSync(join(repo, 'qzcode.example.json'), join(target, 'qzcode.example.json'))
}
cpSync(join(repo, 'README.md'), join(target, 'README.md'))
// 只记仓库名，不写本机绝对路径：这个文件会进 vsix，路径会跟着公布出去
writeFileSync(join(target, 'VERSION'), `${new Date().toISOString()}\n构建自: ${basename(repo)}\n`, 'utf8')

function size(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    total += entry.isDirectory() ? size(full) : statSync(full).size
  }
  return total
}

const entry = join(dist, 'cli.js')
if (!existsSync(entry)) {
  console.error('没生成 cli.js，编译结果不对')
  process.exit(1)
}

// 抽查：编译后的相对导入必须已经是 .js（否则运行时会找不到模块）
const sample = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry2) => entry2.isFile() && entry2.name.endsWith('.js'))
  .slice(0, 40)
console.log(`· dist: ${sample.length} 个 js，共 ${(size(dist) / 1024).toFixed(1)} KB`)
console.log(`· 入口: ${entry}`)
