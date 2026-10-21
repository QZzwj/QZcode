import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { buildVisionBody, describeImage, pickDescription, toDataUrl } from '../src/vision.ts'

/** 1x1 PNG（最小的合法图片） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

test('视觉模型：请求体是 OpenAI 兼容的多模态格式', () => {
  const body = buildVisionBody(
    { baseUrl: '', apiKey: '', model: 'gpt-4o', headers: {}, timeoutMs: 1000, maxTokens: 300, question: '图里写了什么' },
    'data:image/png;base64,AAAA',
  ) as { model: string; max_tokens: number; messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }

  assert.equal(body.model, 'gpt-4o')
  assert.equal(body.max_tokens, 300)
  assert.equal(body.messages.length, 1)
  const content = body.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, '图里写了什么')
  assert.equal(content[1].type, 'image_url')
  assert.deepEqual(content[1].image_url, { url: 'data:image/png;base64,AAAA' })
})

test('视觉模型：图片转成 data URL（带正确 mime）', () => {
  const dir = mkdtempSync(join(process.env.TEMP ?? '.', 'qz-vision-'))
  try {
    const file = join(dir, 'shot.png')
    writeFileSync(file, PNG_1PX)
    const url = toDataUrl(file)
    assert.match(url, /^data:image\/png;base64,/)
    assert.ok(url.length > 100, '应该真的把内容编码进去了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('视觉模型：从响应里取描述，格式不对也不炸', () => {
  assert.equal(pickDescription({ choices: [{ message: { content: ' 图里有一个按钮 ' } }] }), '图里有一个按钮')
  assert.equal(
    pickDescription({ choices: [{ message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } }] }),
    '第一段\n第二段',
  )
  assert.equal(pickDescription({}), '')
  assert.equal(pickDescription(null), '')
})

test('视觉模型：看图失败只回报原因，不抛错（不能把核验搞崩）', async () => {
  const dir = mkdtempSync(join(process.env.TEMP ?? '.', 'qz-vision-fail-'))
  try {
    const file = join(dir, 'shot.png')
    writeFileSync(file, PNG_1PX)
    // 指向一个必然连不上的地址
    const result = await describeImage(
      {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'x',
        model: 'gpt-4o',
        headers: {},
        timeoutMs: 1500,
        maxTokens: 100,
        question: '看',
      },
      file,
    )
    assert.equal(result.ok, false)
    assert.ok(result.error && result.error.length > 0, '要给出原因')
    assert.equal(result.description, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('视觉模型：空文件直接拒绝，不白花一次调用', async () => {
  const dir = mkdtempSync(join(process.env.TEMP ?? '.', 'qz-vision-empty-'))
  try {
    const file = join(dir, 'empty.png')
    writeFileSync(file, '')
    const result = await describeImage(
      { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'x', headers: {}, timeoutMs: 500, maxTokens: 10, question: '看' },
      file,
    )
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /空文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
