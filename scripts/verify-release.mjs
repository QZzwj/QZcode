import { execFileSync } from 'node:child_process'

/** 用已配置的 git 凭据核对 release（匿名 API 有速率限制，会 403）。 */
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
  'user-agent': 'qzcode-verify',
  'x-github-api-version': '2022-11-28',
}

const res = await fetch('https://api.github.com/repos/QZzwj/QZcode/releases/tags/v3.5.8', { headers })
console.log('  release 查询: HTTP', res.status)
const data = await res.json()
if (!res.ok) {
  console.log('  ', JSON.stringify(data).slice(0, 200))
  process.exit(1)
}

console.log('  标题:', data.name, '| tag:', data.tag_name, '| draft:', data.draft, '| 预发布:', data.prerelease)
console.log('  地址:', data.html_url)
for (const asset of data.assets ?? []) {
  console.log(`  附件: ${asset.name} · ${Math.round(asset.size / 1024)} KB · 下载 ${asset.download_count} 次`)
  const head = await fetch(asset.browser_download_url, { method: 'HEAD', redirect: 'follow' })
  console.log(`  附件直链: HTTP ${head.status} · ${head.headers.get('content-length')} 字节`)
}
console.log('  说明行数:', (data.body ?? '').split('\n').length)
