import type { Context } from './kernel.ts'
import type { Toolbox } from './tools.ts'

interface ToolCallHookValue {
  toolName: string
  input: Record<string, unknown>
  block?: boolean
  reason?: string
}

interface ToolResultHookValue {
  toolName: string
  input: Record<string, unknown>
  ok: boolean
  output: string
}

/**
 * Connects the kernel to the toolbox: extension `tool_call` / `tool_result`
 * hooks become tool guards and result transformers (pi's gate/transform events).
 */
export function wireHost(ctx: Context, toolbox: Toolbox): void {
  toolbox.hooks = {
    async before(event) {
      const outcome = await ctx.runHook<ToolCallHookValue>('tool_call', { ...event })
      return { block: outcome.block, reason: outcome.reason }
    },
    async after(event) {
      const outcome = await ctx.runHook<ToolResultHookValue>('tool_result', { ...event })
      // Only forward a replacement when a handler actually changed the text.
      return outcome.output === event.output ? undefined : { output: outcome.output }
    },
  }
}
