import { readFileSync, writeFileSync } from 'node:fs'

// 1) make-release：附件名那句被改成了单引号里的字面量，改回模板字符串
{
  const path = 'scripts/make-release.mjs'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    "const uploadUrl = payload.upload_url.replace(/\\{.*\\}$/, '') + '?name=qzcode-${VERSION}.vsix'",
    'const uploadUrl = payload.upload_url.replace(/\\{.*\\}$/, \'\') + `?name=qzcode-${VERSION}.vsix`',
  )
  writeFileSync(path, code, 'utf8')
  const ok = /\+ `\?name=qzcode-\$\{VERSION\}\.vsix`/.test(code)
  console.log('make-release 附件名:', ok ? '✔ 用模板字符串' : '✘ 还是字面量')
}

// 2) verify-release：版本也从 package.json 读
{
  const path = 'scripts/verify-release.mjs'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('const VERSION')) {
    code = code.replace(
      "import { execFileSync } from 'node:child_process'",
      "import { execFileSync } from 'node:child_process'\nimport { readFileSync } from 'node:fs'\n\nconst VERSION = process.env.QZ_VERSION ?? JSON.parse(readFileSync(new URL('../vscode/package.json', import.meta.url), 'utf8')).version",
    )
    code = code.replace('/releases/tags/v3.5.8', '/releases/tags/v${VERSION}')
    code = code.replace("'https://api.github.com/repos/QZzwj/QZcode/releases/tags/v${VERSION}'", '`https://api.github.com/repos/QZzwj/QZcode/releases/tags/v${VERSION}`')
    writeFileSync(path, code, 'utf8')
    console.log('verify-release 也按版本查了')
  }
}
