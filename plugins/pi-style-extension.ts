/*
 * pi 风格扩展示例：default export 一个工厂函数，拿到的是 ExtensionAPI。
 *
 * 这份代码和给 pi 写的扩展形态一致：`pi.registerTool` / `pi.registerCommand` /
 * `pi.on("tool_call" | "tool_result" | ...)`。宿主这边同一个对象同时也是 cordis
 * 风格的 ctx（`ctx.get('tools')` 也可用），所以两种写法都能跑。
 *
 * 启用方式：在 qzcode.json 里写
 *   "plugins": ["./plugins/pi-style-extension.ts"]
 */
import type { Context } from '../src/kernel.ts'

export default function (pi: Context) {
  pi.get<{ info(...a: unknown[]): void }>('logger').info('pi 风格扩展已挂载')

  // 1) 给模型加一个工具（pi 的 execute 形态，返回 { content }）
  pi.registerTool({
    name: 'count_lines',
    description: '统计文件行数（pi 风格扩展提供）',
    annotations: { readOnlyHint: true },
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
      required: ['path'],
    },
    execute(input: Record<string, unknown>, ctx: unknown) {
      const path = String(input.path ?? '')
      const fs = pi.get<{ read(p: string): string }>('fs')
      const text = fs.read(path)
      void ctx
      return { content: `${path}: ${text.split(/\r?\n/).length} 行` }
    },
  })

  // 2) 加一个 /命令（会出现在 TUI 的 /help 里）
  pi.registerCommand('trio', {
    description: '说明当前流水线的分工',
    handler(_args: string, ctx: { ui: { notify(message: string, level?: string): void } }) {
      ctx.ui.notify('A 出提示词与验收标准 → B 实现 → C 只读核验，不通过回 A 重写', 'info')
    },
  })

  // 3) 用 pi 的 tool_call / tool_result 钩子做守卫与脱敏
  pi.on('tool_call', (event: { toolName?: string; input?: Record<string, unknown> }) => {
    if (event.toolName === 'bash') {
      const command = String(event.input?.command ?? '')
      if (/\brm\s+-rf\b|\bformat\b/i.test(command)) {
        return { block: true, reason: '示例守卫：拒绝破坏性命令' }
      }
    }
    return undefined
  })

  pi.on('tool_result', (event: { toolName?: string; output?: string }) => {
    if (event.toolName === 'read' && (event.output ?? '').includes('API_KEY=')) {
      return { output: (event.output ?? '').replace(/API_KEY=\S+/g, 'API_KEY=***') }
    }
    return undefined
  })

  // 4) 观察生命周期事件
  pi.on('session_start', (payload: { goal?: string }) => {
    pi.get<{ info(...a: unknown[]): void }>('logger').info('session_start', payload?.goal ?? '')
  })
  pi.on('session_end', (payload: { ok?: boolean }) => {
    pi.get<{ info(...a: unknown[]): void }>('logger').info('session_end', String(payload?.ok))
  })
}
