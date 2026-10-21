/*
 * Terminal input decoding.
 *
 * Terminals send escape sequences, not key events, and they arrive in arbitrary
 * chunks (a paste can split an arrow key in half). This module turns a byte-ish
 * string into key records and hands back the trailing incomplete sequence so the
 * caller can prepend it to the next read instead of dropping input.
 */

export type Key =
  | { type: 'text'; text: string }
  | { type: 'enter' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'tab'; shift: boolean }
  | { type: 'arrow'; dir: 'up' | 'down' | 'left' | 'right'; shift: boolean; alt: boolean; ctrl: boolean }
  | { type: 'home'; ctrl?: boolean }
  | { type: 'end'; ctrl?: boolean }
  | { type: 'pageup' }
  | { type: 'pagedown' }
  | { type: 'escape' }
  | { type: 'alt'; char: string }
  | { type: 'ctrl'; char: string }
  | { type: 'paste'; text: string }

export interface KeyParse {
  keys: Key[]
  /** Incomplete escape sequence to prepend to the next read. */
  rest: string
}

function modifiers(params: string[]): { shift: boolean; alt: boolean; ctrl: boolean } {
  const raw = Number(params[1] ?? '1')
  const bits = Number.isFinite(raw) ? raw - 1 : 0
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  }
}

export function parseKeys(input: string): KeyParse {
  const keys: Key[] = []
  let i = 0

  while (i < input.length) {
    const char = input[i]
    const code = char.charCodeAt(0)

    // ---- escape sequences
    if (char === '\x1b') {
      const next = input[i + 1]

      // bracketed paste
      if (input.startsWith('\x1b[200~', i)) {
        const end = input.indexOf('\x1b[201~', i + 6)
        if (end < 0) return { keys, rest: input.slice(i) }
        keys.push({ type: 'paste', text: input.slice(i + 6, end) })
        i = end + 6
        continue
      }

      if (next === '[') {
        let j = i + 2
        while (j < input.length && !(input.charCodeAt(j) >= 0x40 && input.charCodeAt(j) <= 0x7e)) j++
        if (j >= input.length) return { keys, rest: input.slice(i) }
        const final = input[j]
        const rawParams = input.slice(i + 2, j)
        const params = rawParams.split(';')
        const mods = modifiers(params)
        if (final === 'A' || final === 'B' || final === 'C' || final === 'D') {
          const dir = final === 'A' ? 'up' : final === 'B' ? 'down' : final === 'C' ? 'right' : 'left'
          keys.push({ type: 'arrow', dir, ...mods })
        } else if (final === 'H') {
          keys.push(mods.ctrl ? { type: 'home', ctrl: true } : { type: 'home' })
        } else if (final === 'F') {
          keys.push(mods.ctrl ? { type: 'end', ctrl: true } : { type: 'end' })
        } else if (final === 'Z') {
          keys.push({ type: 'tab', shift: true })
        } else if (final === '~') {
          const which = Number(params[0] ?? '0')
          if (which === 1 || which === 7) keys.push({ type: 'home' })
          else if (which === 4 || which === 8) keys.push({ type: 'end' })
          else if (which === 3) keys.push({ type: 'delete' })
          else if (which === 5) keys.push({ type: 'pageup' })
          else if (which === 6) keys.push({ type: 'pagedown' })
        }
        i = j + 1
        continue
      }

      if (next === 'O') {
        const final = input[i + 2]
        if (final === undefined) return { keys, rest: input.slice(i) }
        if (final === 'A') keys.push({ type: 'arrow', dir: 'up', shift: false, alt: false, ctrl: false })
        else if (final === 'B') keys.push({ type: 'arrow', dir: 'down', shift: false, alt: false, ctrl: false })
        else if (final === 'C') keys.push({ type: 'arrow', dir: 'right', shift: false, alt: false, ctrl: false })
        else if (final === 'D') keys.push({ type: 'arrow', dir: 'left', shift: false, alt: false, ctrl: false })
        else if (final === 'H') keys.push({ type: 'home' })
        else if (final === 'F') keys.push({ type: 'end' })
        i += 3
        continue
      }

      if (next === undefined) return { keys, rest: input.slice(i) }
      // Alt + printable character
      keys.push({ type: 'alt', char: next })
      i += 2
      continue
    }

    if (char === '\r') {
      keys.push({ type: 'enter' })
      i += 1
      continue
    }
    if (char === '\n') {
      keys.push({ type: 'enter' })
      i += 1
      continue
    }
    if (char === '\x7f' || char === '\b') {
      keys.push({ type: 'backspace' })
      i += 1
      continue
    }
    if (char === '\t') {
      keys.push({ type: 'tab', shift: false })
      i += 1
      continue
    }
    if (code > 0 && code < 0x20) {
      keys.push({ type: 'ctrl', char: String.fromCharCode(code + 96) })
      i += 1
      continue
    }

    let run = ''
    while (i < input.length) {
      const current = input[i]
      const currentCode = current.charCodeAt(0)
      if (current === '\x1b' || currentCode < 0x20 || currentCode === 0x7f) break
      run += current
      i += 1
    }
    if (run) keys.push({ type: 'text', text: run })
  }

  return { keys, rest: '' }
}
