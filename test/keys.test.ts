import assert from 'node:assert/strict'
import test from 'node:test'
import { parseKeys } from '../src/tui/keys.ts'

test('plain text becomes one text key', () => {
  const { keys, rest } = parseKeys('hello')
  assert.equal(rest, '')
  assert.deepEqual(keys, [{ type: 'text', text: 'hello' }])
})

test('common control keys', () => {
  assert.deepEqual(parseKeys('\r').keys, [{ type: 'enter' }])
  assert.deepEqual(parseKeys('\x7f').keys, [{ type: 'backspace' }])
  assert.deepEqual(parseKeys('\t').keys, [{ type: 'tab', shift: false }])
  assert.deepEqual(parseKeys('\x03').keys, [{ type: 'ctrl', char: 'c' }])
})

test('arrows with modifiers', () => {
  const plain = parseKeys('\x1b[A').keys[0]
  assert.deepEqual(plain, { type: 'arrow', dir: 'up', shift: false, alt: false, ctrl: false })
  const ctrlRight = parseKeys('\x1b[1;5C').keys[0]
  assert.deepEqual(ctrlRight, { type: 'arrow', dir: 'right', shift: false, alt: false, ctrl: true })
  const altUp = parseKeys('\x1b[1;3A').keys[0]
  assert.deepEqual(altUp, { type: 'arrow', dir: 'up', shift: false, alt: true, ctrl: false })
  const shiftTab = parseKeys('\x1b[Z').keys[0]
  assert.deepEqual(shiftTab, { type: 'tab', shift: true })
})

test('navigation and paging keys', () => {
  assert.deepEqual(parseKeys('\x1b[5~').keys, [{ type: 'pageup' }])
  assert.deepEqual(parseKeys('\x1b[6~').keys, [{ type: 'pagedown' }])
  assert.deepEqual(parseKeys('\x1b[H').keys, [{ type: 'home' }])
  assert.deepEqual(parseKeys('\x1b[3~').keys, [{ type: 'delete' }])
})

test('ctrl+home / ctrl+end carry the ctrl flag (pi alt-screen top/bottom)', () => {
  assert.deepEqual(parseKeys('\x1b[1;5H').keys, [{ type: 'home', ctrl: true }])
  assert.deepEqual(parseKeys('\x1b[1;5F').keys, [{ type: 'end', ctrl: true }])
  assert.deepEqual(parseKeys('\x1b[F').keys, [{ type: 'end' }])
})

test('bracketed paste is preserved verbatim', () => {
  const { keys } = parseKeys('\x1b[200~a b\nc\x1b[201~')
  assert.deepEqual(keys, [{ type: 'paste', text: 'a b\nc' }])
})

test('incomplete sequences are handed back instead of dropped', () => {
  const first = parseKeys('\x1b[')
  assert.equal(first.keys.length, 0)
  assert.equal(first.rest, '\x1b[')
  const second = parseKeys(`${first.rest}A`)
  assert.deepEqual(second.keys, [{ type: 'arrow', dir: 'up', shift: false, alt: false, ctrl: false }])
})
