import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * 用 git 已经配置好的凭据调用 GitHub API 建 Release 并上传 vsix。
 * 全程不打印 token。
 */

const REPO = 'QZzwj/QZcode'
const VERSION = process.env.QZ_VERSION ?? JSON.parse(readFileSync(new URL('../vscode/package.json', import.meta.url), 'utf8')).version
const TAG = `v${VERSION}`

function gitCredential() {
  // 让 git 自己吐出它给 origin 用的凭据（凭据管理器里已有的那套）
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const fields = Object.fromEntries(
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      }),
  )
  return fields.password ?? ''
}

const token = gitCredential()
if (!token) {
  console.log('拿不到凭据：需要在 git 里登录过 github.com')
  process.exit(1)
}
console.log('拿到凭据（长度 ' + token.length + '，不打印内容）')

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'qzcode-release-script',
}

// 1) 先看看这个 tag 是不是已经有 release 了
const existing = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers })
if (existing.status === 200) {
  const data = await existing.json()
  console.log('已经有 release:', data.html_url)
} else {
  console.log('还没有 release，开始创建（HTTP ' + existing.status + '）')

  const notes = readFileSync(`release-notes-${VERSION}.md`, 'utf8')
  const created = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      name: `QZcode ${VERSION}`,
      body: notes,
      draft: false,
      prerelease: false,
    }),
  })
  const payload = await created.json()
  if (!created.ok) {
    console.log('创建失败:', created.status, JSON.stringify(payload).slice(0, 400))
    process.exit(1)
  }
  console.log('创建成功:', payload.html_url)

  // 2) 把 vsix 作为附件传上去
  const asset = readFileSync(`qzcode-${VERSION}.vsix`)
  const uploadUrl = payload.upload_url.replace(/\{.*\}$/, '') + '?name=qzcode-${VERSION}.vsix'
  const uploaded = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'content-length': String(asset.length),
    },
    body: asset,
  })
  const assetData = await uploaded.json().catch(() => ({}))
  if (uploaded.ok) {
    console.log('附件已上传:', assetData.browser_download_url, '(' + Math.round(asset.length / 1024) + ' KB)')
  } else {
    console.log('附件上传失败:', uploaded.status, JSON.stringify(assetData).slice(0, 300))
  }
}
