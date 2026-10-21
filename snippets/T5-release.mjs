import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/make-release.mjs'
let code = readFileSync(path, 'utf8')

// 版本从 vscode/package.json 读，不再写死
code = code.replace(
  "const TAG = 'v3.5.8'",
  "const VERSION = process.env.QZ_VERSION ?? JSON.parse(readFileSync(new URL('../vscode/package.json', import.meta.url), 'utf8')).version\nconst TAG = `v${VERSION}`",
)
code = code.replace("readFileSync('release-notes-3.5.8.md', 'utf8')", "readFileSync(`release-notes-${VERSION}.md`, 'utf8')")
code = code.replace("name: 'QZcode 3.5.8',", 'name: `QZcode ${VERSION}`,')
code = code.replace("readFileSync('qzcode-3.5.8.vsix')", 'readFileSync(`qzcode-${VERSION}.vsix`)')
code = code.replace('?name=qzcode-3.5.8.vsix', '?name=qzcode-${VERSION}.vsix')

writeFileSync(path, code, 'utf8')
console.log('make-release.mjs 现在从 package.json 取版本')
console.log('  检查:', /const VERSION/.test(code) ? '✔ 有 VERSION' : '✘', '|', /qzcode-3\.5\.8/.test(code) ? '✘ 还有写死的版本' : '✔ 没有写死了')
