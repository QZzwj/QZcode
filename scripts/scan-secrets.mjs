import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 快速查密钥：工作区 + 全历史（一条 git grep 扫所有版本），不打印明文。 */

const PATTERN =
  'sk-[A-Za-z0-9_-]{16,}|apiKey"[[:space:]]*:[[:space:]]*"[^"]{8,}"|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}'

const mask = (line) =>
  line
    .replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/("apiKey"[[:space:]]*:[[:space:]]*")([^"]{4})[^"]*(")/g, '$1$2***$3')
    .replace(/(Bearer[[:space:]]+)([A-Za-z0-9._-]{4})[A-Za-z0-9._-]+/g, '$1$2***')

function grep(args) {
  try {
    return execFileSync('git', ['grep', '-I', '-n', '-E', PATTERN, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    return error.stdout?.toString() ?? ''
  }
}

// 1) 当前工作区（只扫跟踪的文件）
const work = grep(['--', '.']).split('\n').filter(Boolean)
console.log('=== 1) 当前仓库文件:', work.length === 0 ? '干净' : `${work.length} 处`)
for (const line of work.slice(0, 20)) console.log('  ' + mask(line).slice(0, 160))

// 2) 全部历史版本
let commits = []
try {
  commits = execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' }).split('\n').filter(Boolean)
} catch {
  commits = []
}
const history = commits.length > 0 ? grep(commits).split('\n').filter(Boolean) : []
console.log(`\n=== 2) 历史版本（${commits.length} 个 commit）:`, history.length === 0 ? '干净' : `${history.length} 处`)

const seen = new Set()
for (const line of history) {
  const withoutCommit = line.replace(/^[0-9a-f]{7,}:/, '')
  const key = mask(withoutCommit).slice(0, 120)
  if (seen.has(key)) continue
  seen.add(key)
  console.log('  ' + mask(line).slice(0, 160))
}

// 3) vsix 里有没有夹带真实配置
console.log('\n=== 3) vsix 包里有没有夹带 qzcode.json / .env')
try {
  const vsix = 'qzcode-3.6.2.vsix'
  const names = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Add-Type -A System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${vsix}').Entries | ForEach-Object { $_.FullName }`,
    ],
    { encoding: 'utf8' },
  )
  const all = names.split('\n').map((line) => line.trim()).filter(Boolean)
  const bad = all.filter((name) => /qzcode\.json$|\.env|secret|credential/i.test(name))
  console.log(`  ${vsix}: ${all.length} 个条目 → ${bad.length === 0 ? '没有真实配置（只有 package.json / example 模板）' : '⚠ ' + bad.join(', ')}`)
} catch (error) {
  console.log('  vsix 检查失败:', String(error.message).slice(0, 120))
}

// 4) 本地该有 key 的地方（不进仓库，正常）
console.log('\n=== 4) 本地机器上（正常，不算泄露）')
for (const path of [`${process.env.APPDATA}\\Code\\User\\globalStorage\\qzcode.qzcode\\qzcode.json`, 'qzcode.json']) {
  try {
    const text = readFileSync(path, 'utf8')
    const count = (text.match(/"apiKey"\s*:\s*"[^"]+"/g) ?? []).length
    console.log(`  ${path}: ${count} 个 apiKey`)
  } catch {
    console.log(`  ${path}: 没有`)
  }
}
