import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 找出"没有被任何地方引用"的文件，供清理用。 */

const root = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git', '.npm-cache', '.reference', 'vsix-history'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(root)
const candidates = files.filter((file) =>
  /(^|[\\/])(scripts[\\/].*\.mjs|docs[\\/].*\.md|README\.en\.md|release-notes-.*\.md|src[\\/].*\.ts|plugins[\\/].*\.(ts|mjs))$/.test(file),
)

console.log('候选文件:', candidates.length)

function referencesOf(file) {
  const rel = file.slice(root.length + 1).replace(/\\/g, '/')
  const base = rel.split('/').pop()
  let hits = []
  try {
    // 在整个仓库里搜文件名（排除自己）
    const out = execFileSync(
      'git',
      ['grep', '-l', '--fixed-strings', base, '--', '.', ':!node_modules', ':!.npm-cache', ':!.reference', ':!vsix-history'],
      { encoding: 'utf8', cwd: root, maxBuffer: 10 * 1024 * 1024 },
    )
    hits = out.split('\n').filter(Boolean).filter((item) => item.replace(/\\/g, '/') !== rel)
  } catch {
    hits = []
  }
  return hits
}

const unused = []
const used = []

for (const file of candidates) {
  const refs = referencesOf(file)
  const rel = file.slice(root.length + 1).replace(/\\/g, '/')
  if (refs.length === 0) unused.push(rel)
  else used.push({ rel, refs })
}

console.log('\n=== 没人引用的（可删候选）:')
for (const rel of unused.sort()) console.log('  ' + rel)

console.log('\n=== 被引用的（保留）:')
for (const item of used.sort((a, b) => a.rel.localeCompare(b.rel))) {
  console.log('  ' + item.rel + '  ← ' + item.refs.slice(0, 3).join(', '))
}

// 顶层零散文件也查一下
const tops = ['README.en.md', 'qzcode.json', 'qzcode.example.json', 'package-lock.json', 'tsconfig.build.json']
console.log('\n=== 顶层零散文件:')
for (const name of tops) {
  if (!readFileSync) continue
  try {
    const refs = execFileSync('git', ['grep', '-l', '--fixed-strings', name, '--', '.', ':!node_modules', ':!.npm-cache', ':!.reference'], {
      encoding: 'utf8',
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean)
      .filter((item) => item.replace(/\\/g, '/') !== name)
    console.log('  ' + name + ' → ' + (refs.length ? refs.slice(0, 3).join(', ') : '（无人引用）'))
  } catch {
    console.log('  ' + name + ' → （无人引用）')
  }
}
