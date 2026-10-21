import assert from 'node:assert/strict'
import test from 'node:test'
import { Screen, fit, measure, paint, plainText, truncate, wrap } from '../src/tui/screen.ts'
import { fakeTerminal } from './helpers.ts'

test('measure is CJK aware', () => {
  assert.equal(measure('abc'), 3)
  assert.equal(measure('中文'), 4)
  assert.equal(measure('a中b'), 4)
  assert.equal(measure(''), 0)
})

test('wrap breaks CJK anywhere and Latin at spaces', () => {
  const cjk = wrap([{ text: '一二三四五六' }], 6)
  assert.equal(cjk.length, 2)
  assert.equal(plainText(cjk[0]), '一二三')
  assert.equal(plainText(cjk[1]), '四五六')

  const latin = wrap([{ text: 'alpha beta gamma delta' }], 12)
  for (const line of latin) assert.ok(measure(plainText(line)) <= 12)
  assert.equal(latin[0].map((s) => s.text).join(''), 'alpha beta')
})

test('wrap honours explicit newlines and keeps styles', () => {
  const lines = wrap([{ text: 'a\nb', style: { fg: 'red' } }], 20)
  assert.equal(lines.length, 2)
  assert.equal(plainText(lines[0]), 'a')
  assert.equal(lines[1][0].style?.fg, 'red')
})

test('truncate adds an ellipsis and stays inside the width', () => {
  const line = truncate([{ text: 'abcdefghij' }], 5)
  assert.ok(measure(plainText(line)) <= 5)
  assert.ok(plainText(line).endsWith('…'))
})

test('fit pads to width', () => {
  const padded = fit([{ text: 'abc' }], 6)
  assert.equal(measure(plainText(padded)), 6)
  assert.equal(plainText(padded), 'abc   ')
})

test('paint emits ANSI and plainText strips back to the text', () => {
  const painted = paint([{ text: 'hi', style: { fg: 'red', bold: true } }])
  assert.ok(painted.includes('\x1b['))
  assert.equal(plainText([{ text: 'hi' }]), 'hi')
})

test('Screen only rewrites rows that changed', () => {
  const term = fakeTerminal(20, 4)
  const screen = new Screen(term.out)
  screen.enter()
  term.send('')
  const first = term.output().length
  screen.draw([[{ text: 'one' }], [{ text: 'two' }], [], []])
  const afterFirst = term.output().slice(first)
  assert.ok(afterFirst.includes('one'))
  const beforeSecond = term.output().length
  screen.draw([[{ text: 'one' }], [{ text: 'TWO' }], [], []])
  const afterSecond = term.output().slice(beforeSecond)
  assert.ok(afterSecond.includes('TWO'))
  assert.ok(!afterSecond.includes('one'), 'unchanged row must not be repainted')
  screen.leave()
})
