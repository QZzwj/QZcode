/*
 * 示例插件：演示 QZcode 的插件契约。
 *
 * 这个对象形态与 cordis 的插件对象一致（name / inject / apply），所以同一份代码
 * 稍作调整就能跑在 DeepSeek Harness 里；反过来，一个只依赖 ctx.set/get/on/effect
 * 的纯 cordis 插件也能被 QZcode 直接加载。
 *
 * 启用方式：在 qzcode.json 里写
 *   "plugins": ["./plugins/example-plugin.ts"]
 */
import type { Context } from '../src/kernel.ts'

export default {
  name: 'example-plugin',
  // 这三个服务由 host 提供，齐了才会调用 apply（等价于 cordis 的 inject）
  inject: ['tools', 'logger', 'config'],

  apply(ctx: Context) {
    const logger = ctx.get<{ info(...a: unknown[]): void }>('logger')
    const config = ctx.get<{ workspace: string }>('config')
    logger.info(`example-plugin 已挂载，工作区 ${config.workspace}`)

    ctx.get<{ register(tool: unknown): void }>('tools').register({
      name: 'word_count',
      description: '统计一个文本文件的字符数、行数与 CJK 字符数（示例插件提供的工具）。',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
        required: ['path'],
      },
      run(args: Record<string, unknown>, runtime: { workspace: string }) {
        const path = String(args.path ?? '')
        if (!path) return { ok: false, output: '缺少 path' }
        try {
          const fs = ctx.get<{ read(p: string): string }>('fs')
          const text = fs.read(path)
          const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
          const lines = text.split(/\r?\n/).length
          return {
            ok: true,
            output: `${path}: ${text.length} 字符 / ${lines} 行 / ${cjk} 个 CJK 字符（工作区 ${runtime.workspace}）`,
          }
        } catch (error) {
          return { ok: false, output: `读取失败: ${(error as Error).message}` }
        }
      },
    })

    // 事件总线是共享的：这里监听工具注册，方便调试插件行为
    ctx.on('tool:registered', (...args: unknown[]) => {
      logger.info(`工具已注册: ${String(args[0])}`)
    })

    // 用 effect 挂清理逻辑，插件被卸载时会自动执行
    ctx.effect(() => {
      logger.info('example-plugin 已卸载')
    })
  },
}
