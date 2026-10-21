/*
 * A small ANSI renderer with differential output.
 *
 * The idea is the same one pi-tui is built around: keep a virtual frame of
 * styled lines, compare it with what is already on screen, and only rewrite the
 * rows that actually changed. That keeps a three-pane, streaming TUI from
 * flickering and from flooding the terminal with bytes.
 *
 * Width handling is CJK-aware because the UI is Chinese-first: every Chinese
 * glyph occupies two cells, and getting that wrong makes boxes ragged.
 */

export type Color = string | number | readonly [number, number, number]

export interface Style {
  fg?: Color
  bg?: Color
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

export interface Span {
  text: string
  style?: Style
}

export type Line = Span[]

const NAMED: Record<string, number> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  gray: 8,
  grey: 8,
  brightRed: 9,
}

function colorCode(color: Color, layer: 'fg' | 'bg'): string {
  const base = layer === 'fg' ? 30 : 40
  const bright = layer === 'fg' ? 90 : 100
  const extended = layer === 'fg' ? 38 : 48
  if (typeof color === 'number') {
    if (color < 8) return String(base + color)
    if (color < 16) return String(bright + (color - 8))
    return `${extended};5;${color}`
  }
  if (typeof color === 'string') {
    const named = NAMED[color]
    if (named === undefined) return ''
    return named < 8 ? String(base + named) : String(bright + (named - 8))
  }
  return `${extended};2;${color[0]};${color[1]};${color[2]}`
}

export function styleToAnsi(style?: Style): string {
  if (!style) return ''
  const codes: string[] = []
  if (style.bold) codes.push('1')
  if (style.dim) codes.push('2')
  if (style.italic) codes.push('3')
  if (style.underline) codes.push('4')
  if (style.inverse) codes.push('7')
  if (style.fg !== undefined) {
    const code = colorCode(style.fg, 'fg')
    if (code) codes.push(code)
  }
  if (style.bg !== undefined) {
    const code = colorCode(style.bg, 'bg')
    if (code) codes.push(code)
  }
  if (codes.length === 0) return ''
  return `\x1b[${codes.join(';')}m`
}

export const RESET = '\x1b[0m'

export function paint(line: Line): string {
  let out = ''
  for (const span of line) {
    if (!span.text) continue
    const prefix = styleToAnsi(span.style)
    out += prefix ? prefix + span.text + RESET : span.text
  }
  return out
}

/** Terminal display width of a single code point (East Asian Width aware). */
export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0
  // combining marks & zero-width
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0xfeff
  ) {
    return 0
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

export function measure(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0)
  return width
}

export function plainText(line: Line): string {
  return line.map((span) => span.text).join('')
}


interface Token {
  ch: string
  style?: Style
  w: number
}

function toSpans(tokens: Token[]): Line {
  const out: Line = []
  for (const token of tokens) {
    const last = out[out.length - 1]
    if (last && sameStyle(last.style, token.style)) last.text += token.ch
    else out.push({ text: token.ch, style: token.style })
  }
  // trailing spaces would paint ragged background edges
  const last = out[out.length - 1]
  if (last) last.text = last.text.replace(/[ \t]+$/, '')
  return out.filter((span) => span.text.length > 0)
}

/**
 * Wrapping that understands CJK (break anywhere) plus Latin words (break at
 * spaces when possible) and explicit newlines. Always returns >= 1 line.
 */
export function wrap(spans: Line, width: number): Line[] {
  const safeWidth = Math.max(1, Math.floor(width))
  const lines: Line[] = []
  let current: Token[] = []
  let used = 0

  const flush = () => {
    lines.push(toSpans(current))
    current = []
    used = 0
  }

  const append = (token: Token) => {
    current.push(token)
    used += token.w
  }

  /** Break at the last space so English words are not chopped mid-word. */
  const wrapOverflow = (token: Token) => {
    let breakAt = -1
    for (let i = current.length - 1; i >= 0; i--) {
      if (current[i].ch === ' ') {
        breakAt = i
        break
      }
    }
    if (breakAt > 0 && current.length - breakAt < Math.max(8, Math.floor(safeWidth / 2))) {
      const carry = current.slice(breakAt + 1)
      current = current.slice(0, breakAt)
      lines.push(toSpans(current))
      current = carry
      used = carry.reduce((sum, item) => sum + item.w, 0)
    } else {
      flush()
    }
    append(token)
  }

  for (const span of spans) {
    for (const ch of span.text ?? '') {
      if (ch === '\n') {
        flush()
        continue
      }
      const token: Token = { ch, style: span.style, w: charWidth(ch.codePointAt(0) ?? 0) }
      if (used + token.w > safeWidth && used > 0) wrapOverflow(token)
      else append(token)
    }
  }
  if (current.length > 0 || lines.length === 0) flush()
  return lines
}

function sameStyle(a?: Style, b?: Style): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.inverse === !!b.inverse
  )
}

export function truncate(line: Line, width: number, ellipsis = '…'): Line {
  const limit = Math.max(0, Math.floor(width))
  const out: Line = []
  let used = 0
  for (const span of line) {
    let text = ''
    for (const char of span.text) {
      const charW = charWidth(char.codePointAt(0) ?? 0)
      if (used + charW > limit - 1) {
        if (text) out.push({ text, style: span.style })
        out.push({ text: ellipsis, style: span.style })
        return out
      }
      text += char
      used += charW
    }
    if (text) out.push({ text, style: span.style })
  }
  return out
}

export function fit(line: Line, width: number, style?: Style): Line {
  const used = measure(plainText(line))
  if (used > width) return truncate(line, width)
  const out = [...line]
  if (used < width) out.push({ text: ' '.repeat(width - used), style })
  return out
}

/** The minimal slice of a writable terminal this renderer needs. */
export interface ScreenTarget {
  columns?: number
  rows?: number
  write(chunk: string): unknown
}

/** ANSI terminal with an alternate screen and row-level diffing. */
export class Screen {
  private out: ScreenTarget
  private previous: string[] = []
  private active = false
  private _width = 80
  private _height = 24

  constructor(out: ScreenTarget) {
    this.out = out
    this.refreshSize()
  }

  get width(): number {
    return this._width
  }

  get height(): number {
    return this._height
  }

  refreshSize(): void {
    this._width = Math.max(20, this.out.columns ?? 80)
    this._height = Math.max(8, this.out.rows ?? 24)
  }

  enter(): void {
    if (this.active) return
    this.active = true
    this.previous = []
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J')
  }

  leave(): void {
    if (!this.active) return
    this.active = false
    this.out.write('\x1b[?25h\x1b[0m\x1b[?1049l')
  }

  invalidate(): void {
    this.previous = []
    this.out.write('\x1b[H\x1b[2J')
  }

  draw(lines: Line[], cursor?: { row: number; col: number } | null): void {
    if (!this.active) return
    this.refreshSize()
    const rows = lines.slice(0, this._height)
    let buffer = ''
    for (let row = 0; row < rows.length; row++) {
      const painted = paint(rows[row])
      if (painted !== this.previous[row]) {
        buffer += `\x1b[${row + 1};1H\x1b[2K${painted}`
      }
    }
    for (let row = rows.length; row < this.previous.length; row++) {
      buffer += `\x1b[${row + 1};1H\x1b[2K`
    }
    this.previous = rows.map((line) => paint(line))
    if (cursor) {
      buffer += '\x1b[?25h'
      buffer += `\x1b[${Math.min(this._height, Math.max(1, cursor.row))};${Math.max(1, cursor.col)}H`
    } else {
      buffer += '\x1b[?25l'
    }
    if (buffer) this.out.write(buffer)
  }
}
