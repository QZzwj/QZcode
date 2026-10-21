import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'

/*
 * logo 流水线：把一张透明底 PNG 变成扩展要用的两个资源。
 *
 *   node scripts/logo.mjs <输入.png> [--icon vscode/media/icon.png] [--web src/web/assets/logo.png]
 *                         [--size 128] [--ring] [--check]
 *
 *   --check  只打印统计与形状预览，不写文件
 *   --ring   沿图形内缘加一圈中性描边（白底/黑底都更清楚；透明底纯色 logo 不需要）
 */

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const tb = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])))
  return Buffer.concat([len, tb, data, crc])
}
function encodePng(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function decodePng(file) {
  const buf = readFileSync(file)
  let o = 8
  let w = 0
  let h = 0
  let bd = 0
  let ct = 0
  const idat = []
  while (o < buf.length) {
    const L = buf.readUInt32BE(o)
    const T = buf.toString('ascii', o + 4, o + 8)
    const d = buf.subarray(o + 8, o + 8 + L)
    if (T === 'IHDR') {
      w = d.readUInt32BE(0)
      h = d.readUInt32BE(4)
      bd = d[8]
      ct = d[9]
    } else if (T === 'IDAT') idat.push(d)
    else if (T === 'IEND') break
    o += 12 + L
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`只支持 8-bit RGB/RGBA，实际 ${bd}/${ct}`)
  const bpp = ct === 6 ? 4 : 3
  const stride = w * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const src = Buffer.alloc(h * stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const f = raw[p++]
    const row = raw.subarray(p, p + stride)
    p += stride
    const out = src.subarray(y * stride, (y + 1) * stride)
    const prev = y ? src.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = row[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[x] = v & 0xff
    }
  }
  const px = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = src[i * bpp]
    px[i * 4 + 1] = src[i * bpp + 1]
    px[i * 4 + 2] = src[i * bpp + 2]
    px[i * 4 + 3] = bpp === 4 ? src[i * bpp + 3] : 255
  }
  return { width: w, height: h, px }
}

const args = process.argv.slice(2)
const input = args.find((arg) => !arg.startsWith('--') && arg.includes('.'))
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const size = Number(flag('size', 128))
const ring = args.includes('--ring')
const checkOnly = args.includes('--check')
const outIcon = flag('icon', 'vscode/media/icon.png')
const outWeb = flag('web', 'src/web/assets/logo.png')

const { width, height, px } = decodePng(input)
const at = (x, y) => {
  const i = (y * width + x) * 4
  return { r: px[i], g: px[i + 1], b: px[i + 2], a: px[i + 3] }
}
const hex = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

let opaque = 0
let sumR = 0
let sumG = 0
let sumB = 0
let minX = width
let minY = height
let maxX = -1
let maxY = -1
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const c = at(x, y)
    if (c.a < 24) continue
    opaque++
    sumR += c.r
    sumG += c.g
    sumB += c.b
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
}
if (maxX < 0) throw new Error('整张图都透明')
const inkW = maxX - minX + 1
const inkH = maxY - minY + 1
const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
console.log(`输入 ${width}x${height}  不透明 ${((opaque / (width * height)) * 100).toFixed(1)}%`)
console.log(` 四角 ${corners.map((c) => `a${c.a}`).join(' ')}  平均色 ${hex({ r: Math.round(sumR / opaque), g: Math.round(sumG / opaque), b: Math.round(sumB / opaque) })}`)
console.log(` 图形 ${inkW}x${inkH} @ (${minX},${minY})`)

if (checkOnly) {
  const cols = 40
  const rows = 40
  let art = ''
  for (let ry = 0; ry < rows; ry++) {
    let line = ''
    for (let rx = 0; rx < cols; rx++) {
      const x = minX + (((rx + 0.5) * inkW) / cols | 0)
      const y = minY + (((ry + 0.5) * inkH) / rows | 0)
      const c = at(Math.min(width - 1, x), Math.min(height - 1, y))
      line += c.a < 30 ? '.' : c.r * 0.299 + c.g * 0.587 + c.b * 0.114 < 120 ? '#' : '+'
    }
    art += `${line}\n`
  }
  console.log(art)
  process.exit(0)
}

const scale = Math.min((size * 0.9) / inkW, (size * 0.9) / inkH)
const drawW = Math.max(1, Math.round(inkW * scale))
const drawH = Math.max(1, Math.round(inkH * scale))
const dx = ((size - drawW) / 2) | 0
const dy = ((size - drawH) / 2) | 0

const out = Buffer.alloc(size * size * 4, 0)
for (let oy = 0; oy < drawH; oy++) {
  for (let ox = 0; ox < drawW; ox++) {
    const sx0 = minX + (ox * inkW) / drawW
    const sx1 = minX + ((ox + 1) * inkW) / drawW
    const sy0 = minY + (oy * inkH) / drawH
    const sy1 = minY + ((oy + 1) * inkH) / drawH
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    let n = 0
    for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
      for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
        const c = at(Math.min(width - 1, sx), Math.min(height - 1, sy))
        const alpha = c.a / 255
        r += c.r * alpha
        g += c.g * alpha
        b += c.b * alpha
        a += alpha
        n++
      }
    }
    if (a <= 0.004) continue
    const i = ((oy + dy) * size + (ox + dx)) * 4
    out[i] = Math.round(r / a)
    out[i + 1] = Math.round(g / a)
    out[i + 2] = Math.round(b / a)
    out[i + 3] = Math.round((a / n) * 255)
  }
}

if (ring) {
  const STROKE = [122, 130, 148]
  const alphaAt = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : out[(y * size + x) * 4 + 3])
  let painted = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (alphaAt(x, y) < 200) continue
      let edge = false
      for (let oy2 = -2; oy2 <= 2 && !edge; oy2++) {
        for (let ox2 = -2; ox2 <= 2; ox2++) {
          if (Math.hypot(ox2, oy2) > 1.8) continue
          if (alphaAt(x + ox2, y + oy2) < 60) {
            edge = true
            break
          }
        }
      }
      if (!edge) continue
      const i = (y * size + x) * 4
      const mix = 0.62
      out[i] = Math.round(out[i] * (1 - mix) + STROKE[0] * mix)
      out[i + 1] = Math.round(out[i + 1] * (1 - mix) + STROKE[1] * mix)
      out[i + 2] = Math.round(out[i + 2] * (1 - mix) + STROKE[2] * mix)
      painted++
    }
  }
  console.log(` 描边 ${painted} px`)
}

const png = encodePng(size, size, out)
for (const target of [outIcon, outWeb]) {
  mkdirSync(target.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
  writeFileSync(target, png)
  console.log(`写出 ${target}  ${size}x${size}  图形 ${drawW}x${drawH}  ${(png.length / 1024).toFixed(1)} KB`)
}
