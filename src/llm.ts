import type { RoleConfig, RoleName } from './config.ts'
import { MockClient } from './mock.ts'

export interface Usage {
  prompt: number
  completion: number
  total: number
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
  /** Free-form label used in diagnostics. */
  label?: string
  /** 内部用：截断重试标记，避免无限重试。 */
  __truncationRetry?: boolean
  /** 运行提示（不走模型输出，用来告诉界面发生了什么）。 */
  onNote?(message: string, level?: 'info' | 'warn' | 'error'): void
}

export interface ChatResult {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  usage: Usage
  model: string
  finishReason: string
}

export interface LlmClient {
  readonly role: RoleName
  readonly model: string
  readonly mock: boolean
  chat(request: ChatRequest): Promise<ChatResult>
}

export class LlmError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

const EMPTY_USAGE: Usage = { prompt: 0, completion: 0, total: 0 }

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    total: a.total + b.total,
  }
}

/** Rough token estimate so mock/offline runs still show sane numbers. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.tool_call_id ?? 'unknown',
        content: message.content ?? '',
      }
    }
    if (message.role === 'assistant') {
      const out: Record<string, unknown> = {
        role: 'assistant',
        content: message.content ?? '',
      }
      if (message.tool_calls && message.tool_calls.length > 0) {
        out.tool_calls = message.tool_calls.map((call, index) => ({
          id: call.id || `call_${index}`,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments },
        }))
      }
      return out
    }
    return { role: message.role, content: message.content ?? '' }
  })
}

interface StreamState {
  content: string
  reasoning: string
  toolCalls: Map<number, { id: string; name: string; args: string }>
  usage: Usage
  finishReason: string
}

function textFromParts(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const rec = part as Record<string, unknown>
          if (typeof rec.text === 'string') return rec.text
          if (typeof rec.content === 'string') return rec.content
        }
        return ''
      })
      .join('')
  }
  return ''
}

function applyChunk(state: StreamState, chunk: Record<string, unknown>): void {
  const usage = chunk.usage as Record<string, unknown> | undefined
  if (usage) {
    const prompt = Number(usage.prompt_tokens ?? 0)
    const completion = Number(usage.completion_tokens ?? 0)
    state.usage = {
      prompt,
      completion,
      total: Number(usage.total_tokens ?? prompt + completion),
    }
  }
  const choices = chunk.choices
  if (!Array.isArray(choices) || choices.length === 0) return
  const choice = choices[0] as Record<string, unknown>
  if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
    state.finishReason = choice.finish_reason
  }
  const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>
  const text = textFromParts(delta.content)
  if (text) state.content += text
  const reasoning = textFromParts(delta.reasoning_content ?? delta.reasoning)
  if (reasoning) state.reasoning += reasoning
  const calls = delta.tool_calls
  if (Array.isArray(calls)) {
    for (const raw of calls) {
      const call = raw as Record<string, unknown>
      const index = Number(call.index ?? 0)
      const slot = state.toolCalls.get(index) ?? { id: '', name: '', args: '' }
      if (typeof call.id === 'string' && call.id) slot.id = call.id
      const fn = (call.function ?? {}) as Record<string, unknown>
      if (typeof fn.name === 'string' && fn.name) slot.name = fn.name
      if (typeof fn.arguments === 'string') slot.args += fn.arguments
      state.toolCalls.set(index, slot)
    }
  }
}

function ssePayloads(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let rest = buffer
  for (;;) {
    const match = rest.match(/\r?\n\r?\n/)
    if (!match || match.index === undefined) break
    const block = rest.slice(0, match.index)
    rest = rest.slice(match.index + match[0].length)
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) events.push(line.slice(5).trim())
    }
  }
  return { events, rest }
}

function explainHttpError(status: number, body: string, cfg: RoleConfig): string {
  const detail = body.slice(0, 600).replace(/\s+/g, ' ').trim()
  const base = `[${cfg.role}] HTTP ${status} ${cfg.baseUrl}/chat/completions (model=${cfg.model})`
  if (status === 401 || status === 403) {
    return `${base}: 鉴权失败。检查 roles.${cfg.role}.apiKey 或环境变量。${detail ? `\n响应: ${detail}` : ''}`
  }
  if (status === 404) {
    return `${base}: 端点或模型不存在。检查 baseUrl 是否以 /v1 结尾、model 名是否正确。${detail ? `\n响应: ${detail}` : ''}`
  }
  if (status === 429) {
    return `${base}: 被限流。稍后重试或降低并发。${detail ? `\n响应: ${detail}` : ''}`
  }
  return `${base}: ${detail || '请求失败'}`
}

function abortError(): Error {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly role: RoleName
  readonly model: string
  readonly mock = false
  private readonly config: RoleConfig

  constructor(config: RoleConfig) {
    this.config = config
    this.role = config.role
    this.model = config.model
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const attempts = Math.max(1, this.config.retries + 1)
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (request.signal?.aborted) throw abortError()
      try {
        return await this._once(request)
      } catch (error) {
        lastError = error
        const name = (error as Error).name
        if (name === 'AbortError') throw error
        const retryable =
          error instanceof LlmError
            ? error.status === 0 || error.status === 429 || error.status >= 500
            : true
        if (!retryable || attempt === attempts) throw error
        const wait = Math.min(8000, 700 * 2 ** (attempt - 1))
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private _once(request: ChatRequest): Promise<ChatResult> {
    const cfg = this.config
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: toWireMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: request.temperature ?? cfg.temperature,
      max_tokens: request.maxTokens ?? cfg.maxTokens,
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
      body.tool_choice = 'auto'
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...cfg.headers,
    }
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`

    const timeout = AbortSignal.timeout(cfg.timeoutMs)
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout

    return (async () => {
      const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new LlmError(explainHttpError(response.status, text, cfg), response.status)
      }
      const contentType = response.headers.get('content-type') ?? ''
      const state: StreamState = {
        content: '',
        reasoning: '',
        toolCalls: new Map(),
        usage: { ...EMPTY_USAGE },
        finishReason: '',
      }

      if (contentType.includes('application/json') || !response.body) {
        // Some gateways ignore stream:true. Handle both shapes.
        const json = (await response.json()) as Record<string, unknown>
        applyChunk(state, json)
      } else {
        let buffer = ''
        const decoder = new TextDecoder()
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true })
          const parsed = ssePayloads(buffer)
          buffer = parsed.rest
          for (const payload of parsed.events) {
            if (!payload) continue
            if (payload === '[DONE]') {
              buffer = ''
              break
            }
            let event: Record<string, unknown>
            try {
              event = JSON.parse(payload) as Record<string, unknown>
            } catch {
              continue
            }
            const before = state.content.length
            applyChunk(state, event)
            if (state.content.length > before && request.onDelta) {
              request.onDelta(state.content.slice(before))
            }
          }
        }
      }

      if (request.onDelta && state.content) {
        // Non-streaming path: emit the whole block once.
        if (state.content.length > 0 && !contentType.includes('text/event-stream')) {
          request.onDelta(state.content)
        }
      }
      // 输出被 max_tokens 截断时自动加预算重试一次：
      // 写大文件（比如一整页 HTML）很容易撞到上限，截断后工具调用参数会是半截 JSON，
      // 模型看起来就像"什么都没干"。
      if (state.finishReason === 'length' && !request.__truncationRetry) {
        const current = request.maxTokens ?? cfg.maxTokens
        const bigger = Math.min(65536, Math.max(current * 2, current + 4096))
        if (bigger > current) {
          request.onNote?.(`输出被截断（max_tokens=${current}），自动加大到 ${bigger} 重试一次`, 'warn')
          // 重试是一次全新的长请求：给心跳，别让界面看着像卡死
          const heartbeat = setInterval(() => {
            request.onNote?.(`正在用 ${bigger} token 重新生成…`, 'info')
          }, 8000)
          let retried
          try {
            retried = await this.chat({
            ...request,
            maxTokens: bigger,
            onDelta: undefined,
              __truncationRetry: true,
            } as ChatRequest & { __truncationRetry?: boolean })
          } finally {
            clearInterval(heartbeat)
          }
          return retried
        }
      }

      if (request.onReasoning && state.reasoning) request.onReasoning(state.reasoning)

      const toolCalls: ToolCall[] = [...state.toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, slot]) => ({
          id: slot.id || `call_${Date.now()}_${index}`,
          type: 'function' as const,
          function: { name: slot.name, arguments: slot.args || '{}' },
        }))
        .filter((call) => call.function.name.length > 0)

      const usage =
        state.usage.total > 0
          ? state.usage
          : {
              prompt: estimateTokens(request.messages.map((m) => m.content ?? '').join('\n')),
              completion: estimateTokens(state.content + state.reasoning),
              total: 0,
            }
      if (!usage.total) usage.total = usage.prompt + usage.completion

      return {
        content: state.content,
        reasoning: state.reasoning,
        toolCalls,
        usage,
        model: cfg.model,
        finishReason: state.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      }
    })()
  }
}

export function createClient(config: RoleConfig): LlmClient {
  if (config.mock) return new MockClient(config)
  return new OpenAiCompatibleClient(config)
}
