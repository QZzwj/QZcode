import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_CATALOG, catalogLabel, findCatalogEntry } from '../src/catalog.ts'
import { listProviders } from '../src/providers.ts'
import { mockConfig, removeDir, tempWorkspace } from './helpers.ts'

/** 供应商清单：这是"可选项列表"，不是"已经填好的配置"。 */

test('清单：16 家平台 + openai，名字和站点都对得上', () => {
  const names = PROVIDER_CATALOG.map((entry) => entry.name)
  const expected = [
    'Astron Coding Plan',
    'Baidu Qianfan',
    'BaiLing',
    'BytePlus',
    'DeepSeek',
    '火山 Agent Plan',
    'Kimi',
    'Longcat',
    'MiniMax',
    '千问AI平台',
    'QwenCloud',
    'StepFun',
    '腾讯云',
    'Xiaomi MiMo',
    'Zhipu GLM',
    'OpenAI',
  ]
  assert.deepEqual(names, expected)

  const sites = Object.fromEntries(PROVIDER_CATALOG.map((entry) => [entry.name, entry.site]))
  assert.equal(sites.DeepSeek, 'platform.deepseek.com')
  assert.equal(sites.Kimi, 'platform.kimi.com')
  assert.equal(sites['腾讯云'], 'cloud.tencent.com')
  assert.equal(sites['Zhipu GLM'], 'open.bigmodel.cn')
})

test('清单：id 唯一，地址要么是可用的 https，要么留空待填', () => {
  const ids = PROVIDER_CATALOG.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复')
  for (const entry of PROVIDER_CATALOG) {
    if (entry.baseUrl) {
      assert.match(entry.baseUrl, /^https:\/\//, `${entry.name} 的地址要 https`)
    } else {
      assert.ok(entry.needsRoute === true || entry.site.length > 0, `${entry.name} 留空要有站点提示`)
    }
  }
})

test('清单：BaiLing 标了"需要路由"，不知道地址的不硬填', () => {
  const antling = findCatalogEntry('ant-ling')
  assert.ok(antling)
  assert.equal(antling?.needsRoute, true)
  assert.equal(antling?.baseUrl, '', '不确定的地址宁可留空，让用户按文档填')

  // 不确定的那几家都别编地址
  for (const id of ['ant-ling', 'qianwen', 'qwencloud', 'xiaomi-mimo']) {
    assert.equal(findCatalogEntry(id)?.baseUrl, '', `${id} 的地址还没确认，不能瞎写`)
  }
})

test('清单：下拉文字是"名称 · 站点（· N 个版本）"', () => {
  assert.equal(catalogLabel(findCatalogEntry('deepseek')!), 'DeepSeek · platform.deepseek.com')
  assert.equal(catalogLabel(findCatalogEntry('kimi')!), 'Kimi · platform.kimi.com · 4 个版本')
  assert.equal(catalogLabel(findCatalogEntry('tencent')!), '腾讯云 · cloud.tencent.com · 7 个版本')
})

test('清单只是选项：默认没有任何一家算"已配置"', () => {
  const dir = tempWorkspace('catalog-state')
  try {
    const config = mockConfig(dir)
    for (const role of ['leader', 'planner', 'implementer', 'verifier'] as const) {
      config.roles[role].provider = 'gatewaya'
      config.roles[role].apiKey = 'sk-test'
    }
    const state = listProviders(config)
    // 下拉清单里所有条目都不带"已配置"的含义
    assert.equal(state.catalog.length, PROVIDER_CATALOG.length)
    assert.ok(
      state.catalog.every((item) => item.current === false),
      'gatewaya 不在清单里，所以没有条目被标成 current',
    )
    // 而"已配置"的判定仍然只认真正在用的那家
    const configured = state.providers.filter((item) => item.configured === true).map((item) => item.id)
    assert.deepEqual(configured, ['gatewaya'])
  } finally {
    removeDir(dir)
  }
})
