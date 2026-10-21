import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 把 v3.6.0 release 上名字写错的附件删掉，再按正确名字重传。 */

const VERSION = JSON.parse(readFileSync(new URL('../vscode/package.json', import.meta.url), 'utf8')).version

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
  'user-agent': 'qzcode-fix-asset',
  'x-github-api-version': '2022-11-28',
}

const release = await fetch(`https://api.github.com/repos/QZzwj/QZcode/releases/tags/v${VERSION}`, { headers }).then((r) => r.json())
const wanted = `qzcode-${VERSION}.vsix`

for (const asset of release.assets ?? []) {
  if (asset.name === wanted) {
    console.log('已经有正确名字的附件:', asset.name)
    continue
  }
  const del = await fetch(`https://api.github.com/repos/QZzwj/QZcode/releases/assets/${asset.id}`, { method: 'DELETE', headers })
  console.log(`删掉错误附件 ${asset.name}: HTTP ${del.status}`)
}

const names = new Set((release.assets ?? []).map((a) => a.name))
if (!names.has(wanted)) {
  const bytes = readFileSync(new URL(`../qzcode-${VERSION}.vsix`, import.meta.url))
  const uploadUrl = release.upload_url.replace(/\{.*\}$/, '') + `?name=${wanted}`
  const uploaded = await fetch(uploadUrl, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
    body: bytes,
  })
  const data = await uploaded.json().catch(() => ({}))
  console.log(`重新上传 ${wanted}: HTTP ${uploaded.status}`, uploaded.ok ? data.browser_download_url : JSON.stringify(data).slice(0, 200))
}
