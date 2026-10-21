import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { AgentHooks, AgentRunResult } from './agent.ts'
import { runAgent } from './agent.ts'
import type { AppConfig, RoleName } from './config.ts'
import type { ChatMessage, LlmClient, Usage } from './llm.ts'
import type { ToolRuntime, Toolbox } from './tools.ts'
import { addUsage } from './llm.ts'
import { browserAvailability } from './browser.ts'
import { resolveShell } from './tools.ts'
import { listSkills, renderSkills, skillsForRole, type Skill } from './skills.ts'

export interface Plan {
  prompt: string
  guidance: string[]
  acceptance: string[]
  steps: string[]
  risks: string[]
  /** Human-readable preamble the planner wrote before the JSON block. */
  preamble: string
  raw: string
  parsed: boolean
  /** prompt 是否来自 JSON 的 prompt 字段（false = 用了散文兜底）。 */
  promptExplicit?: boolean
}

export interface Issue {
  severity: 'blocker' | 'major' | 'minor'
  where: string
  problem: string
  fix: string
}

export interface Verdict {
  pass: boolean
  summary: string
  issues: Issue[]
  evidence: string[]
  raw: string
  parsed: boolean
}

export interface Review {
  /** 与任务书/验收标准对齐 = true；跑偏 = false（此时会退回 B 修正）。 */
  ok: boolean
  summary: string
  /** 具体跑偏点（文件/行为级）。 */
  drift: string[]
  /** 给 B 的修正词；ok 时为空。 */
  brief: string
  /** 继续有效的验收标准（A 可以在原基础上补充）。 */
  acceptance: string[]
  raw: string
  parsed: boolean
}

export interface RoleContext {
  client: LlmClient
  toolbox: Toolbox
  toolRuntime: ToolRuntime
  config: AppConfig
  signal?: AbortSignal
}

const promptCache = new Map<string, string>()

/** 读 `src/prompts/<name>.md`（name 可以是 planner / planner-review / …）。 */
export function promptText(name: string): string {
  const cached = promptCache.get(name)
  if (cached) return cached
  const url = new URL(`./prompts/${name}.md`, import.meta.url)
  const text = readFileSync(url, 'utf8').trim()
  promptCache.set(name, text)
  return text
}

export function rolePrompt(role: RoleName): string {
  return promptText(role)
}

/** 运行环境说明：告诉模型本机的 shell 和路径风格，避免它写不兼容的命令。 */
/** 浏览器可用性：写进环境说明，省得模型拿"环境没浏览器"当免责理由。 */
function browserNote(): string {
  const found = browserAvailability()
  if (!found.ok) {
    return '### 浏览器\n- 这台机器上没找到 Chromium。需要验证网页时如实说明，别假装跑过'
  }
  return [
    '### 浏览器（可用来真验证网页/游戏）',
    `- 可用：${found.path}（${found.source}）`,
    '- 用 browser 工具：open 打开页面 → eval 断言 DOM → click/hold/touch 模拟操作 → viewport 查响应式 → screenshot 截图',
    '- 有网页/小游戏要验证时就用它，不要写「环境无浏览器，未实测」',
  ].join('\n')
}

export function environmentBrief(shellFile?: string, workspace?: string): string {
  const platform = process.platform
  const name = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'
  let file = shellFile
  if (!file) {
    try {
      file = resolveShell().file
    } catch {
      file = platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    }
  }
  const isBash = /bash/i.test(file)
  const shellName = isBash
    ? 'bash（Git Bash）'
    : /pwsh|powershell/i.test(file)
      ? 'Windows PowerShell'
      : /cmd/i.test(file)
        ? 'cmd.exe'
        : file
  return [
    '## 运行环境（写命令前先看这段）',
    `- 操作系统：${name}`,
    `- bash 工具实际用的 shell：${shellName}（${file}）`,
    isBash
      ? '- 命令用 POSIX/bash 语法：ls -la、rm -rf、grep、sed、mkdir -p、&&、2>/dev/null 都可以'
      : '- 这个 shell 不是 bash：不要写 ls -la、rm -rf、2>/dev/null 这类 POSIX 命令',
    platform === 'win32'
      ? '- 路径是 Windows 风格（反斜杠），工作目录形如 C:\\path\\to\\dir'
      : '- 路径是 POSIX 风格（斜杠）',
    workspace ? `- 工作区（bash 的当前目录）：${workspace}` : '',
    `- Node 版本：${process.version}`,
    '',
    '### 这些事实上面已经给了，不要再跑命令确认',
    '- 操作系统、shell 是什么、路径风格、工作区在哪、Node 版本',
    '- 目录里有什么：用 ls 工具，不要用 bash 的 ls/find 来"勘察"',
    '- 装没装 Chrome / Playwright / Python / 某个 npm 包：**除非任务书明确要求用它们**，否则不要探测',
    '',
    browserNote(),
    '### 动手顺序',
    '第一轮就该产出交付物：先写文件，再验证。',
    '允许的勘察上限：**最多 2 次只读调用**（read/ls/grep），之后必须开始写。',
    '如果确实需要更多背景，就在答复里说明缺什么，而不是一条条试命令。',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 技能缓存：同一个进程里不必每次读盘。 */
let skillCache: { dir: string | null; at: number; skills: Skill[] } | null = null

/** 这个角色当前启用的技能（内置 + 用户导入，按 front matter 的 roles 过滤）。 */
export function activeSkills(role: RoleName, config: AppConfig): Skill[] {
  if (!config.skills.enabled) return []
  const dir = config.skills.dir
  const now = Date.now()
  if (!skillCache || skillCache.dir !== dir || now - skillCache.at > 5000) {
    skillCache = { dir, at: now, skills: listSkills(dir) }
  }
  const disabled = new Set(config.skills.disabled)
  const available = skillCache.skills.filter((skill) => !disabled.has(skill.name))
  return skillsForRole(role, available, config.roles[role]?.skills)
}

export function systemFor(role: RoleName, config: AppConfig, shellFile?: string): string {
  const base = rolePrompt(role)
  const extra = config.roles[role]?.systemAppend?.trim()
  const skills = renderSkills(activeSkills(role, config))
  // 环境说明放在最前面：模型最容易在这里写错命令
  return [
    base,
    environmentBrief(shellFile, config.workspace || config.root),
    skills,
    extra ? `## 本项目追加要求\n\n${extra}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ------------------------------------------------------------------ json utils

/** Finds the first balanced JSON object, tolerating prose and ``` fences. */
export function extractJson(text: string): unknown | null {
  const fences = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)]
  const candidates: string[] = fences.map((match) => match[1]).reverse()
  candidates.push(text)

  for (const candidate of candidates) {
    const direct = candidate.trim()
    if (direct.startsWith('{') || direct.startsWith('[')) {
      try {
        return JSON.parse(direct)
      } catch {
        // fall through to brace scanning
      }
    }
    const scanned = scanBalanced(candidate)
    if (scanned) {
      try {
        return JSON.parse(scanned)
      } catch {
        // try next candidate
      }
    }
  }
  return null
}

function scanBalanced(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      if (item && typeof item === 'object') return JSON.stringify(item)
      return String(item ?? '')
    })
    .filter((item) => item.length > 0)
}

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** A 的任务书到底能不能用：给出具体缺什么，空字符串表示合格。 */
export function describePlanProblem(plan: Plan): string {
  const problems: string[] = []
  const prompt = plan.prompt.trim()
  if (prompt.length < 20) problems.push('任务书 prompt 为空或过短（B 拿不到可执行的任务）')
  if (plan.promptExplicit === false) problems.push('没有给出 prompt 字段（不能拿散文或原始 JSON 当任务书）')
  if (plan.acceptance.length === 0) problems.push('验收标准 acceptance 为空（C 没有判定依据）')
  if (!plan.parsed && plan.acceptance.length === 0) problems.push('没有按要求的 ```json 代码块输出')
  return problems.join('；')
}

/** 让 A 把缺的部分补上：说清楚缺什么，并重申 JSON 形状。 */
export function planRetryNudge(plan: Plan, problem: string): string {
  const lines = [
    '你上一次的输出不能用，原因是：' + problem + '。',
    '',
    '请重新输出，并且严格满足：',
    '1. 先写不超过 8 行的人话摘要；',
    '2. 然后给一个 ```json 代码块，必须包含非空的 "prompt"（给 B 的自包含任务书，≥ 100 字）',
    '   与 3–6 条 "acceptance"（每条都能用命令或文件内容验证）；',
    '3. 不要在 JSON 之外再写第二个 JSON，不要用注释、不要用尾逗号。',
  ]
  if (!plan.parsed) lines.push('', '你上一次的输出里没有找到 ```json 代码块。')
  return lines.join('\n')
}

export function parsePlan(text: string): Plan {
  const json = extractJson(text)
  const before = text.split(/```/)[0]?.trim() ?? ''
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    // Degrade gracefully: a planner that only wrote prose still gives B something.
    return {
      prompt: text.trim(),
      promptExplicit: false,
      guidance: [],
      acceptance: [],
      steps: [],
      risks: [],
      preamble: before,
      raw: text,
      parsed: false,
    }
  }
  const record = json as Record<string, unknown>
  return {
    prompt: firstString(record, ['prompt', 'brief', 'task', 'instructions']) || text.trim(),
    promptExplicit: Boolean(firstString(record, ['prompt', 'brief', 'task', 'instructions'])),
    guidance: asStringArray(record.guidance ?? record.notes),
    acceptance: asStringArray(record.acceptance ?? record.criteria ?? record.acceptance_criteria),
    steps: asStringArray(record.steps ?? record.plan),
    risks: asStringArray(record.risks),
    preamble: before,
    raw: text,
    parsed: true,
  }
}

export function parseVerdict(text: string): Verdict {
  const json = extractJson(text)
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    const looksPassed = /(^|\W)(PASS|通过|passed)(\W|$)/i.test(text) && !/不通过|未通过|fail/i.test(text)
    return {
      pass: looksPassed,
      summary: looksPassed ? '核验输出未按 JSON 格式给出，但文本判定为通过' : '核验输出无法解析为 JSON',
      issues: looksPassed
        ? []
        : [
            {
              severity: 'major',
              where: 'verifier output',
              problem: '核验模型没有返回约定的 JSON，无法逐条确认验收标准。',
              fix: '重新核验并只输出约定字段：pass / summary / issues / evidence。',
            },
          ],
      evidence: [],
      raw: text,
      parsed: false,
    }
  }
  const record = json as Record<string, unknown>
  const rawPass = record.pass ?? record.passed ?? record.ok ?? record.verdict
  const pass = typeof rawPass === 'boolean' ? rawPass : /^(pass|passed|ok|true)$/i.test(String(rawPass ?? ''))
  const issuesRaw = Array.isArray(record.issues) ? record.issues : []
  const issues: Issue[] = issuesRaw.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>
    const severityRaw = String(entry.severity ?? 'major').toLowerCase()
    const severity: Issue['severity'] =
      severityRaw === 'blocker' || severityRaw === 'critical'
        ? 'blocker'
        : severityRaw === 'minor' || severityRaw === 'nit'
          ? 'minor'
          : 'major'
    return {
      severity,
      where: firstString(entry, ['where', 'file', 'location', 'path']) || 'unspecified',
      problem: firstString(entry, ['problem', 'issue', 'description', 'message']) || '(未描述)',
      fix: firstString(entry, ['fix', 'suggestion', 'action', 'next']) || '',
    }
  })
  const summary = firstString(record, ['summary', 'conclusion', 'verdict_text']) || (pass ? '通过' : '未通过')
  return {
    pass: issues.some((issue) => issue.severity === 'blocker') ? false : pass,
    summary,
    issues,
    evidence: asStringArray(record.evidence ?? record.proof),
    raw: text,
    parsed: true,
  }
}

// ------------------------------------------------------------- A 复核（跑偏检查）

/** A 复核时能用的工具：只读，不跑命令（跑命令是 C 的活）。 */
export const REVIEWER_TOOLS = ['read', 'grep', 'find', 'ls']

export function parseReview(text: string): Review {
  const json = extractJson(text)
  const parsed = Boolean(json && typeof json === 'object' && !Array.isArray(json))
  if (!parsed) {
    // 解析不出来就不要卡住流水线：当作"对齐"，把原文留作 summary 供人判断
    return {
      ok: true,
      summary: text.trim().slice(0, 400) || '复核输出无法解析，已放行',
      drift: [],
      brief: '',
      acceptance: [],
      raw: text,
      parsed: false,
    }
  }
  const record = json as Record<string, unknown>
  const rawOk = record.ok ?? record.aligned ?? record.pass
  const ok = typeof rawOk === 'boolean' ? rawOk : /^(true|ok|pass|aligned|yes)$/i.test(String(rawOk ?? '').trim())
  const brief = firstString(record, ['brief', 'correction', 'fixPrompt', 'instruction']).trim()
  const drift = asStringArray(record.drift ?? record.problems ?? record.issues)
  return {
    // 有修正词就等于没对齐，避免模型自相矛盾时放行
    ok: ok && brief.length === 0,
    summary: firstString(record, ['summary', 'conclusion']) || (ok ? '与任务书对齐' : '偏离任务书'),
    drift,
    brief,
    acceptance: asStringArray(record.acceptance),
    raw: text,
    parsed: true,
  }
}

export interface ReviewStepInput {
  goal: string
  plan: Plan
  round: number
  attempt: number
  implementerReport: string
  implementerMessages: ChatMessage[]
}

/** A 拿任务书对 B 的产出做一次"有没有跑偏"的复核。 */
export async function reviewStep(
  context: RoleContext,
  input: ReviewStepInput,
  hooks: AgentHooks = {},
): Promise<{ review: Review; usage: Usage }> {
  const sections: string[] = []
  sections.push(`## 原始目标\n\n${input.goal}`)
  sections.push(`## 你上一轮给 B 的任务书\n\n${input.plan.prompt || '(空)'}`)
  sections.push(
    `## 验收标准（判断"跑偏"的唯一尺子）\n\n${
      input.plan.acceptance.map((item) => `- ${item}`).join('\n') || '(任务书没给验收标准，按目标本身判断)'
    }`,
  )
  sections.push(`## B 的汇报（第 ${input.round} 轮${input.attempt > 1 ? ` · 第 ${input.attempt} 次修正` : ''}）\n\n${
    input.implementerReport || '(B 没有输出汇报)'
  }`)
  const toolTrail = input.implementerMessages
    .filter((message) => message.role === 'tool')
    .map((message) => `${message.name}: ${(message.content ?? '').slice(0, 400)}`)
    .join('\n---\n')
  if (toolTrail) sections.push(`## B 的工具调用记录\n\n${toolTrail}`)
  sections.push(
    '## 要求\n\n你可以用 read / grep / find / ls 自己核对（不要跑命令、不要改文件）。' +
      '判断 B 有没有偏离任务书与验收标准；跑偏就给可执行的修正词。' +
      '最后只输出：简短理由 + 一个 ```json 代码块（ok / summary / drift / brief / acceptance）。',
  )

  const system = systemForReview(context.config)
  const result = await runAgent({
    client: context.client,
    system,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: sections.join('\n\n') },
    ],
    toolbox: context.toolbox,
    runtime: context.toolRuntime,
    maxSteps: Math.max(6, Math.trunc(context.config.maxSteps / 3)),
    signal: context.signal,
    hooks,
    toolFilter: { names: REVIEWER_TOOLS },
  })
  return { review: parseReview(result.finalText), usage: result.usage }
}

function systemForReview(config: AppConfig): string {
  const base = promptText('planner-review')
  const extra = config.roles.planner?.systemAppend?.trim()
  const skills = renderSkills(activeSkills('planner', config))
  return [base, environmentBrief(), skills, extra ? `## 本项目追加要求\n\n${extra}` : '']
    .filter(Boolean)
    .join('\n\n')
}

/** 把 A 的复核结论拼成给 B 的「修正轮」指令。 */
export function correctionBrief(review: Review, plan: Plan, round: number, attempt: number): string {
  const blocks: string[] = []
  blocks.push(`## A 的复核：需要修正（第 ${round} 轮 · 第 ${attempt} 次）\n\n${review.summary}`)
  if (review.drift.length > 0) {
    blocks.push(`## 跑偏点\n\n${review.drift.map((item, index) => `${index + 1}. ${item}`).join('\n')}`)
  }
  blocks.push(`## 修正词（只做这些）\n\n${review.brief || '(A 没给具体修正词，按上面的跑偏点最小改动)'}`)
  const acceptance = review.acceptance.length > 0 ? review.acceptance : plan.acceptance
  if (acceptance.length > 0) {
    blocks.push(`## 验收标准（继续有效）\n\n${acceptance.map((item) => `- ${item}`).join('\n')}`)
  }
  blocks.push('不要重写已经对齐的部分；改完重新跑检查，并把命令与真实输出贴进汇报。')
  return blocks.join('\n\n')
}

// ------------------------------------------------------------- workspace view

export function workspaceSummary(workspace: string, limit = 120): string {
  const lines: string[] = []
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv'])
  const walk = (dir: string, depth: number) => {
    if (lines.length >= limit || depth > 3) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (lines.length >= limit) return
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      const full = join(dir, entry.name)
      const rel = relative(workspace, full)
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        lines.push(`${rel}/`)
        walk(full, depth + 1)
      } else {
        let size = 0
        try {
          size = statSync(full).size
        } catch {
          size = 0
        }
        lines.push(`${rel} (${size}B)`)
      }
    }
  }
  walk(workspace, 1)
  if (lines.length === 0) return '(工作区为空)'
  const suffix = lines.length >= limit ? `\n…（快照已截断，共列出 ${lines.length} 项）` : ''
  return lines.join('\n') + suffix
}

// ----------------------------------------------------------------- L · 调度

/** L 的分流结论。`direct` 时代答即交付，不走 A/B/C。 */
export interface RouteDecision {
  route: 'direct' | 'work'
  difficulty: 'trivial' | 'normal' | 'hard'
  why: string
  /** 只有 direct 才有内容：直接交付给用户的回答。 */
  answer: string
  /** work 时给 A 的一句话提示。 */
  hint: string
  raw: string
  parsed: boolean
  /** 是不是靠关键词预筛直接判定的（没花 token）。 */
  prefiltered: boolean
}

/**
 * 零成本预筛：目标里出现动作词/技术词就直接判 work，不调模型。
 * 这一层保证了"命中率"——真正的存在性任务绝不会被 L 判成闲聊。
 */
export function prefilterWork(goal: string, keywords: string[]): boolean {
  const text = goal.toLowerCase()
  if (text.length > 400) return true
  if (/[\/\\][\w.-]+\.[a-z]{1,6}\b/i.test(goal)) return true // 带路径/文件名
  if (/```/.test(goal)) return true // 贴了代码
  if (/(error|exception|traceback|报错|崩溃|失败)/i.test(goal)) return true
  return keywords.some((word) => word && text.includes(word.toLowerCase()))
}

/** 解析 L 的输出；解析不出来一律当 work（宁可多花钱，也不吞任务）。 */
export function parseRoute(text: string): RouteDecision {
  const json = extractJson(text)
  const fallback = (): RouteDecision => ({
    route: 'work',
    difficulty: 'normal',
    why: '没有解析到可用的分流结论，按保守策略走完整流水线',
    answer: '',
    hint: '',
    raw: text,
    parsed: false,
    prefiltered: false,
  })
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fallback()
  const record = json as Record<string, unknown>
  const route = String(record.route ?? '').toLowerCase()
  const answer = typeof record.answer === 'string' ? record.answer.trim() : ''
  const difficultyRaw = String(record.difficulty ?? '').toLowerCase()
  const difficulty = (['trivial', 'normal', 'hard'].includes(difficultyRaw) ? difficultyRaw : 'normal') as
    | 'trivial'
    | 'normal'
    | 'hard'
  const decision: RouteDecision = {
    route: route === 'direct' ? 'direct' : 'work',
    difficulty,
    why: typeof record.why === 'string' ? record.why.trim() : '',
    answer,
    hint: typeof record.hint === 'string' ? record.hint.trim() : '',
    raw: text,
    parsed: true,
    prefiltered: false,
  }
  // 说 direct 却没给答案（或答案短得没用）→ 按 work 处理，别让用户拿到空气
  if (decision.route === 'direct' && decision.answer.length < 8) {
    decision.route = 'work'
    decision.why = `${decision.why}（但 L 没给出可用答案，改走流水线）`
  }
  return decision
}

/** 调度步骤：先关键词预筛，再让 L 判断。预筛命中时不调模型，直接 work。 */
export async function leaderStep(
  context: RoleContext,
  input: { goal: string; round: number },
  hooks: AgentHooks = {},
): Promise<{ decision: RouteDecision; usage: Usage; text: string }> {
  const leader = context.config.leader

  if (prefilterWork(input.goal, leader.workKeywords)) {
    const decision: RouteDecision = {
      route: 'work',
      difficulty: 'normal',
      why: '目标里包含动作词 / 文件名 / 代码 / 报错，直接进流水线',
      answer: '',
      hint: '',
      raw: '',
      parsed: true,
      prefiltered: true,
    }
    hooks.onNote?.('L 预筛：这是要动手改东西的任务，跳过直接回答', 'info')
    return { decision, usage: { prompt: 0, completion: 0, total: 0 }, text: '' }
  }

  const sections = [
    `## 用户目标\n\n${input.goal}`,
    `## 工作区快照\n\n\`\`\`\n${workspaceSummary(context.toolRuntime.workspace)}\n\`\`\``,
    '现在按系统提示判断：这条请求要动流水线（work），还是你直接答完（direct）？',
  ]
  const messages: ChatMessage[] = [
    { role: 'system', content: systemFor('leader', context.config) },
    { role: 'user', content: sections.join('\n\n') },
  ]
  const result = await context.client.chat({
    messages,
    signal: context.signal,
    onDelta: hooks.onText,
    onReasoning: hooks.onReasoning,
    label: 'leader',
    maxTokens: leader.directMaxTokens,
  })
  hooks.onTextEnd?.()
  const decision = parseRoute(result.content)
  if (!decision.parsed) hooks.onNote?.('L 的输出没能解析成分流 JSON，保守走完整流水线', 'warn')
  return { decision, usage: result.usage, text: result.content }
}

// --------------------------------------------------------------- the 3 turns

export interface PlanStepInput {
  goal: string
  round: number
  /** L 分流时给的一句话提示。 */
  leaderHint?: string
  workspace: string
  previousIssues?: Issue[]
  previousSummary?: string
  /** 用户用 @文件 指定的参考文件（原文）。 */
  reference?: string
  /** 上一轮留下的上下文：目标、结论、改动清单（跟着 goal 一起给 A）。 */
  previousContext?: string
}

/** A 的任务书最多写几次：第一次不合格就带着"缺什么"再要一次。 */
const PLAN_ATTEMPTS = 2

export async function planStep(
  context: RoleContext,
  input: PlanStepInput,
  hooks: AgentHooks = {},
): Promise<{ plan: Plan; usage: Usage; text: string; attempts: number }> {
  const sections: string[] = [`## 用户目标\n\n${input.goal}`]
  sections.push(`## 工作区快照\n\n\`\`\`\n${workspaceSummary(input.workspace)}\n\`\`\``)
  sections.push(`## 轮次\n\n第 ${input.round} 轮（总预算见系统配置）。`)
  if (input.previousIssues && input.previousIssues.length > 0) {
    const list = input.previousIssues
      .map(
        (issue, index) =>
          `${index + 1}. [${issue.severity}] ${issue.where}: ${issue.problem} → 建议: ${issue.fix || '未给出'}`,
      )
      .join('\n')
    sections.push(
      `## C 上一轮的核验意见（必须逐条回应）\n\n${list}\n\n上一轮结论：${input.previousSummary ?? '(无)'}`,
    )
  }
  if (input.leaderHint?.trim()) {
    sections.push(`## L 的提示（调度模型的判断，仅供参考）\n\n${input.leaderHint.trim()}`)
  }
  if (input.previousContext?.trim()) {
    // 上一轮干过什么：让"把它改成深色"这种话不用重新交代背景
    sections.push(`## 上一轮的情况（不是本轮目标，只作背景）\n\n${input.previousContext.trim()}`)
  }
  if (input.reference?.trim()) {
    // 用户用 @文件 指过来的原文
    sections.push(input.reference.trim())
  }
  sections.push('现在按系统提示要求，先给摘要，再给唯一的 ```json 代码块。')

  const message: ChatMessage = { role: 'user', content: sections.join('\n\n') }
  const messages: ChatMessage[] = [{ role: 'system', content: systemFor('planner', context.config) }, message]

  let usage: Usage = { prompt: 0, completion: 0, total: 0 }
  let lastText = ''
  let lastProblem = ''

  for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
    const result = await context.client.chat({
      messages,
      signal: context.signal,
      onDelta: hooks.onText,
      onReasoning: hooks.onReasoning,
      label: 'planner',
    })
    hooks.onTextEnd?.()
    usage = addUsage(usage, result.usage)
    lastText = result.content

    const plan = parsePlan(result.content)
    const problem = describePlanProblem(plan)
    if (!problem) return { plan, usage, text: result.content, attempts: attempt }

    lastProblem = problem
    if (attempt === PLAN_ATTEMPTS) break
    hooks.onNote?.(`A 第 ${attempt} 次没给出可用任务书（${problem}），已带着具体要求重写一次`, 'warn')
    messages.push({ role: 'assistant', content: result.content })
    messages.push({ role: 'user', content: planRetryNudge(plan, problem) })
  }

  // 两次都不合格：直接报错，别让 B 拿着空任务书白跑一轮
  throw new Error(
    `A 没有给出可用的任务书（试了 ${PLAN_ATTEMPTS} 次）：${lastProblem}。` +
      `建议给 A 换更强的模型（roles.planner.model），或检查它的 systemAppend。` +
      `最后输出片段：${lastText.trim().slice(0, 300) || '(空)'}`,
  )
}

export function implementerBrief(plan: Plan, goal: string, round: number): string {
  const blocks: string[] = []
  blocks.push(`## 任务（来自 A · 规划模型，第 ${round} 轮）\n\n${plan.prompt}`)
  if (plan.guidance.length > 0) {
    blocks.push(`## 指导\n\n${plan.guidance.map((item, i) => `${i + 1}. ${item}`).join('\n')}`)
  }
  if (plan.acceptance.length > 0) {
    blocks.push(`## 验收标准（C 会逐条检查）\n\n${plan.acceptance.map((item) => `- ${item}`).join('\n')}`)
  }
  if (plan.steps.length > 0) {
    blocks.push(`## 建议步骤\n\n${plan.steps.map((item, i) => `${i + 1}. ${item}`).join('\n')}`)
  }
  if (plan.risks.length > 0) {
    blocks.push(`## 风险提示\n\n${plan.risks.map((item) => `- ${item}`).join('\n')}`)
  }
  blocks.push(`## 原始目标（供你判断边界）\n\n${goal}`)
  blocks.push('现在开始：先勘察工作区，再动手，最后给出结构化汇报。')
  return blocks.join('\n\n')
}

export async function implementStep(
  context: RoleContext,
  input: { plan: Plan; goal: string; round: number; messages: ChatMessage[] },
  hooks: AgentHooks = {},
): Promise<AgentRunResult> {
  const messages = input.messages
  if (messages.length === 0) {
    messages.push({ role: 'user', content: implementerBrief(input.plan, input.goal, input.round) })
  } else {
    messages.push({
      role: 'user',
      content: `## 修复轮（第 ${input.round} 轮）\n\nA 更新了任务书：\n\n${input.plan.prompt}\n\n${
        input.plan.acceptance.length > 0
          ? `验收标准：\n${input.plan.acceptance.map((i) => `- ${i}`).join('\n')}\n\n`
          : ''
      }只改必要的部分，改完重新跑检查并汇报。`,
    })
  }
  return await runAgent({
    client: context.client,
    system: systemFor('implementer', context.config),
    messages,
    toolbox: context.toolbox,
    runtime: context.toolRuntime,
    maxSteps: context.config.roles.implementer.maxSteps || context.config.maxSteps,
    signal: context.signal,
    hooks,
  })
}

/** Read-only tools plus `bash`: the verifier may look and run checks, never write. */
export const VERIFIER_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'browser']

export async function verifyStep(
  context: RoleContext,
  input: {
    plan: Plan
    goal: string
    round: number
    implementerReport: string
    implementerMessages: ChatMessage[]
  },
  hooks: AgentHooks = {},
): Promise<{ verdict: Verdict; usage: Usage }> {
  const sections: string[] = []
  sections.push(`## 原始目标\n\n${input.goal}`)
  sections.push(
    `## A 的验收标准（你的唯一尺子）\n\n${
      input.plan.acceptance.map((item) => `- ${item}`).join('\n') || '(A 没有给出验收标准，请把这一点记为 major)'
    }`,
  )
  if (input.plan.prompt) sections.push(`## A 给 B 的任务书\n\n${input.plan.prompt}`)
  sections.push(`## B 的汇报\n\n${input.implementerReport || '(B 没有输出汇报)'}`)
  const toolTrail = input.implementerMessages
    .filter((message) => message.role === 'tool')
    .map((message) => `${message.name}: ${(message.content ?? '').slice(0, 400)}`)
    .join('\n---\n')
  if (toolTrail) {
    sections.push(`## B 的工具调用记录（供你交叉验证汇报是否属实）\n\n${toolTrail}`)
  }
  sections.push(
    `## 要求\n\n你是第 ${input.round} 轮核验。自己去看文件、自己跑命令，不要只凭 B 的汇报下结论。` +
      '最后只输出：简短说明 + 一个 ```json 代码块（pass / summary / issues / evidence）。',
  )

  const messages: ChatMessage[] = [
    { role: 'system', content: systemFor('verifier', context.config) },
    { role: 'user', content: sections.join('\n\n') },
  ]
  const result = await runAgent({
    client: context.client,
    system: systemFor('verifier', context.config),
    messages,
    toolbox: context.toolbox,
    runtime: context.toolRuntime,
    maxSteps: Math.max(8, Math.trunc(context.config.maxSteps / 2)),
    signal: context.signal,
    hooks,
    toolFilter: { names: VERIFIER_TOOLS },
  })
  return { verdict: parseVerdict(result.finalText), usage: result.usage }
}

export function issuesToPrompt(issues: Issue[]): string {
  return issues
    .map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.where}: ${issue.problem} (fix: ${issue.fix})`)
    .join('\n')
}
