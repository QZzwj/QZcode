/*
 * Fixture plugin: imports a real DeepSeek Harness utility package so the loader's
 * `@deepseek-ai/*` resolution hook gets exercised. Only imported when a DSH
 * install is actually present on the machine.
 */
import { camelCase } from '@deepseek-ai/cosmokit'
import type { Context } from '../../src/kernel.ts'

export default {
  name: 'dsh-dep-probe',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.get<{ register(tool: unknown): void }>('tools').register({
      name: 'camel_probe',
      description: '使用 DSH 的 cosmokit 工具函数做 camelCase（示例）。',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      run(args: Record<string, unknown>) {
        return { ok: true, output: camelCase(String(args.text ?? '')) }
      },
    })
  },
}
