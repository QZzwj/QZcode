import test from 'node:test'
import assert from 'node:assert/strict'
import { listProviders } from '../src/providers.ts'
import { mockConfig, tempWorkspace, removeDir } from './helpers.ts'

/** 供应商清单：内置预设不能冒充"用户自己配置的供应商"。 */

test('供应商清单：只有正在用的那家算已配置', () => {
  const dir = tempWorkspace('providers-list')
  try {
    const config = mockConfig(dir)
    // 角色用的是 hhd（非预设端点）
    for (const role of ['leader', 'planner', 'implementer', 'verifier'] as const) {
      config.roles[role].provider = 'hhd'
      config.roles[role].baseUrl = 'https://ruoli.dev/v1'
      config.roles[role].apiKey = 'sk-test'
    }

    const state = listProviders(config)
    const mine = state.providers.filter((item) => item.configured === true)
    const presets = state.providers.filter((item) => item.configured !== true)

    assert.deepEqual(mine.map((item) => item.id), ['hhd'], '只有 hhd 是用户配的')
    assert.ok(presets.length >= 5, '内置预设仍然在清单里（界面会单独分组）')
    assert.ok(
      presets.every((item) => item.id !== 'hhd'),
      '预设组里不该出现 hhd',
    )
    // 预设里确实包含那几个常见家
    for (const id of ['deepseek', 'openai', 'openrouter', 'moonshot', 'zhipu', 'ollama', 'lmstudio']) {
      assert.ok(
        state.providers.some((item) => item.id === id),
        `预设 ${id} 不该丢`,
      )
    }
  } finally {
    removeDir(dir)
  }
})

test('供应商清单：以前填过 key 的那家也算已配置', () => {
  const dir = tempWorkspace('providers-history')
  try {
    const config = mockConfig(dir)
    config.roles.planner.provider = 'hhd'
    config.roles.planner.apiKey = 'sk-test'
    // 以前在 deepseek 上填过 key
    config.roles.implementer.keyHistory = { deepseek: 'sk-deepseek' }
    config.roles.verifier.keyHistory = { deepseek: '' }

    const state = listProviders(config)
    const mine = state.providers.filter((item) => item.configured === true).map((item) => item.id)
    assert.deepEqual(mine.sort(), ['deepseek', 'hhd'], '有 key 历史的那家也算配过')
  } finally {
    removeDir(dir)
  }
})
