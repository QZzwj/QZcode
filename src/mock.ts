import type { RoleConfig, RoleName } from './config.ts'
import type { ChatRequest, ChatResult, LlmClient, ToolCall, Usage } from './llm.ts'

/** 可中断的等待：取消后立刻醒，别让"停止"还要等满 mock 的延时。 */
async function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  const abort = (): Error => {
    const error = new Error('已取消')
    error.name = 'AbortError'
    return error
  }
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return
  }
  if (signal.aborted) throw abort()
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
  if (signal.aborted) throw abort()
}

const delayMs = (): number => {
  const raw = process.env.QZCODE_MOCK_DELAY
  if (raw === undefined) return 6
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 6
}

function lastUserText(request: ChatRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i]
    if (message.role === 'user' && message.content) return message.content
  }
  return ''
}

/** Pulls just the goal out of the sectioned prompt the planner receives. */
function goalOnly(request: ChatRequest): string {
  // 用"第一条用户消息"里的目标：重写轮的最后一条 user 是纠正提示，不该当目标
  const first = request.messages.find((message) => message.role === 'user')
  const text = String(first?.content ?? lastUserText(request))
  const match = text.match(/##\s*用户目标\s*\n+([\s\S]*?)(?=\n##\s|$)/)
  const goal = (match?.[1] ?? text).trim()
  return goal.split(/\r?\n/)[0]?.slice(0, 120) ?? ''
}

/**
 * 修复轮里 A 会收到 C 的意见（形如 `1. [major] path: 问题 → 建议: …`）。
 * mock 把它们抠出来复述一遍，这样"回环"在演示里是看得见的。
 */
function issuesFrom(text: string): string[] {
  const section = text.match(/##\s*C 上一轮的核验意见[\s\S]*?(?=\n##\s|$)/)
  if (!section) return []
  const issues: string[] = []
  for (const line of section[0].split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\.\s*\[(blocker|major|minor)\]\s*(.+?)(?:\s*→\s*建议:.*)?$/)
    if (match) issues.push(`${match[2].trim()}（${match[1]}）`)
  }
  return issues
}

function estimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Deterministic backend used by `--mock`, the test suite and the demo.
 * It streams like the real thing (so the TUI can be exercised without keys)
 * and it deliberately fails the first verification round so the repair loop
 * gets exercised end to end.
 */
export class MockClient implements LlmClient {
  readonly role: RoleName
  readonly model: string
  readonly mock = true
  private calls = 0
  private reviews = 0
  private planCalls = 0

  constructor(config: RoleConfig) {
    this.role = config.role
    this.model = `${config.model}+mock`
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.calls += 1
    const reply = this._script(request)
    const chunkSize = 28
    const pause = delayMs()
    for (let i = 0; i < reply.text.length; i += chunkSize) {
      if (request.signal?.aborted) {
        const error = new Error('已取消')
        error.name = 'AbortError'
        throw error
      }
      const slice = reply.text.slice(i, i + chunkSize)
      request.onDelta?.(slice)
      if (pause > 0) await sleepUnlessAborted(pause, request.signal)
    }
    if (reply.reasoning) request.onReasoning?.(reply.reasoning)
    const usage: Usage = {
      prompt: estimate(request.messages.map((m) => m.content ?? '').join('\n')),
      completion: estimate(reply.text),
      total: 0,
    }
    usage.total = usage.prompt + usage.completion
    return {
      content: reply.text,
      reasoning: reply.reasoning ?? '',
      toolCalls: reply.toolCalls ?? [],
      usage,
      model: this.model,
      finishReason: reply.toolCalls ? 'tool_calls' : 'stop',
    }
  }

  /** L 的分流：默认把"要动手"的判 work，"为什么/是什么"判 direct。 */
  private _route(request: ChatRequest): string {
    const goal = goalOnly(request)
    const mode = process.env.QZCODE_MOCK_ROUTE ?? ''
    const question = /[？?]|为什么|是什么|怎么理解|区别|解释|含义|什么意思/.test(goal)
    const direct =
      mode === 'direct' || (mode !== 'work' && question && !/写|改|实现|生成|创建|修复/.test(goal))
    const payload = direct
      ? {
          route: 'direct',
          difficulty: 'trivial',
          why: '纯概念问答，不需要动文件',
          answer: `【mock leader】${goal}：这类问题不需要动仓库，直接回答即可。（mock 输出）`,
          hint: '',
        }
      : {
          route: 'work',
          difficulty: 'normal',
          why: '目标需要动手产出文件，交给 A 规划',
          answer: '',
          hint: '单文件任务，不需要额外构建',
        }
    return ['【mock leader】我判断一下这条请求要不要动流水线。', '', '```json', JSON.stringify(payload, null, 2), '```'].join('\n')
  }

  private _script(request: ChatRequest): {
    text: string
    reasoning?: string
    toolCalls?: ToolCall[]
  } {
    if (this.role === 'leader') return { text: this._route(request) }
    if (this.role === 'planner') {
      const text = lastUserText(request)
      // A 的复核请求和规划请求共用 planner 角色，靠这节标题区分
      if (text.includes('## 你上一轮给 B 的任务书')) return { text: this._review(text) }
      this.planCalls += 1
      // QZCODE_MOCK_PLAN=empty-first：第一次故意不给 JSON（复现"A 写歪"）
      // QZCODE_MOCK_PLAN=empty-always：一直不给（验证失败后明确报错）
      const mode = process.env.QZCODE_MOCK_PLAN ?? ''
      if (mode === 'empty-always' || (mode === 'empty-first' && this.planCalls === 1)) {
        return {
          text:
            '我先理解一下目标：这个任务需要动手做点东西，但我不打算给 JSON。' +
            '（mock：故意不输出任务书，用来验证 A 的重写与报错流程）',
        }
      }
      return { text: this._plan(goalOnly(request), issuesFrom(text)) }
    }
    if (this.role === 'implementer') return this._implement(request)
    return { text: this._verify(request) }
  }

  /** A 的复核：第一次挑出"没落实验收标准"，修正一次后放行。 */
  private _review(request: string): string {
    this.reviews += 1
    const corrected = /第 2 次修正|修正轮|## 跑偏点/.test(request) || this.reviews > 1
    const payload = corrected
      ? {
          ok: true,
          summary: '修正后已经对齐任务书，可以进核验',
          drift: [],
          brief: '',
          acceptance: [],
        }
      : {
          ok: false,
          summary: 'B 只落了策略，没把验收标准点名的"可复现检查"做出来，属于跑偏',
          drift: [
            '验收标准第 2 条（可复现的检查命令）没有落地：汇报里没有命令与输出',
            'notes/plan.md 缺"验证方式"小节',
          ],
          brief:
            '只在 notes/plan.md 里补一节「验证方式」：写清要执行的具体命令（例如 node --test）以及预期输出；不要重写其它章节。',
          acceptance: ['notes/plan.md 里包含"验证方式"小节，且有可直接执行的命令'],
        }
    return [
      corrected ? '【mock reviewer】B 这次的修正已经对齐任务书：' : '【mock reviewer】B 的实现偏离了任务书：',
      ...(corrected ? [] : payload.drift.map((item, index) => `- ${index + 1}. ${item}`)),
      '',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
      corrected ? '' : '修正词已经给出，退回 B 只补这一处。',
    ]
      .filter((line) => line !== '')
      .join('\n')
  }

  private _plan(goal: string, issues: string[]): string {
    const subject = goal.replace(/\s+/g, ' ').slice(0, 120) || '未指定目标'
    const round2 = issues.length > 0
    const plan = {
      prompt: round2
        ? `上一轮 C 判为不通过，这轮只补它点名的缺口：${issues.length} 条。` +
          `具体是：${issues.map((issue, index) => `(${index + 1}) ${issue}`).join('；')}。` +
          `其余已完成部分不要重写，改完把验证命令和真实输出贴出来。`
        : `在仓库中完成「${subject}」。工作方式：先读相关文件确认现状，再最小改动实现，` +
          `最后运行可用的检查命令并把结果贴出来。不要改动与本任务无关的文件。`,
      guidance: round2
        ? ['不要重写上一轮已经通过的部分，只补缺口。', '补完立刻跑一次检查，把命令与输出原样贴出来。']
        : [
            '先探测仓库结构（ls / find），不要一上来就写代码。',
            '改动要能通过 `node --test` 或项目自带脚本；没有测试就补一个最小可运行的。',
            '每完成一步就把结论写进最终回复，方便核验方复现。',
          ],
      acceptance: round2
        ? [...issues.map((issue) => `补上：${issue}`), '结果里带真实的命令输出，不是"应该可以"']
        : [
            '目标里点名的行为真的能被触发，而不是只写了文档。',
            '存在至少一条可复现的检查命令，且输出与预期一致。',
            '没有留下未使用的临时文件或调试输出。',
          ],
      steps: round2 ? ['按 C 的意见逐条补', '重跑检查', '贴出输出'] : ['勘察现状', '最小实现', '补检查', '自测并汇报'],
      risks: round2 ? ['只补表面文档、不补实际检查'] : ['仓库里可能已有同名抽象，直接新增会重复造轮子'],
    }
    return [
      round2
        ? `【mock planner】收到 C 上一轮的 ${issues.length} 条意见，逐条改进任务书：`
        : '【mock planner】我把目标拆成了给 B 的提示词与验收标准：',
      ...(round2 ? issues.map((issue, index) => `${index + 1}. ${issue}`) : []),
      '',
      '```json',
      JSON.stringify(plan, null, 2),
      '```',
      '',
      round2
        ? '要点：这轮只补 C 点名的缺口，B 必须贴真实命令输出，否则 C 还会判不通过。'
        : '要点：B 先勘察再动手，C 只做只读核验并实际跑一次检查命令。',
    ].join('\n')
  }

  private _implement(request: ChatRequest): { text: string; toolCalls?: ToolCall[] } {
    const hasToolResult = request.messages.some((message) => message.role === 'tool')
    const goal = goalOnly(request) || '任务'
    if (!hasToolResult) {
      const content = [
        `# mock 实现记录`,
        '',
        `- 目标摘要：${goal}`,
        `- 策略：先勘察，再最小改动。`,
        `- 本次为演示运行（--mock），未调用真实模型。`,
        '',
      ].join('\n')
      const toolCalls: ToolCall[] = [
        {
          id: `call_mock_write_${Date.now()}`,
          type: 'function',
          function: {
            name: 'write',
            arguments: JSON.stringify({ path: 'notes/plan.md', content }),
          },
        },
      ]
      return {
        text: '我先勘察一下工作区，把计划落到 notes/plan.md。\n',
        toolCalls,
      }
    }
    return {
      text: [
        '实现完成（mock）：',
        '',
        '1. 写入了 `notes/plan.md`，记录目标与策略。',
        '2. 复现命令：`node --version`（mock 只做一次无害检查）。',
        '',
        '给 C 的复现步骤：读 `notes/plan.md`，确认内容与目标一致。',
      ].join('\n'),
    }
  }

  private _verify(request: ChatRequest): string {
    const firstRound = this.calls <= 1
    const verdict = firstRound
      ? {
          pass: false,
          summary: '实现方向对，但还差一条可复现的验收证据。',
          issues: [
            {
              severity: 'major',
              where: 'notes/plan.md',
              problem: '文件只写了策略，没有写出实际执行的检查命令与输出。',
              fix: '补一节「验证」：命令 + 预期输出 + 实际输出。',
            },
          ],
          evidence: ['notes/plan.md 存在', '未发现测试或检查记录'],
        }
      : {
          pass: true,
          summary: '补上了验证记录，验收标准逐条满足。',
          issues: [],
          evidence: ['notes/plan.md 含验证小节', '复现步骤清晰'],
        }
    return [
      '【mock verifier】核验结果：',
      '',
      '```json',
      JSON.stringify(verdict, null, 2),
      '```',
    ].join('\n')
  }
}
