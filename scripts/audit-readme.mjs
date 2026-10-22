import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { join } from 'node:path'

/**
 * README 体检（不依赖 Python）：
 *   1) 引用到的本地图片都得真存在（markdown ![]() 和 HTML <img> 两种写法都认）
 *   2) 不能是绝对路径（GitHub 上会裂）
 *   3) 首屏（前 15 行）要有图
 *   4) 每张图都要有 alt
 *   5) 所有 SVG 的文字不能出界 / 重叠（调 measure-svg.mjs）
 */

import { execFileSync } from 'node:child_process'

const readme = process.argv[2] ?? 'README.md'
if (!existsSync(readme)) {
  console.log('✘ 找不到', readme)
  process.exit(1)
}

const text = readFileSync(readme, 'utf8')
let failures = 0
const fail = (message) => {
  failures += 1
  console.log('✘ ' + message)
}
const pass = (message) => console.log('✔ ' + message)

// 收集图片：markdown + HTML
const markdownImages = [...text.matchAll(/!\[\s*([^\]]*)\]\(([^)\s]+)/g)].map((match) => ({ alt: match[1], src: match[2] }))
const htmlImages = [...text.matchAll(/<img\b[^>]*>/gi)].map((match) => {
  const src = /src="([^"]+)"/i.exec(match[0])?.[1] ?? ''
  const alt = /alt="([^"]*)"/i.exec(match[0])?.[1] ?? ''
  return { alt, src }
})
const all = [...markdownImages, ...htmlImages].filter((item) => item.src)
const local = all.filter((item) => !/^https?:/i.test(item.src))

if (all.length === 0) fail('README 里没有任何图片')
else pass(`共 ${all.length} 张图（本地 ${local.length} 张，远程 ${all.length - local.length} 张）`)

if (local.length === 0) fail('没有本地图片（首屏应该有一张）')
else {
  const missing = local.filter((item) => !existsSync(item.src.split('#')[0]))
  if (missing.length > 0) fail('图片不存在: ' + missing.map((item) => item.src).join(', '))
  else pass('本地图片文件都在')
}

const absolute = local.filter((item) => /^[A-Za-z]:|^\//.test(item.src))
if (absolute.length > 0) fail('图片用了绝对路径: ' + absolute.map((item) => item.src).join(', '))
else pass('没有绝对路径引用')

const noAlt = all.filter((item) => !item.alt || item.alt.trim() === '')
if (noAlt.length > 0) fail('图片缺 alt: ' + noAlt.map((item) => item.src).join(', '))
else pass('所有图片都有 alt')

// 市场用的 README（vscode/README.md）里不能出现 .svg —— vsce 会直接报错拒绝打包
const isMarketplace = /(^|[\\/])vscode[\\/]README\.md$/i.test(resolve(readme)) || readme.startsWith('media') === false && existsSync(join('media', 'readme'))
const svgRefs = all.filter((item) => /\.svg(\?|#|$)/i.test(item.src))
if (isMarketplace && svgRefs.length > 0) {
  fail('市场用的 README 不能引用 .svg（vsce 会拒绝：SVGs are restricted in README.md）: ' + svgRefs.map((item) => item.src).join(', ') + ' —— 跑 npm run images:marketplace 生成 PNG')
} else if (svgRefs.length > 0) {
  pass('引用的是 SVG 源文件（GitHub 可以渲染）')
}

const head = text.split('\n').slice(0, 15).join('\n')
if (/!\[|<img\b/i.test(head)) pass('首屏（前 15 行）有图')
else fail('前 15 行里没有图，首屏会显得空')

// SVG 量一遍
try {
  const svgDir = existsSync('assets/readme')
    ? 'assets/readme'
    : existsSync(join('media', 'readme'))
      ? join('media', 'readme')
      : join('vscode', 'media', 'readme')
  execFileSync('node', [new URL('./measure-svg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), svgDir], {
    stdio: 'inherit',
  })
} catch {
  fail('SVG 检查没通过（见上面逐条输出）')
}

console.log(failures === 0 ? '\nREADME 体检通过' : `\n${failures} 项没通过`)
process.exit(failures === 0 ? 0 : 1)
