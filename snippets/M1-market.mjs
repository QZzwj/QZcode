import { readFileSync, writeFileSync } from 'node:fs'

// 1) 打包清单放行 LICENSE / CHANGELOG（市场页面要显示这两个）
{
  const path = 'vscode/.vscodeignore'
  let code = readFileSync(path, 'utf8')
  const lines = code.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const entry of ['!LICENSE', '!CHANGELOG.md']) {
    if (!lines.includes(entry)) lines.push(entry)
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  console.log('.vscodeignore：放行 LICENSE / CHANGELOG.md')
}

// 2) manifest 补市场需要的元信息
{
  const path = 'vscode/package.json'
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.homepage = 'https://github.com/QZzwj/QZcode#readme'
  pkg.bugs = { url: 'https://github.com/QZzwj/QZcode/issues' }
  pkg.galleryBanner = { color: '#0f1115', theme: 'dark' }
  pkg.license = 'MIT'
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log('manifest：补 homepage / bugs / galleryBanner')
}
