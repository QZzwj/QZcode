import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { buildReferenceBlock, extractFileRefs, readFileRefs } from '../src/reference.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

test('@文件：从目标里把引用抓出来（中英文标点都要断对）', () => {
  assert.deepEqual(extractFileRefs('把 @src/utils.ts 里的 parseDuration 改一下'), ['src/utils.ts'])
  assert.deepEqual(extractFileRefs('看 @a.ts 和 @b/c.ts，然后合并'), ['a.ts', 'b/c.ts'])
  assert.deepEqual(extractFileRefs('@notes/plan.md，按它实现'), ['notes/plan.md'])
  assert.deepEqual(extractFileRefs('没有引用的普通目标'), [])
  // 重复的只算一次
  assert.deepEqual(extractFileRefs('@a.ts @a.ts'), ['a.ts'])
  // 邮箱不该被当成引用（@ 前要有空白）
  assert.deepEqual(extractFileRefs('发到 me@example.com'), [])
})

test('@文件：正常文件能读，越界/不存在/二进制都给出原因', () => {
  const dir = tempWorkspace('reference-read')
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'utils.ts'), 'export const a = 1\n', 'utf8')
    writeFileSync(join(dir, 'logo.png'), 'x', 'utf8')

    const files = readFileRefs(dir, ['src/utils.ts', 'nope.ts', '../outside.ts', 'logo.png'])
    const byPath = Object.fromEntries(files.map((file) => [file.raw, file]))

    assert.equal(byPath['src/utils.ts'].ok, true)
    assert.equal(byPath['src/utils.ts'].chars, 'export const a = 1\n'.length)
    assert.equal(byPath['nope.ts'].ok, false)
    assert.match(byPath['nope.ts'].reason ?? '', /不存在/)
    assert.equal(byPath['../outside.ts'].ok, false)
    assert.match(byPath['../outside.ts'].reason ?? '', /不在工作区/)
    assert.equal(byPath['logo.png'].ok, false)
    assert.match(byPath['logo.png'].reason ?? '', /二进制/)
  } finally {
    removeDir(dir)
  }
})

test('@文件：参考块里带原文，读不到的写在末尾说明', () => {
  const dir = tempWorkspace('reference-block')
  try {
    writeFileSync(join(dir, 'plan.md'), '# 计划\n先做 A 再做 B\n', 'utf8')
    const { block, files } = buildReferenceBlock(dir, ['plan.md', 'missing.md'])

    assert.match(block, /## 参考文件/)
    assert.match(block, /### plan\.md/)
    assert.match(block, /先做 A 再做 B/)
    assert.match(block, /以下引用没用上：missing\.md/)
    assert.equal(files.length, 2)
  } finally {
    removeDir(dir)
  }
})

test('@文件：一个都读不到时返回空块（不往提示词里塞垃圾）', () => {
  const dir = tempWorkspace('reference-empty')
  try {
    const { block, files } = buildReferenceBlock(dir, ['nothing.md'])
    assert.equal(block, '')
    assert.equal(files.length, 1)
    assert.equal(files[0].ok, false)
  } finally {
    removeDir(dir)
  }
})

test('@文件：超长文件会截断，不把上下文撑爆', () => {
  const dir = tempWorkspace('reference-big')
  try {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(20000), 'utf8')
    const { block } = buildReferenceBlock(dir, ['big.txt'])
    assert.match(block, /已截断/)
    assert.ok(block.length < 8000, `参考块应该被压到 8000 字以内，实际 ${block.length}`)
  } finally {
    removeDir(dir)
  }
})
