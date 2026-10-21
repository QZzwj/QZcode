import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppConfig } from '../config.ts'
import type { RoleName } from '../config.ts'
import { ROLE_NAMES, ROLE_TITLES } from '../config.ts'
import type { CommandRegistry } from '../commands.ts'
import type { Logger, PluginRecord } from '../kernel.ts'
import { createClient } from '../llm.ts'
import type { Usage } from '../llm.ts'
import type { PaneId, Phase, Reporter, RunResult, ToolEvent } from '../pipeline.ts'
import { runPipeline } from '../pipeline.ts'
import { applyProvider, applyRole, copyRole, listProviders, listRoles } from '../providers.ts'
import { CostLedger, formatMoney } from '../cost.ts'
import { commitPaths, headShort, isGitRepo } from '../git.ts'
import { createStepMeter, stepSpeeds, type StepStat } from '../steps.ts'
import { describeImage } from '../vision.ts'
import { formatDoctor, runDoctor } from '../doctor.ts'
import { diffSnapshot, listSnapshots, loadSnapshot, restoreFromIndex, SnapshotStore } from '../snapshot.ts'
import { importSkill, listSkills } from '../skills.ts'
import type { Plan, Review, Verdict } from '../roles.ts'
import type { ToolRuntime, Toolbox } from '../tools.ts'

/** One serialisable event; the browser reducer consumes exactly these. */
export type UiEvent =
  | { t: 'run_start'; runId: string; goal: string; at: number; mock: boolean }
  | { t: 'phase'; phase: Phase; round: number }
  | { t: 'text'; pane: PaneId; delta: string }
  | { t: 'text_end'; pane: PaneId }
  | { t: 'tool'; pane: PaneId; stage: 'start' | 'end'; name: string; args?: string; ok?: boolean; output?: string; ms?: number }
  | { t: 'note'; level: 'info' | 'warn' | 'error'; message: string }
  /** 文件改动：B 每写完/改完一个文件就推一条，侧栏直接显示代码过程 */
  | {
      t: 'patch'
      pane: PaneId
      path: string
      status: 'created' | 'modified' | 'deleted'
      added: number
      removed: number
      diff: string
    }
  | { t: 'plan'; round: number; plan: Plan }
  | { t: 'review'; round: number; attempt: number; review: Review }
  | { t: 'verdict'; round: number; verdict: Verdict }
  | { t: 'usage'; pane: PaneId; usage: Usage }
  | { t: 'done'; result: RunResult; touched?: number }
  | { t: 'run_end'; status: RunStatus }

export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'error'

interface RunState {
  id: string
  goal: string
  createdAt: number
  updatedAt: number
  status: RunStatus
  events: UiEvent[]
  seq: number
  error?: string
  abort?: AbortController
  /** 各步骤的模型耗时与输出 token（跑完填）。 */
  steps?: StepStat[]
  bestSteps?: Array<{ role: RoleName; tokPerSec: number }>
  /** 本次运行的快照（文件被改之前存一份原件）。 */
  snapshot?: SnapshotStore
}

export interface WebServerOptions {
  config: AppConfig
  toolbox: Toolbox
  toolRuntime: ToolRuntime
  plugins: PluginRecord[]
  commands: CommandRegistry
  logger: Logger
  host?: string
  port?: number
  emit?: (event: string, payload?: unknown) => void
  /** Cap on retained runs (oldest dropped first). */
  maxRuns?: number
}

/** 把视觉模型设置写回配置文件。 */
async function persistVision(config: AppConfig, vision: unknown): Promise<boolean> {
  if (!config.path) return false
  try {
    const parsed = JSON.parse(readFileSync(config.path, 'utf8')) as Record<string, unknown>
    parsed.vision = vision
    writeFileSync(config.path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 把 git 开关写回配置文件；没有配置文件就跳过（只影响当前进程）。 */
async function persistGit(config: AppConfig, autoCommit: boolean): Promise<boolean> {
  if (!config.path) return false
  try {
    const raw = readFileSync(config.path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const current = (parsed.git && typeof parsed.git === 'object' ? parsed.git : {}) as Record<string, unknown>
    parsed.git = { ...current, autoCommit }
    writeFileSync(config.path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function readBody(request: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function configSummary(config: AppConfig, plugins: PluginRecord[]) {
  return {
    workspace: config.workspace,
    maxRounds: config.maxRounds,
    maxSteps: config.maxSteps,
    exec: config.exec.enabled,
    mock: config.roles.planner.mock,
    review: config.review.enabled,
    leader: {
      enabled: config.leader.enabled,
      model: config.roles.leader.model,
      provider: config.roles.leader.provider,
      hasKey: Boolean(config.roles.leader.apiKey),
      mock: Boolean(config.roles.leader.mock),
    },
    maxCorrections: config.review.maxCorrections,
    path: config.path,
    roles: ROLE_NAMES.map((role) => ({
      role,
      title: ROLE_TITLES[role],
      model: config.roles[role].model,
      provider: config.roles[role].provider,
      baseUrl: config.roles[role].baseUrl,
      hasKey: Boolean(config.roles[role].apiKey),
      mock: config.roles[role].mock,
    })),
    plugins: plugins.map((plugin) => ({ name: plugin.name, status: plugin.status, detail: plugin.detail ?? '' })),
  }
}

export interface WebServer {
  url: string
  port: number
  listenHost: string
  close(): Promise<void>
}

export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  const { config, toolbox, toolRuntime, plugins, logger } = options
  const host = options.host ?? '127.0.0.1'
  const maxRuns = options.maxRuns ?? 50
  const runs = new Map<string, RunState>()
  /**
   * 成本账本：跟着配置文件走（默认在扩展全局存储里），
   * 这样换个工作区也不会把"今日花了多少"清零。
   */
  const costLedger = () => new CostLedger(config.path ? dirname(config.path) : toolRuntime.workspace)
  const subscribers = new Map<string, Set<(event: UiEvent) => void>>()
  const commands = options.commands

  const broadcast = (runId: string, event: UiEvent) => {
    const listeners = subscribers.get(runId)
    if (!listeners) return
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        listeners.delete(listener)
      }
    }
  }

  const push = (run: RunState, event: UiEvent) => {
    run.seq += 1
    run.updatedAt = Date.now()
    run.events.push(event)
    broadcast(run.id, event)
  }

  /** 记住每个工具调用的参数：pipeline 只在 start 事件里带 args。 */
  const pendingToolArgs = new Map<string, string>()

  /** 单个文件的 diff：拿快照原件和现在的文件比。 */
  const emitPatch = (run: RunState, pane: PaneId, targetPath: string): void => {
    if (!run.snapshot) return
    try {
      const index = {
        runId: run.snapshot.runId,
        workspace: run.snapshot.workspace,
        createdAt: run.createdAt,
        entries: run.snapshot.entries.filter((entry) => entry.path === targetPath.split('\\').join('/')),
      }
      if (index.entries.length === 0) return
      const [file] = diffSnapshot(toolRuntime.workspace, index)
      if (!file) return
      push(run, {
        t: 'patch',
        pane,
        path: file.path,
        status: file.status,
        added: file.added,
        removed: file.removed,
        diff: file.diff.slice(0, 6000),
      })
    } catch {
      // diff 失败不能影响运行
    }
  }

  const makeReporter = (run: RunState): Reporter => ({
    phase(phase, round) {
      push(run, { t: 'phase', phase, round })
    },
    text(pane, delta) {
      push(run, { t: 'text', pane, delta })
    },
    textEnd(pane) {
      push(run, { t: 'text_end', pane })
    },
    tool(event: ToolEvent) {
      push(run, {
        t: 'tool',
        pane: event.pane,
        stage: event.stage,
        name: event.name,
        args: event.args,
        ok: event.ok,
        output: event.output,
        ms: event.ms,
      })
      // 写/改文件后立刻把这个文件的 diff 推给界面：
      // 用户能看到"正在改什么"，而不是等跑完才看总结
      const toolKey = `${event.pane}:${event.name}`
      if (event.stage === 'start' && event.args) {
        // end 事件不带参数，这里先记下来（write/edit 要用它拿文件路径）
        pendingToolArgs.set(toolKey, event.args)
      }
      if (event.stage === 'end' && event.ok !== false && (event.name === 'write' || event.name === 'edit')) {
        const args = event.args || pendingToolArgs.get(toolKey) || ''
        try {
          const parsed = JSON.parse(args) as { path?: string }
          if (parsed.path) emitPatch(run, event.pane, parsed.path)
        } catch {
          // 参数不是 JSON 就算了，不影响运行
        }
        pendingToolArgs.delete(toolKey)
      }
    },
    note(message, level = 'info') {
      push(run, { t: 'note', level, message })
    },
    plan(round, plan) {
      push(run, { t: 'plan', round, plan })
    },
    review(round, review, attempt) {
      push(run, { t: 'review', round, attempt, review })
    },
    verdict(round, verdict) {
      push(run, { t: 'verdict', round, verdict })
    },
    usage(pane, usage) {
      push(run, { t: 'usage', pane, usage })
    },
    done(result) {
      push(run, { t: 'done', result, touched: run.snapshot?.touched ?? 0 })
    },
  })

  const startRun = (goal: string): RunState => {
    const run: RunState = {
      id: randomUUID().slice(0, 8),
      goal,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      events: [],
      seq: 0,
      abort: new AbortController(),
    }
    run.snapshot = new SnapshotStore(run.id, toolRuntime.workspace)
    runs.set(run.id, run)
    while (runs.size > maxRuns) {
      const oldest = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!oldest || oldest.status === 'running') break
      runs.delete(oldest.id)
      subscribers.delete(oldest.id)
    }

    push(run, { t: 'run_start', runId: run.id, goal, at: run.createdAt, mock: config.roles.planner.mock })

    void (async () => {
      try {
        // 每个 run 自己的 toolRuntime：文件被改之前先快照，方便回滚
        // 视觉模型（C 是纯文本模型时的"第二双眼睛"）
        let visionUsed = 0
        const visionRuntime = config.vision.enabled && config.vision.model.trim() !== ''
          ? {
              vision: async (file: string) => {
                if (config.vision.maxImages > 0 && visionUsed >= config.vision.maxImages) {
                  return { ok: false, description: '', error: `这次运行已经看了 ${visionUsed} 张图，达到上限` }
                }
                visionUsed += 1
                const verifier = config.roles.verifier
                const result = await describeImage(
                  {
                    baseUrl: config.vision.baseUrl || verifier.baseUrl,
                    apiKey: config.vision.apiKey || verifier.apiKey,
                    model: config.vision.model,
                    headers: verifier.headers,
                    timeoutMs: config.vision.timeoutMs,
                    maxTokens: config.vision.maxTokens,
                    question: config.vision.question,
                  },
                  file,
                )
                push(run, {
                  t: 'note',
                  level: result.ok ? 'info' : 'warn',
                  message: result.ok
                    ? `视觉模型看过 ${file.split(/[\\/]/).pop()}：${result.description.slice(0, 60)}…`
                    : `视觉模型没看成：${result.error}`,
                })
                return result
              },
            }
          : {}

        const runToolRuntime = {
          ...toolRuntime,
          ...visionRuntime,
          snapshot: (absPath: string) => run.snapshot?.capture(absPath),
        }
        // 每一步（L/A/B/C）的模型耗时与输出 token：成本页按步骤显示
        const meter = createStepMeter()
        const clients = {
          leader: meter.wrap(createClient(config.roles.leader), 'leader'),
          planner: meter.wrap(createClient(config.roles.planner), 'planner'),
          implementer: meter.wrap(createClient(config.roles.implementer), 'implementer'),
          verifier: meter.wrap(createClient(config.roles.verifier), 'verifier'),
        }
        const result = await runPipeline({
          config,
          goal,
          toolbox,
          toolRuntime: runToolRuntime,
          reporter: makeReporter(run),
          signal: run.abort?.signal,
          emit: options.emit,
          clients,
        })
        run.steps = meter.snapshot()
        run.bestSteps = (['leader', 'planner', 'implementer', 'verifier'] as const).map((role) => ({
          role,
          tokPerSec: meter.bestOf(role),
        }))
        // 实时给界面报一次"每一步多快"，不用等跑完
        for (const stat of run.steps) {
          const speeds = stepSpeeds(stat)
          logger.info(
            `[step] ${stat.role} ${stat.calls} 次 · ${speeds.tokPerSec} tok/s · ${(stat.ms / 1000).toFixed(1)}s · 输出 ${stat.completion} tok`,
          )
        }
        run.status = result.ok ? 'passed' : 'failed'
        // 自动 git 提交：只提交这次真改过的文件（路径来自快照，绝不 add -A）
        if (config.git.autoCommit) {
          try {
            const touchedPaths = (run.snapshot?.entries ?? []).map((entry) => entry.path)
            const message = `${config.git.prefix}: ${goal.slice(0, 60)}` + (result.ok ? '' : '（未通过）')
            const committed = await commitPaths(toolRuntime.workspace, touchedPaths, message)
            if (committed.commit) {
              push(run, { t: 'note', level: 'info', message: `已提交 git：${committed.commit}` })
              logger.info(`[git] ${committed.commit} ${message}`)
            } else if (committed.error) {
              push(run, { t: 'note', level: 'warn', message: `git 提交失败：${committed.error}` })
            } else if (committed.skipped) {
              push(run, { t: 'note', level: 'info', message: `没有提交：${committed.skipped}` })
            }
          } catch (error) {
            logger.warn(`[git] ${(error as Error).message}`)
          }
        }
        // 记一笔账（成本面板按天累计）
        try {
          costLedger().record({
            runId: run.id,
            goal,
            total: result.cost?.total ?? 0,
            byRole: result.cost?.byRole ?? {},
            tokens: result.usage?.total ?? 0,
            prompt: result.usage?.prompt ?? 0,
            completion: result.usage?.completion ?? 0,
            steps: run.steps,
            bestSteps: run.bestSteps,
            // mock 的 token 是估算值、耗时又是毫秒级，算 tok/s 会很荒谬，直接不计
            ms: config.roles.planner.mock ? 0 : (result.elapsedMs ?? 0),
          })
        } catch {
          // 记不下账不影响运行
        }
        push(run, { t: 'run_end', status: run.status })
        logger.info(`web run ${run.id} ${run.status}`)
      } catch (error) {
        const aborted = (error as Error).name === 'AbortError'
        run.status = aborted ? 'cancelled' : 'error'
        run.error = (error as Error).message
        push(run, { t: 'note', level: aborted ? 'warn' : 'error', message: aborted ? '已取消' : run.error })
        push(run, { t: 'run_end', status: run.status })
        logger.error(`web run ${run.id} failed`, error)
      } finally {
        run.abort = undefined
      }
    })()

    return run
  }

  /** 只放行本机与 VS Code webview 的跨源请求（本服务只监听 127.0.0.1，没有 cookie 鉴权）。 */
  const allowOrigin = (origin: string | undefined): string | undefined => {
    if (!origin) return undefined
    if (/^vscode-webview:\/\//i.test(origin)) return origin
    if (/^vscode-file:\/\//i.test(origin)) return origin
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return origin
    return undefined
  }

  /**
   * 拉端点上的模型列表（给设置面板做下拉选择）。
   * 用界面里刚填、可能还没保存的 baseUrl / apiKey / headers，所以入参优先。
   */
  async function fetchModels(body: Record<string, unknown>): Promise<{
    ok: boolean
    ms: number
    baseUrl: string
    models: { id: string; contextLength?: number; maxOutput?: number; credits?: string; description?: string }[]
    error?: string
  }> {
    const role = String(body.role ?? '')
    const fallback = ROLE_NAMES.includes(role as (typeof ROLE_NAMES)[number])
      ? config.roles[role as (typeof ROLE_NAMES)[number]]
      : config.roles.planner
    const baseUrl = String(body.baseUrl ?? fallback.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error(`接口地址必须是 http(s):// 开头，当前是 "${baseUrl || '(空)'}"`)
    }
    const apiKey =
      typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : fallback.apiKey
    const extraHeaders =
      body.headers && typeof body.headers === 'object'
        ? (body.headers as Record<string, string>)
        : fallback.headers
    const headers: Record<string, string> = { ...extraHeaders }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const started = Date.now()
    const response = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(Math.min(30_000, fallback.timeoutMs || 30_000)),
    })
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 300)
      return {
        ok: false,
        ms: Date.now() - started,
        baseUrl,
        models: [],
        error: `/models 返回 ${response.status}：${text || '(空响应)'}${authHint(response.status, String(body.provider ?? fallback.provider ?? ''))}`,
      }
    }
    const payload = (await response.json().catch(() => null)) as
      | { data?: Record<string, unknown>[] }
      | null
    const models = (payload?.data ?? [])
      .map((item) => ({
        id: String(item.id ?? ''),
        contextLength: typeof item.context_length === 'number' ? item.context_length : undefined,
        maxOutput: typeof item.max_output_tokens === 'number' ? item.max_output_tokens : undefined,
        credits: typeof item.credits === 'string' ? item.credits : undefined,
        description: typeof item.description === 'string' ? item.description : undefined,
      }))
      .filter((item) => item.id)
      .sort((a, b) => a.id.localeCompare(b.id))
    return { ok: true, ms: Date.now() - started, baseUrl, models }
  }

  /** 用户技能目录：配置里指定优先，否则放在配置文件旁边的 skills/。 */
  function skillsDir(): string | null {
    if (config.skills.dir) return config.skills.dir
    const base = config.path ? dirname(config.path) : config.workspace || config.root
    return base ? join(base, 'skills') : null
  }

  /** 401/403 时给一句能落地的建议：多半是拿别家的 key 用了。 */
  function authHint(status: number, provider: string): string {
    if (status !== 401 && status !== 403) return ''
    return (
      `（${status} 通常是 key 不匹配：确认这个 key 属于 "${provider}" 这家供应商。` +
      '换供应商时 QZcode 不会复用上一家的 key，请在卡片里重新填写这一家的。）'
    )
  }

  /** 用某个角色当前的配置打一次真实探活：GET /models 验 key，再花极少 token 验一次对话。 */
  async function testRole(role: (typeof ROLE_NAMES)[number]): Promise<{
    ok: boolean
    ms: number
    model: string
    baseUrl: string
    models?: string[]
    error?: string
  }> {
    const current = config.roles[role]
    const started = Date.now()
    const base = current.baseUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...current.headers,
    }
    if (current.apiKey) headers.authorization = `Bearer ${current.apiKey}`
    const timeout = Math.min(30_000, current.timeoutMs || 30_000)

    try {
      const listed = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(timeout) })
      let models: string[] | undefined
      if (listed.ok) {
        const payload = (await listed.json().catch(() => null)) as { data?: { id?: string }[] } | null
        models = (payload?.data ?? []).map((item) => String(item.id ?? '')).filter(Boolean)
      }
      if (!listed.ok) {
        const text = (await listed.text().catch(() => '')).slice(0, 300)
        return {
          ok: false,
          ms: Date.now() - started,
          model: current.model,
          baseUrl: base,
          error: `/models 返回 ${listed.status}：${text || '(空响应)'}${authHint(listed.status, current.provider)}`,
        }
      }
      if (models && models.length > 0 && current.model && !models.includes(current.model)) {
        return {
          ok: false,
          ms: Date.now() - started,
          model: current.model,
          baseUrl: base,
          models,
          error: `模型 "${current.model}" 不在该端点的模型列表里（端点有 ${models.length} 个模型）`,
        }
      }
      // 真跑一次最小对话，确认模型名 + 参数 + 流式端点都能用（几 token 而已）
      const chat = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
          model: current.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
          ...(current.temperature !== undefined ? { temperature: current.temperature } : {}),
        }),
      })
      if (!chat.ok) {
        const text = (await chat.text().catch(() => '')).slice(0, 300)
        return {
          ok: false,
          ms: Date.now() - started,
          model: current.model,
          baseUrl: base,
          models,
          error: `对话请求返回 ${chat.status}：${text || '(空响应)'}${authHint(chat.status, current.provider)}`,
        }
      }
      return { ok: true, ms: Date.now() - started, model: current.model, baseUrl: base, models }
    } catch (error) {
      return {
        ok: false,
        ms: Date.now() - started,
        model: current.model,
        baseUrl: base,
        error: (error as Error).message,
      }
    }
  }


  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      const path = url.pathname

      // 跨源：VS Code 的 webview origin 是 vscode-webview://…，直接 fetch 本机端口必须带 CORS 头，
      // 否则浏览器会丢弃响应，前端只会看到一句 "Failed to fetch"。只放行本机与 webview 来源。
      const origin = request.headers.origin
      const allowedOrigin = allowOrigin(origin)
      if (allowedOrigin) {
        response.setHeader('access-control-allow-origin', allowedOrigin)
        response.setHeader('vary', 'origin')
        response.setHeader('access-control-allow-private-network', 'true')
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(allowedOrigin ? 204 : 403, {
          ...(allowedOrigin ? {} : { 'content-type': 'text/plain' }),
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        })
        response.end(allowedOrigin ? undefined : 'origin not allowed')
        return
      }

      try {

        if (request.method === 'GET' && path === '/api/state') {
          sendJson(response, 200, {
            config: configSummary(config, plugins),
            runs: [...runs.values()]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((run) => ({
                id: run.id,
                goal: run.goal,
                status: run.status,
                createdAt: run.createdAt,
                updatedAt: run.updatedAt,
                rounds: run.events.filter((event) => event.t === 'verdict').length,
              })),
            commands: commands.list().map((command) => ({ name: command.name, description: command.description })),
          })
          return
        }

        if (request.method === 'GET' && path === '/api/run') {
          const id = url.searchParams.get('id') ?? ''
          const run = runs.get(id)
          if (!run) {
            sendJson(response, 404, { error: `没有这个运行: ${id}` })
            return
          }
          sendJson(response, 200, {
            id: run.id,
            goal: run.goal,
            status: run.status,
            error: run.error ?? '',
            events: run.events,
          })
          return
        }

        if (request.method === 'GET' && path === '/api/events') {
          const id = url.searchParams.get('id') ?? ''
          const run = runs.get(id)
          if (!run) {
            sendJson(response, 404, { error: `没有这个运行: ${id}` })
            return
          }
          const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          })
          response.write(': ok\n\n')
          for (const event of run.events.slice(since)) {
            response.write(`data: ${JSON.stringify(event)}\n\n`)
          }
          if (run.status !== 'running') {
            response.end()
            return
          }
          const listener = (event: UiEvent) => {
            response.write(`data: ${JSON.stringify(event)}\n\n`)
            if (event.t === 'run_end') {
              cleanup()
              response.end()
            }
          }
          const heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000)
          const cleanup = () => {
            clearInterval(heartbeat)
            subscribers.get(id)?.delete(listener)
          }
          const bucket = subscribers.get(id) ?? new Set()
          bucket.add(listener)
          subscribers.set(id, bucket)
          request.on('close', cleanup)
          return
        }

        if (request.method === 'POST' && path === '/api/run') {
          const body = await readBody(request)
          const goal = String(body.goal ?? '').trim()
          if (!goal) {
            sendJson(response, 400, { error: 'goal 不能为空' })
            return
          }
          const active = [...runs.values()].find((item) => item.status === 'running')
          if (active) {
            sendJson(response, 409, { error: `已有运行在进行中（${active.id}），先取消再开始` })
            return
          }
          const run = startRun(goal)
          sendJson(response, 200, { runId: run.id })
          return
        }

        if (request.method === 'POST' && path === '/api/cancel') {
          const body = await readBody(request)
          const wanted = String(body.runId ?? '')
          // 不传 runId 就停"正在跑的那个"——侧栏的停止按钮经常拿不到 id
          const run = wanted
            ? runs.get(wanted)
            : [...runs.values()].filter((item) => item.status === 'running').pop()
          if (!run) {
            sendJson(response, 404, { error: wanted ? '没有这个运行' : '当前没有正在运行的运行' })
            return
          }
          if (run.status !== 'running') {
            sendJson(response, 409, { error: `该运行已经结束（${run.status}）` })
            return
          }
          run.abort?.abort()
          // 立刻给界面反馈：命令正在被掐断，不用等流水线自己发现
          push(run, { t: 'note', level: 'warn', message: '已请求停止：正在中断当前操作' })
          logger.warn(`取消运行 ${run.id}`)
          sendJson(response, 200, { ok: true, runId: run.id })
          return
        }

        if (request.method === 'POST' && path === '/api/command') {
          const body = await readBody(request)
          const name = String(body.name ?? '').replace(/^\/+/, '')
          const args = String(body.args ?? '')
          const command = commands.get(name)
          if (!command) {
            sendJson(response, 404, { ok: false, error: `没有这个命令: /${name}` })
            return
          }
          const messages: string[] = []
          try {
            await command.handler(args, {
              notify: (message, level) => {
                messages.push(message)
                logger.info(`command /${name}: ${message}`, level ?? 'info')
              },
              config,
            })
            sendJson(response, 200, { ok: true, messages })
          } catch (error) {
            sendJson(response, 500, { ok: false, error: (error as Error).message, messages })
          }
          return
        }

        if (request.method === 'POST' && path === '/api/config') {
          const body = await readBody(request)
          if (typeof body.mock === 'boolean') {
            for (const role of ROLE_NAMES) config.roles[role].mock = body.mock
          }
          if (typeof body.exec === 'boolean') config.exec.enabled = body.exec
          if (typeof body.maxRounds === 'number' && body.maxRounds >= 1 && body.maxRounds <= 10) {
            config.maxRounds = Math.trunc(body.maxRounds)
          }
          if (typeof body.review === 'boolean') config.review.enabled = body.review
          if (typeof body.maxCorrections === 'number') {
            config.review.maxCorrections = Math.max(0, Math.min(5, Math.trunc(body.maxCorrections)))
          }
          sendJson(response, 200, { config: configSummary(config, plugins) })
          return
        }

        if (request.method === 'GET' && path === '/api/roles') {
          // workspace：后端真正干活用的目录（= 触发这次运行的 VS Code 打开文件夹）
        sendJson(response, 200, {
          ...listRoles(config),
          workspace: config.workspace || toolRuntime.workspace,
          git: { ...config.git, repo: await isGitRepo(config.workspace || toolRuntime.workspace) },
          vision: config.vision,
        })
          return
        }

        if (request.method === 'GET' && path === '/api/snapshots') {
          sendJson(response, 200, { ok: true, workspace: toolRuntime.workspace, snapshots: listSnapshots(toolRuntime.workspace) })
          return
        }

        if (request.method === 'GET' && path === '/api/diff') {
          const runId = url.searchParams.get('runId') ?? ''
          const latest = listSnapshots(toolRuntime.workspace)[0]?.runId
          const target = runId || latest || ''
          const index = target ? loadSnapshot(toolRuntime.workspace, target) : null
          if (!index) {
            sendJson(response, 404, { ok: false, error: '没有这次运行的快照（可能还没改过文件）' })
            return
          }
          const files = diffSnapshot(toolRuntime.workspace, index)
          sendJson(response, 200, {
            ok: true,
            runId: index.runId,
            createdAt: index.createdAt,
            files,
            added: files.reduce((sum, file) => sum + file.added, 0),
            removed: files.reduce((sum, file) => sum + file.removed, 0),
          })
          return
        }

        if (request.method === 'POST' && path === '/api/rollback') {
          const body = await readBody(request)
          const runId = String(body.runId ?? '') || listSnapshots(toolRuntime.workspace)[0]?.runId || ''
          const index = runId ? loadSnapshot(toolRuntime.workspace, runId) : null
          if (!index) {
            sendJson(response, 404, { ok: false, error: '没有可回滚的快照' })
            return
          }
          const result = restoreFromIndex(toolRuntime.workspace, index)
          logger.warn(`回滚 ${runId}：恢复 ${result.restored.length} 个、删除 ${result.deleted.length} 个`)
          sendJson(response, 200, { ok: result.failed.length === 0, runId, ...result })
          return
        }

        if (request.method === 'POST' && path === '/api/vision') {
          const body = await readBody(request)
          if (typeof body.enabled === 'boolean') config.vision.enabled = body.enabled
          if (typeof body.model === 'string') config.vision.model = body.model.trim()
          if (typeof body.baseUrl === 'string') config.vision.baseUrl = body.baseUrl.trim()
          if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') config.vision.apiKey = body.apiKey.trim()
          if (typeof body.question === 'string' && body.question.trim() !== '') config.vision.question = body.question.trim()
          if (typeof body.maxImages === 'number' && Number.isFinite(body.maxImages)) {
            config.vision.maxImages = Math.max(0, Math.trunc(body.maxImages))
          }
          let saved = false
          try {
            saved = await persistVision(config, config.vision)
          } catch (error) {
            logger.warn(`保存视觉模型设置失败：${(error as Error).message}`)
          }
          // 开关打开但没填模型 = 等于没开，直接说清楚
          const ready = config.vision.enabled && config.vision.model.trim() !== ''
          sendJson(response, 200, { ok: true, saved, ready, vision: config.vision })
          return
        }

        if (request.method === 'POST' && path === '/api/git') {
          const body = await readBody(request)
          if (typeof body.autoCommit === 'boolean') config.git.autoCommit = body.autoCommit
          const workspace = config.workspace || toolRuntime.workspace
          const repo = await isGitRepo(workspace)
          let saved = false
          try {
            const result = await persistGit(config, body.autoCommit === true)
            saved = result
          } catch (error) {
            logger.warn(`保存 git 开关失败：${(error as Error).message}`)
          }
          sendJson(response, 200, { ok: true, git: { ...config.git, repo }, saved })
          return
        }

        if (request.method === 'GET' && path === '/api/cost') {
          const summary = costLedger().summary(config.cost)
          sendJson(response, 200, {
            ok: true,
            currency: summary.currency,
            today: summary.today,
            total: summary.total,
            runs: summary.runs,
            budget: summary.budget,
            remaining: summary.remaining,
            overBudget: summary.overBudget,
            byRole: summary.byRole,
            recent: summary.recent,
            avgTokPerSec: summary.avgTokPerSec,
            speedSamples: summary.speedSamples,
            steps: summary.steps,
            maxTokPerSec: summary.maxTokPerSec,
            avgRunMs: summary.avgRunMs,
            text: `今日 ${formatMoney(summary.today, summary.currency)} / 累计 ${formatMoney(summary.total, summary.currency)}（${summary.runs} 次运行）` +
              (summary.budget > 0 ? `，预算 ${formatMoney(summary.budget, summary.currency)}` : ''),
            prices: { perMTokens: config.cost.perMTokens, models: config.cost.models },
          })
          return
        }

        if (request.method === 'GET' && path === '/api/doctor') {
          const network = url.searchParams.get('network') !== '0'
          const result = await runDoctor({ config, network, skillsDir: skillsDir() })
          logger.info(`体检：${result.summary.ok} ok / ${result.summary.warn} warn / ${result.summary.error} error`)
          sendJson(response, 200, { ...result, text: formatDoctor(result) })
          return
        }

        if (request.method === 'GET' && path === '/api/skills') {
          const dir = skillsDir()
          const list = listSkills(dir).map((skill) => ({
            name: skill.name,
            title: skill.title,
            description: skill.description,
            roles: skill.roles,
            source: skill.source,
            path: skill.path,
            enabledFor: Object.fromEntries(
              ROLE_NAMES.map((role) => [role, (config.roles[role]?.skills ?? []).includes(skill.name)]),
            ),
          }))
          sendJson(response, 200, { ok: true, dir, skills: list })
          return
        }

        if (request.method === 'POST' && path === '/api/skills/import') {
          const body = await readBody(request)
          const dir = skillsDir()
          if (!dir) {
            sendJson(response, 400, { ok: false, error: '没有可写的技能目录' })
            return
          }
          const source = String(body.source ?? 'path')
          if (!['path', 'url', 'text'].includes(source)) {
            sendJson(response, 400, { ok: false, error: 'source 只能是 path / url / text' })
            return
          }
          const result = await importSkill({
            userDir: dir,
            source: source as 'path' | 'url' | 'text',
            value: String(body.value ?? ''),
            name: typeof body.name === 'string' ? body.name : undefined,
            roles: typeof body.roles === 'string' ? body.roles : undefined,
          })
          sendJson(response, result.ok ? 200 : 400, result)
          return
        }

        if (request.method === 'POST' && path === '/api/skills/remove') {
          const body = await readBody(request)
          const name = String(body.name ?? '')
          const dir = skillsDir()
          const target = listSkills(dir).find((skill) => skill.name === name)
          if (!target) {
            sendJson(response, 404, { ok: false, error: `没有这个技能: ${name}` })
            return
          }
          if (target.source !== 'user') {
            sendJson(response, 400, { ok: false, error: '内置技能不能删除，可以在配置里停用' })
            return
          }
          try {
            rmSync(target.path)
            sendJson(response, 200, { ok: true, name })
          } catch (error) {
            sendJson(response, 500, { ok: false, error: (error as Error).message })
          }
          return
        }

        if (request.method === 'POST' && path === '/api/models') {
          const body = await readBody(request)
          try {
            sendJson(response, 200, await fetchModels(body))
          } catch (error) {
            sendJson(response, 400, { ok: false, models: [], error: (error as Error).message })
          }
          return
        }

        if (request.method === 'POST' && path === '/api/roles') {
          const body = await readBody(request)
          try {
            if (typeof body.testRole === 'string') {
              const role = String(body.testRole)
              if (!ROLE_NAMES.includes(role as (typeof ROLE_NAMES)[number])) {
                sendJson(response, 400, { error: `未知角色: ${role}` })
                return
              }
              const result = await testRole(role as (typeof ROLE_NAMES)[number])
              sendJson(response, 200, result)
              return
            }
            if (typeof body.copyFrom === 'string') {
              const from = String(body.copyFrom)
              if (!ROLE_NAMES.includes(from as (typeof ROLE_NAMES)[number])) {
                sendJson(response, 400, { error: `未知角色: ${from}` })
                return
              }
              const result = copyRole(config, from as (typeof ROLE_NAMES)[number], ROLE_NAMES.slice())
              sendJson(response, 200, { ok: true, ...result })
              return
            }
            const role = String(body.role ?? '')
            if (!role) {
              sendJson(response, 400, { error: '缺少 role' })
              return
            }
            const result = applyRole(config, {
              role: role as (typeof ROLE_NAMES)[number],
              provider: typeof body.provider === 'string' ? body.provider : undefined,
              baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
              model: typeof body.model === 'string' ? body.model : undefined,
              apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
              temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
              maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
              maxSteps: typeof body.maxSteps === 'number' ? body.maxSteps : undefined,
              headers:
                body.headers && typeof body.headers === 'object'
                  ? (body.headers as Record<string, string>)
                  : undefined,
              timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
              retries: typeof body.retries === 'number' ? body.retries : undefined,
              skills: Array.isArray(body.skills)
                ? body.skills.filter((item): item is string => typeof item === 'string')
                : undefined,
              mock: typeof body.mock === 'boolean' ? body.mock : undefined,
            })
            logger.info(`角色配置更新：${role} → ${config.roles[role as (typeof ROLE_NAMES)[number]].model}`)
            sendJson(response, 200, { ok: true, ...result })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: (error as Error).message })
          }
          return
        }

        if (request.method === 'GET' && path === '/api/providers') {
          sendJson(response, 200, listProviders(config))
          return
        }

        if (request.method === 'POST' && path === '/api/providers') {
          const body = await readBody(request)
          const provider = String(body.provider ?? '').trim()
          if (!provider) {
            sendJson(response, 400, { error: '缺少 provider' })
            return
          }
          try {
            const result = applyProvider(config, {
              provider,
              apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
              model: typeof body.model === 'string' ? body.model : undefined,
              baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
            })
            logger.info(`切换供应商 → ${provider}（${config.roles.planner.model}）`)
            sendJson(response, 200, { ok: true, ...result })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: (error as Error).message })
          }
          return
        }

        if (request.method === 'GET' && path === '/api/health') {
          sendJson(response, 200, { ok: true, runs: runs.size })
          return
        }

        sendJson(response, 404, { error: `未知路径: ${path}` })
      } catch (error) {
        if (!response.headersSent) sendJson(response, 500, { error: (error as Error).message })
        else response.end()
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4319, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 4319)
  // Binding 0.0.0.0 / :: is a listen wildcard; the URL a browser can open is loopback.
  const openHost = host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host

  return {
    url: `http://${openHost}:${port}/`,
    port,
    listenHost: host,
    async close() {
      const running = [...runs.values()].filter((run) => run.status === 'running')
      for (const run of running) run.abort?.abort()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
