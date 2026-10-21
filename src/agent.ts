import type { ChatMessage, LlmClient, Usage } from './llm.ts'
import { addUsage, LlmError } from './llm.ts'
import type { ToolResult, ToolRuntime, Toolbox } from './tools.ts'

export interface ToolCallRecord {
  name: string
  args: string
  ok: boolean
  output: string
  ms: number
}

/** 只有这两个工具算"真的动手"了。 */
const WRITE_TOOLS = new Set(['write', 'edit'])
/** 连续这么多次只读调用就提醒一次。 */
const PROBE_LIMIT = 4

export interface AgentHooks {
  onText?(delta: string): void
  onTextEnd?(): void
  onToolStart?(call: { name: string; args: string }): void
  onToolEnd?(record: ToolCallRecord): void
  onStep?(index: number): void
  onUsage?(usage: Usage): void
  /** Fired when the model emits a redacted reasoning stream. */
  onReasoning?(delta: string): void
  /** 运行中的提示（不走模型输出，用来告诉界面发生了什么，比如"任务书重写"）。 */
  onNote?(message: string, level?: 'info' | 'warn' | 'error'): void
}

export interface AgentRunOptions {
  client: LlmClient
  system: string
  /** Conversation so far; the caller owns it so rounds can share memory. */
  messages: ChatMessage[]
  toolbox: Toolbox
  runtime: ToolRuntime
  maxSteps: number
  signal?: AbortSignal
  hooks?: AgentHooks
  toolFilter?: { readOnly?: boolean; names?: string[] }
  /** Called before each model call so callers can observe progress. */
  onLoop?(): void
}

export interface AgentRunResult {
  finalText: string
  messages: ChatMessage[]
  usage: Usage
  steps: number
  toolCalls: ToolCallRecord[]
}

function abortError(): Error {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

/**
 * One bounded tool-calling loop. It never decides policy (who runs when, whether
 * to retry a phase) - that belongs to the pipeline; this only turns a
 * conversation into tool calls and a final answer.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { client, toolbox, runtime, hooks } = options
  const messages = options.messages
  if (!messages.some((message) => message.role === 'system')) {
    messages.unshift({ role: 'system', content: options.system })
  }
  const toolDefs = toolbox.defs(options.toolFilter ?? {})
  let usage: Usage = { prompt: 0, completion: 0, total: 0 }
  const records: ToolCallRecord[] = []
  /** 连续只读调用次数（写/改文件会清零）。 */
  let probeStreak = 0
  let steps = 0
  let finalText = ''

  for (let step = 0; step < options.maxSteps; step++) {
    if (options.signal?.aborted) throw abortError()
    steps = step + 1
    options.onLoop?.()
    hooks?.onStep?.(steps)

    const result = await client.chat({
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      signal: options.signal,
      onDelta: hooks?.onText,
      onReasoning: hooks?.onReasoning,
      // 截断自动重试之类的运行提示，交给界面显示
      onNote: hooks?.onNote ? (message: string, level?: 'info' | 'warn' | 'error') => hooks.onNote?.(message, level) : undefined,
      label: client.role,
    })
    usage = addUsage(usage, result.usage)
    hooks?.onUsage?.(result.usage)
    hooks?.onTextEnd?.()

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: result.content,
      tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
    }
    messages.push(assistantMessage)

    if (result.toolCalls.length === 0) {
      // 没有任何工具调用、也没有内容：多半是被 max_tokens 截断了。
      // 以前这里直接返回空字符串，界面上就像"模型什么都没干"，白烧一轮。
      if (!result.content || result.content.trim() === '') {
        const reason = result.finishReason || 'stop'
        throw new LlmError(
          `模型没有产出任何内容（finish_reason=${reason}，` +
          `角色 ${client.role} / 模型 ${client.model}）。` +
            (reason === 'length'
              ? '输出被 token 上限截断：把该角色的 maxTokens 调大（写整页 HTML 建议 ≥ 8192），或者改用非推理模型。'
              : '检查该角色的模型是否支持工具调用。'),
        )
      }
      finalText = result.content
      return { finalText, messages, usage, steps, toolCalls: records }
    }

    // 连续只读调用计数：防止模型把"勘察环境"当成主要工作
    for (const call of result.toolCalls) {
      if (options.signal?.aborted) throw abortError()
      hooks?.onToolStart?.({ name: call.function.name, args: call.function.arguments })
      const startedAt = Date.now()
      // 把取消信号交给工具：停止按钮按下后，正在跑的命令要能被掐断
      const toolRuntime = options.signal ? { ...runtime, signal: options.signal } : runtime
      const outcome: ToolResult = await toolbox.call(call.function.name, call.function.arguments, toolRuntime)
      // 工具是被取消打断的（或取消发生在它执行期间）：立刻收手，不进入下一轮
      if (options.signal?.aborted) throw abortError()
      const record: ToolCallRecord = {
        name: call.function.name,
        args: call.function.arguments,
        ok: outcome.ok,
        output: outcome.output,
        ms: Date.now() - startedAt,
      }
      records.push(record)
      hooks?.onToolEnd?.(record)
      if (WRITE_TOOLS.has(call.function.name)) {
        probeStreak = 0
      } else {
        probeStreak += 1
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: outcome.ok ? outcome.output : `ERROR: ${outcome.output}`,
      })
      if (probeStreak === PROBE_LIMIT) {
        messages.push({
          role: 'user',
          content:
            `已经连续 ${PROBE_LIMIT} 次只读调用，还没有改动任何文件。` +
            '不要再勘察环境：上面给过的信息（系统、shell、Node 版本、工作区、目录内容）不需要再确认。' +
            '现在直接产出交付物——该写文件就写文件，该改代码就改代码；写完再验证。',
        })
        hooks?.onNote?.('连续只读调用过多，已提醒它开始动手', 'warn')
      } else if (probeStreak === PROBE_LIMIT * 2) {
        messages.push({
          role: 'user',
          content:
            '第二次提醒：仍然没有产出任何文件改动。停止一切勘察，用现有信息写最小可用的交付物。' +
            '如果确实缺信息，就写一个说明文件把缺什么列出来，而不是继续试探。',
        })
        hooks?.onNote?.('第二次提醒：仍在勘察、没有产出', 'warn')
      }
    }
  }

  // Step budget exhausted: ask for a wrap-up instead of silently returning nothing.
  messages.push({
    role: 'user',
    content: '工具调用预算用完了。请停止调用工具，直接用文字总结你完成了什么、还剩什么、以及验证命令。',
  })
  const wrapUp = await client.chat({
    messages,
    signal: options.signal,
    onDelta: hooks?.onText,
    label: `${client.role}:wrapup`,
  })
  usage = addUsage(usage, wrapUp.usage)
  hooks?.onUsage?.(wrapUp.usage)
  hooks?.onTextEnd?.()
  messages.push({ role: 'assistant', content: wrapUp.content })
  finalText = wrapUp.content
  return { finalText, messages, usage, steps, toolCalls: records }
}

/** Renders a whole conversation as plain text, for feeding one role another's work. */
export function transcriptOf(messages: ChatMessage[], options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? 24_000
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      parts.push(`## 用户/上游输入\n${message.content ?? ''}`)
    } else if (message.role === 'assistant') {
      const text = message.content ?? ''
      const calls = message.tool_calls ?? []
      if (text) parts.push(`## 助手\n${text}`)
      if (calls.length > 0) {
        parts.push(`## 工具调用\n${calls.map((c) => `${c.function.name}(${c.function.arguments})`).join('\n')}`)
      }
    } else if (message.role === 'tool') {
      parts.push(`## 工具结果 (${message.name ?? ''})\n${message.content ?? ''}`)
    }
  }
  const joined = parts.join('\n\n')
  if (joined.length <= maxChars) return joined
  return `${joined.slice(0, maxChars / 2)}\n\n…[中间省略]…\n\n${joined.slice(-maxChars / 2)}`
}
