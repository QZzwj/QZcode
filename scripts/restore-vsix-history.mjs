import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 从 GitHub Releases 把历史安装包抓回 vsix-history/，并检查包内有没有夹带真实配置。 */

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const match = /^password=(.*)$/m.exec(out)
  return match ? match[1] : ''
}

const headers = {
  authorization: `Bearer ${token()}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'qzcode-restore-vsix',
  'x-github-api-version': '2022-11-28',
}

mkdirSync('vsix-history', { recursive: true })

const releases = await fetch('https://api.github.com/repos/QZzwj/QZcode/releases?per_page=20', { headers }).then((r) => r.json())
console.log('远端 release 数:', Array.isArray(releases) ? releases.length : 0)

for (const release of Array.isArray(releases) ? releases : []) {
  for (const asset of release.assets ?? []) {
    if (!asset.name.endsWith('.vsix')) continue
    const target = join('vsix-history', asset.name)
    if (existsSync(target) && statSync(target).size === asset.size) {
      console.log('  已有:', asset.name)
      continue
    }
    const buffer = Buffer.from(await (await fetch(asset.browser_download_url, { redirect: 'follow' })).arrayBuffer())
    writeFileSync(target, buffer)
    console.log(`  恢复: ${asset.name} (${Math.round(buffer.length / 1024)} KB)`)
  }
}

console.log('\n=== vsix-history 现状')
const files = readdirSync('vsix-history').filter((n) => n.endsWith('.vsix'))
console.log('  ' + files.join(', '))

console.log('\n=== 每个包里有没有夹带 qzcode.json / .env')
for (const name of files) {
  try {
    const entries = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Add-Type -A System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${join('vsix-history', name).replace(/\//g, '\\')}').Entries | ForEach-Object { $_.FullName }`,
      ],
      { encoding: 'utf8' },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const bad = entries.filter((entry) => /(^|\/)qzcode\.json$|\.env$|secret|credential/i.test(entry))
    console.log(`  ${bad.length === 0 ? '✔' : '⚠'} ${name}: ${entries.length} 条${bad.length ? ' → ' + bad.join(', ') : ''}`)
  } catch (error) {
    console.log(`  ? ${name}: ${String(error.message).slice(0, 80)}`)
  }
}
