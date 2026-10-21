import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FakeNode, createDocument, findByClass, textOf } from './dom-shim.ts'

/*
 * 真跑 vscode/media/settings.js：验证"测试连接 / 拉模型 / 保存"的反馈
 * 落在**对应那张卡片**里，而不是页面底部那条灰栏。
 * 上一版只做静态断言，结果 cardStatus 节点根本没进卡片，用户看到的还是底栏。
 */

const IDS = [
  'cards',
  'status',
  'config-path',
  'workspace-path',
  'open-config',
  'tab-models',
  'tab-skills',
  'skills-table',
  'skills-hint',
  'import-value',
  'import-skill',
  'tab-cost',
  'cost-summary',
  'cost-body',
]

function role(name: string, title: string, model: string) {
  return {
    role: name,
    title,
    provider: 'gatewaya',
    baseUrl: 'https://gateway.example.com/v1',
    model,
    hasKey: true,
    keyHint: 'sk-5…d672',
    temperature: 0.3,
    maxTokens: 4096,
    maxSteps: 40,
    headers: {},
    timeoutMs: 180000,
    retries: 2,
    mock: false,
    custom: true,
  }
}

function roleState() {
  return {
    roles: [
      role('leader', 'L · 调度', 'cn:auto'),
      role('planner', 'A · 规划', 'cn:deepseek-chat'),
      role('implementer', 'B · 实现', 'cn:deepseek-chat'),
      role('verifier', 'C · 核验', 'cn:deepseek-v4-pro'),
    ],
    providers: [
      {
        id: 'gatewaya',
        label: 'gatewaya',
        baseUrl: 'https://gateway.example.com/v1',
        model: 'cn:auto',
        envKey: '',
        active: true,
        hasKey: true,
      },
    ],
    configPath: 'C:\\Users\\jn\\AppData\\Roaming\\Code\\User\\globalStorage\\qzcode.qzcode\\qzcode.json',
  }
}

test('设置面板：反馈落在各自卡片里，不在页面底部', async () => {
  const doc = createDocument(IDS)
  const posted: Record<string, unknown>[] = []
  const listeners: ((event: { data: unknown }) => void)[] = []
  const globals = globalThis as Record<string, unknown>
  const original = {
    document: globals.document,
    window: globals.window,
    acquireVsCodeApi: globals.acquireVsCodeApi,
    Node: globals.Node,
  }

  globals.document = doc
  globals.Node = FakeNode
  globals.acquireVsCodeApi = () => ({
    postMessage(message: Record<string, unknown>) {
      posted.push(message)
    },
  })
  globals.window = {
    addEventListener(_event: string, listener: (event: { data: unknown }) => void) {
      listeners.push(listener)
    },
  }

  try {
    const modulePath = '../vscode/media/settings.js'
    // 纯 JS 的 webview 脚本（没有类型声明），靠变量走动态 import
    await import(modulePath)
    const send = (data: unknown) => {
      for (const listener of listeners) listener({ data })
    }

    // 1) 初始渲染：三条卡片，每张卡自带状态行
    send({ type: 'state', state: roleState() })
    const cards = doc.all.get('cards') as FakeNode
    assert.ok(cards, '要有卡片容器')
    assert.equal(cards.children.length, 4, 'L + A/B/C 四条卡片')
    // 模型设置与导入技能合并成一个面板：两个页签（DOM 由 html 提供，这里查文件）
    // 页面模板在 vscode/pages.cjs 里（安装包不再带 .html）
    const html = readFileSync(new URL('../vscode/pages.cjs', import.meta.url), 'utf8')
    assert.match(html, /data-tab="models"[\s\S]*data-tab="skills"/, '要有「模型」「技能」两个页签')
    assert.match(html, /id="skills-table"/, '技能表')
    assert.match(html, /id="import-value"/, '导入输入框')
    assert.match(html, /id="import-skill"/, '导入按钮')
    const script = readFileSync(new URL('../vscode/media/settings.js', import.meta.url), 'utf8')
    assert.match(script, /function switchTab/, '页签切换逻辑')
    assert.match(script, /function renderSkillTable/, '技能表渲染')
    assert.match(script, /removeSkill/, '导入的技能可删除')
    assert.equal(findByClass(cards, 'card-status').length, 4, '每张卡片下面都要有自己的状态行')
    // 「三个都用这套」在 4 个角色下不准确，按钮要说清复制给几个
    assert.match(textOf(cards.children[1] as FakeNode), /全部都用这套（3）/, '按钮要带数量')
    assert.match(textOf(cards.children[1] as FakeNode), /保存/)
    assert.match(textOf(cards.children[1] as FakeNode), /测试连接/)

    // 2) 连接测试成功 → 只出现在 A 卡片里
    send({
      type: 'tested',
      role: 'planner',
      result: { ok: true, ms: 1683, model: 'cn:deepseek-chat', models: new Array(56).fill({ id: 'x' }) },
    })
    const plannerStatus = findByClass(cards.children[1] as FakeNode, 'card-status')[0]
    assert.match(textOf(plannerStatus), /连接正常 · 1683ms/, '反馈要在 A 卡片里')
    assert.match(textOf(plannerStatus), /56 个模型/)
    assert.equal(plannerStatus.hidden, false, '有内容时不能藏着')
    assert.match(plannerStatus.className, /ok/)
    assert.doesNotMatch(textOf(doc.all.get('status')), /连接正常/, '底部不该再出现角色级反馈')
    for (const index of [0, 2, 3]) {
      assert.equal(
        textOf(findByClass(cards.children[index] as FakeNode, 'card-status')[0]).trim(),
        '',
        '别的卡片不能被串上',
      )
    }

    // 3) 扩展会在 tested 之后再推一次 state（重渲染）→ 反馈不能丢
    send({ type: 'state', state: roleState() })
    const rerendered = doc.all.get('cards') as FakeNode
    const afterRerender = findByClass(rerendered.children[1] as FakeNode, 'card-status')[0]
    assert.match(textOf(afterRerender), /连接正常 · 1683ms/, '重渲染后要还原')

    // 4) 失败信息也回自己的卡片
    send({ type: 'tested', role: 'verifier', result: { ok: false, ms: 900, error: '/models 返回 401：bad key' } })
    const afterFail = doc.all.get('cards') as FakeNode
    const verifierStatus = findByClass(afterFail.children[3] as FakeNode, 'card-status')[0]
    assert.match(textOf(verifierStatus), /连接失败 · 900ms/)
    assert.match(textOf(verifierStatus), /401/)
    assert.match(verifierStatus.className, /err/)

    // 5) 拉模型：反馈进卡片，且模型字段变成可选项
    send({
      type: 'models',
      role: 'implementer',
      result: { ok: true, ms: 300, models: [{ id: 'cn:deepseek-chat', contextLength: 1000000, credits: 'x0.11' }] },
    })
    const implCards = doc.all.get('cards') as FakeNode
    const implCard = implCards.children[2] as FakeNode
    assert.match(textOf(findByClass(implCard, 'card-status')[0]), /1 个模型/)
    assert.match(textOf(implCard), /cn:deepseek-chat · 1000k 上下文 · x0\.11/, '下拉里要有带上下文的选项')
    // 重渲染后下拉也要还原（不然每次保存都要重拉）
    send({ type: 'state', state: roleState() })
    assert.match(
      textOf(implCards.children[2] as FakeNode),
      /cn:deepseek-chat · 1000k 上下文/,
      '重渲染后模型下拉要还原',
    )
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
  }
})
