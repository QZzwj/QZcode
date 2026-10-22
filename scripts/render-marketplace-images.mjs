import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 把 vscode/media/readme 里的 SVG 渲染成 PNG，并把 vscode/README.md 的引用改成 PNG。
 *
 * 为什么必须这样：vsce 直接拒绝 README 里的 .svg
 *   ERROR SVGs are restricted in README.md; please use other file image formats, such as PNG
 * 所以 SVG 是**源文件**（GitHub README 直接用），PNG 是给市场用的生成物。
 * 改了 SVG 之后跑这一条即可。
 */

const chrome = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
].find((path) => existsSync(path))
if (!chrome) {
  console.log('没有可用的 Chromium/Edge')
  process.exit(1)
}

const dir = join('vscode', 'media', 'readme')
const svgs = readdirSync(dir).filter((name) => name.endsWith('.svg'))
console.log(`渲染 ${svgs.length} 个 SVG → PNG（2x，高 DPI 不糊）`)

for (const name of svgs) {
  const svg = resolve(join(dir, name))
  const png = resolve(svg.replace(/\.svg$/, '.png'))
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(readFileSync(svg, 'utf8'))
  const width = box ? Number(box[1]) : 1200
  const height = box ? Number(box[2]) : 400
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=${width},${height}`,
      `--screenshot=${png}`,
      `file:///${svg.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore' },
  )
  const size = readFileSync(png).length
  console.log(`  ${name} → ${name.replace(/\.svg$/, '.png')}  ${width}×${height} @2x · ${Math.round(size / 1024)} KB`)
}

// 引用改成 PNG
const readme = join('vscode', 'README.md')
let text = readFileSync(readme, 'utf8')
const before = text
text = text.replace(/(media\/readme\/[\w-]+)\.svg/g, '$1.png')
if (text !== before) {
  writeFileSync(readme, text, 'utf8')
  console.log('vscode/README.md 的引用已改成 .png')
} else {
  console.log('vscode/README.md 已经是 .png 引用')
}
