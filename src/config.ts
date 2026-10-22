import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type RoleName = 'leader' | 'planner' | 'implementer' | 'verifier'

export const ROLE_NAMES: readonly RoleName[] = ['leader', 'planner', 'implementer', 'verifier']

export const ROLE_TITLES: Record<RoleName, string> = {
  leader: 'L · 分流（判断这轮怎么走 · 省 token）',
  planner: 'A · 规划 (prompt + guidance)',
  implementer: 'B · 实现 (tools)',
  verifier: 'C · 核验 (read-only + tests)',
}

export const ROLE_SHORT: Record<RoleName, string> = {
  leader: 'L',
  planner: 'A',
  implementer: 'B',
  verifier: 'C',
}

export interface ProviderPreset {
  baseUrl: string
  model: string
  envKey: string
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    envKey: 'OPENROUTER_API_KEY',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-turbo-preview',
    envKey: 'MOONSHOT_API_KEY',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
    envKey: 'ZHIPU_API_KEY',
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:14b',
    envKey: '',
  },
  lmstudio: {
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    envKey: '',
  },
}

export interface RoleConfig {
  role: RoleName
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  headers: Record<string, string>
  timeoutMs: number
  retries: number
  /** Use the deterministic scripted backend (no network, no keys). */
  mock: boolean
  /** 这个角色启用的技能名（空 = 按技能声明的 roles 自动生效）。 */
  skills: string[]
  /** provider → 那家供应商用过的 key（换供应商时自动切回，避免把 A 家的 key 发给 B 家）。 */
  keyHistory: Record<string, string>
  /** Extra text appended to this role's system prompt. */
  systemAppend: string
  maxSteps: number
}

export interface ExecConfig {
  enabled: boolean
  timeoutMs: number
}

import { DEFAULT_VISION, type VisionConfig } from './vision.ts'
import { DEFAULT_COST, type CostConfig } from './cost.ts'
import { DEFAULT_GIT, type GitConfig } from './git.ts'

/** 技能（skill）：按角色追加到系统提示词的方法论。 */
export interface SkillsConfig {
  enabled: boolean
  /** 用户技能目录（导入的技能放这里）；null = 用默认位置。 */
  dir: string | null
  /** 全局停用的技能名。 */
  disabled: string[]
}

/** L（调度）的分流策略：默认开启，宁可多走流水线也不要吞掉真任务。 */
export interface LeaderConfig {
  enabled: boolean
  /** 直接回答时允许的最大输出 token（小 = 省）。 */
  directMaxTokens: number
  /** 目标短于这个长度且没有任何动作词时，才允许"直接回答"。 */
  directMaxChars: number
  /** 预筛：命中任一词就必须走完整流水线（正则），不花 token 判断。 */
  workKeywords: string[]
}

export interface ReviewConfig {
  /** B 实现完先让 A 复核是否偏离任务书。 */
  enabled: boolean
  /** 每轮最多退回 B 修正几次（0 = 只复核不退回，等于关掉回环）。 */
  maxCorrections: number
}

export interface TuiConfig {
  columns: 'auto' | 'stack'
  showTokens: boolean
}

export interface AppConfig {
  /** Absolute path of the config file, or '' when running on defaults. */
  path: string
  root: string
  workspace: string
  maxRounds: number
  maxSteps: number
  exec: ExecConfig
  tui: TuiConfig
  review: ReviewConfig
  leader: LeaderConfig
  skills: SkillsConfig
  cost: CostConfig
  /** C 核验时额外用视觉模型看图（双模型）。 */
  vision: VisionConfig
  git: GitConfig
  roles: Record<RoleName, RoleConfig>
  plugins: string[]
  /** Local DeepSeek Harness install used to resolve @deepseek-ai/* imports. */
  dshNodeModules: string | null
}

export interface LoadOptions {
  configPath?: string
  workspace?: string
  mock?: boolean
  exec?: boolean
  maxRounds?: number
  cwd?: string
}

const CONFIG_FILENAMES = [
  'qzcode.json',
  'qzcode.config.json',
  '.qzcode.json',
  'trio.json',
  // 旧名字，改名前的项目配置仍然生效
  'pi-trio.json',
  'pi-trio.config.json',
  '.pi-trio.json',
]

/** `${VAR}` and `${VAR:-fallback}` expansion, plus `~` for the home directory. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const found = env[name]
    if (found !== undefined && found !== '') return found
    return fallback ?? ''
  })
  if (expanded === '~') return homedir()
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    return join(homedir(), expanded.slice(2))
  }
  return expanded
}

function expandDeep(value: unknown): unknown {
  if (typeof value === 'string') return expandEnv(value)
  if (Array.isArray(value)) return value.map(expandDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = expandDeep(item)
    return out
  }
  return value
}

export function findConfigFile(options: LoadOptions = {}): string {
  if (options.configPath) {
    // 显式指定的路径允许还不存在：扩展第一次启动就是这样，等用户选完供应商再把文件写出来
    return resolve(options.cwd ?? process.cwd(), options.configPath)
  }
  const cwd = options.cwd ?? process.cwd()
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(cwd, name)
    if (existsSync(candidate)) return candidate
  }
  const global = join(homedir(), '.qzcode', 'config.json')
  if (existsSync(global)) return global
  return ''
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 只保留字符串键值对（配置里任何"表"都用它）。 */
function cleanStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) continue
    if (typeof item === 'string') out[key.trim()] = item
  }
  return out
}

function buildRole(
  role: RoleName,
  raw: Record<string, unknown>,
  defaults: Record<string, unknown>,
  mockAll: boolean,
): RoleConfig {
  const merged = { ...defaults, ...raw }
  const provider = str(merged.provider, 'deepseek')
  const preset = PROVIDER_PRESETS[provider]
  const baseUrl = str(merged.baseUrl, preset?.baseUrl ?? 'https://api.deepseek.com/v1')
  const model = str(merged.model, preset?.model ?? 'deepseek-chat')

  let apiKey = str(merged.apiKey, '')
  if (!apiKey && preset?.envKey) apiKey = process.env[preset.envKey] ?? ''
  // Local runtimes do not care about the key, but the OpenAI SDK shape wants one.
  if (!apiKey && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl)) {
    apiKey = 'local'
  }

  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(record(merged.headers))) {
    headers[key] = str(value)
  }

  return {
    role,
    // 历史 key 只用于"换供应商时切回"，不进日志、不上报
    skills: Array.isArray(raw.skills)
      ? raw.skills.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
    keyHistory: (() => {
      const history = cleanStringMap(raw.keyHistory)
      const migratedKeyHistory = { ...history }
      const currentProvider = String(provider ?? '')
      const currentKey = String(apiKey ?? '')
      // 兼容老配置：没有历史就把现有的 key 记到当前供应商名下
      if (currentProvider && currentKey && !migratedKeyHistory[currentProvider]) {
        migratedKeyHistory[currentProvider] = currentKey
      }
      return migratedKeyHistory
    })(),
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    temperature: num(merged.temperature, 0.2),
    maxTokens: num(merged.maxTokens, 4096),
    headers,
    timeoutMs: num(merged.timeoutMs, 180_000),
    retries: num(merged.retries, 2),
    mock: bool(merged.mock, mockAll),
    systemAppend: str(merged.systemAppend, ''),
    maxSteps: num(merged.maxSteps, 0),
  }
}

function normalizeVision(raw: unknown): VisionConfig {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (key: keyof VisionConfig, fallback = ''): string =>
    typeof record[key] === 'string' && String(record[key]).trim() !== '' ? String(record[key]).trim() : fallback
  const num = (key: keyof VisionConfig, fallback: number, min: number): number => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.trunc(value)) : fallback
  }
  return {
    enabled: record.enabled === true,
    provider: text('provider'),
    baseUrl: text('baseUrl'),
    model: text('model'),
    apiKey: text('apiKey'),
    maxTokens: num('maxTokens', DEFAULT_VISION.maxTokens, 50),
    timeoutMs: num('timeoutMs', DEFAULT_VISION.timeoutMs, 5000),
    maxImages: num('maxImages', DEFAULT_VISION.maxImages, 0),
    question: text('question', DEFAULT_VISION.question),
  }
}

function normalizeGit(raw: unknown): GitConfig {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    autoCommit: record.autoCommit === true,
    prefix: typeof record.prefix === 'string' && record.prefix.trim() ? record.prefix.trim() : DEFAULT_GIT.prefix,
  }
}

function normalizeCost(raw: unknown): CostConfig {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const perMillion = record.perMTokens && typeof record.perMTokens === 'object'
    ? (record.perMTokens as Record<string, unknown>)
    : {}
  const models: Record<string, { input: number; output: number }> = {}
  const rawModels = record.models && typeof record.models === 'object'
    ? (record.models as Record<string, unknown>)
    : {}
  for (const [name, value] of Object.entries(rawModels)) {
    const item = value as Record<string, unknown>
    if (typeof item.input === 'number' || typeof item.output === 'number') {
      models[name] = {
        input: typeof item.input === 'number' ? item.input : 0,
        output: typeof item.output === 'number' ? item.output : 0,
      }
    }
  }
  return {
    currency: typeof record.currency === 'string' && record.currency.trim() ? record.currency.trim() : 'CNY',
    perMTokens: {
      input: typeof perMillion.input === 'number' ? perMillion.input : DEFAULT_COST.perMTokens.input,
      output: typeof perMillion.output === 'number' ? perMillion.output : DEFAULT_COST.perMTokens.output,
    },
    models,
    dailyBudget: typeof record.dailyBudget === 'number' && record.dailyBudget >= 0 ? record.dailyBudget : 0,
  }
}

function normalizeSkills(raw: unknown): SkillsConfig {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const disabled = Array.isArray(record.disabled)
    ? record.disabled.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  return {
    enabled: record.enabled === undefined ? true : Boolean(record.enabled),
    dir: typeof record.dir === 'string' && record.dir.trim() ? record.dir.trim() : null,
    disabled,
  }
}

/** leader（调度）配置归一化：缺省开启，坏值收敛到安全范围。 */
function normalizeLeader(raw: unknown): LeaderConfig {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const keywords = Array.isArray(record.workKeywords)
    ? record.workKeywords.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  return {
    enabled: record.enabled === undefined ? true : Boolean(record.enabled),
    directMaxTokens:
      typeof record.directMaxTokens === 'number'
        ? Math.max(120, Math.min(4000, Math.trunc(record.directMaxTokens)))
        : EXAMPLE_CONFIG.leader.directMaxTokens,
    directMaxChars:
      typeof record.directMaxChars === 'number'
        ? Math.max(10, Math.min(2000, Math.trunc(record.directMaxChars)))
        : EXAMPLE_CONFIG.leader.directMaxChars,
    workKeywords: keywords.length > 0 ? keywords : EXAMPLE_CONFIG.leader.workKeywords.slice(),
  }
}

/**
 * 文件里没写的角色（比如新加的 leader）跟随 planner 的连接信息。
 * 否则它会退回内置的 deepseek 预设 —— key 为空、端点也不是用户的，第一步就 401。
 */
function inheritMissingRoles(roles: Record<RoleName, RoleConfig>, missing: RoleName[]): void {
  if (missing.length === 0) return
  // planner 自己都缺的话没得继承（用户就是想全用预设）
  if (missing.includes('planner')) return
  const base = roles.planner
  for (const role of missing) {
    const target = roles[role]
    if (!target) continue
    target.provider = base.provider
    target.baseUrl = base.baseUrl
    target.apiKey = base.apiKey
    target.keyHistory = { ...base.keyHistory }
    target.headers = { ...base.headers }
    target.timeoutMs = base.timeoutMs
    target.retries = base.retries
    target.mock = base.mock
    // 模型：没显式指定（还是预设默认值）就沿用 planner 的，保证能跑通
    const presetModel = EXAMPLE_CONFIG.roles[role]?.model
    if (!target.model || target.model === presetModel) target.model = base.model
  }
}

export function normalizeConfig(input: unknown, options: LoadOptions = {}): AppConfig {
  const root = record(input)
  const cwd = options.cwd ?? process.cwd()
  const expanded = expandDeep(root) as Record<string, unknown>

  const configPath = options.configPath ?? ''
  const configDir = configPath ? dirname(configPath) : cwd

  const workspaceRaw = options.workspace ?? str(expanded.workspace, '.')
  const workspace = isAbsolute(workspaceRaw) ? workspaceRaw : resolve(configDir, workspaceRaw)

  const mockAll = options.mock ?? false
  const rolesRaw = record(expanded.roles)
  const roleDefaults = record(expanded.roleDefaults ?? expanded.defaults)

  const roles = {} as Record<RoleName, RoleConfig>
  const missing: RoleName[] = []
  for (const role of ROLE_NAMES) {
    const raw = record(rolesRaw[role])
    // A role that is present but empty still counts: presets + env fill it in.
    if (!(role in rolesRaw)) missing.push(role)
    roles[role] = buildRole(role, raw, roleDefaults, mockAll)
  }
  // mock 模式零配置可用：没有 roles 就按预设补齐（脚本化模型不需要 key）
  if (mockAll && missing.length > 0) {
    const template = record(EXAMPLE_CONFIG.roles)
    for (const role of missing) {
      roles[role] = buildRole(role, record(template[role]), roleDefaults, true)
    }
    missing.length = 0
  }
  inheritMissingRoles(roles, missing)
  if (missing.length === ROLE_NAMES.length) {
    throw new Error(
      '配置里没有任何 roles。请先运行 `qzcode init` 生成 qzcode.json，再填入 A/B/C 三个角色的 baseUrl / apiKey / model；' +
        '或者加 --mock 先用脚本化模型跑一遍。',
    )
  }
  // leader 是后加的角色：老配置里没有它很正常，上面已经让它继承 planner 的连接，
  // 这里只在"经典三个角色"缺失时才报错（保留拼错角色名的保护）。
  const hardMissing = missing.filter((role) => role !== 'leader')
  if (hardMissing.length > 0 && hardMissing.length < ROLE_NAMES.length) {
    throw new Error(`配置缺少角色: ${hardMissing.map((r) => `roles.${r}`).join(', ')}`)
  }

  const execRaw = record(expanded.exec)
  const tuiRaw = record(expanded.tui)
  const reviewRaw = record(expanded.review)
  const pluginsRaw = Array.isArray(expanded.plugins) ? expanded.plugins : []
  const plugins = pluginsRaw
    .map((item) => (typeof item === 'string' ? item : str(record(item).path, '')))
    .filter((item) => item.length > 0)
    .map((item) => (isAbsolute(item) ? item : resolve(configDir, item)))

  const dshRaw = str(expanded.dshNodeModules, '')
  const dshNodeModules = dshRaw ? (isAbsolute(dshRaw) ? dshRaw : resolve(configDir, dshRaw)) : null

  return {
    path: configPath,
    root: configDir,
    workspace,
    maxRounds: Math.max(1, Math.trunc(options.maxRounds ?? num(expanded.maxRounds, 3))),
    maxSteps: Math.max(1, Math.trunc(num(expanded.maxSteps, 40))),
    exec: {
      enabled: options.exec ?? bool(execRaw.enabled, true),
      timeoutMs: num(execRaw.timeoutMs, 300_000),
    },
    tui: {
      columns: str(tuiRaw.columns, 'auto') === 'stack' ? 'stack' : 'auto',
      showTokens: bool(tuiRaw.showTokens, true),
    },
    leader: normalizeLeader(root.leader),
    skills: normalizeSkills(root.skills),
    cost: normalizeCost(root.cost),
    git: normalizeGit(root.git),
    vision: normalizeVision(root.vision),
    review: {
      // B 实现完先让 A 复核是否跑偏，跑偏就退回 B 修正，没问题才进 C
      enabled: bool(reviewRaw.enabled, true),
      maxCorrections: Math.max(0, Math.min(5, Math.trunc(num(reviewRaw.maxCorrections, 2)))),
    },
    roles,
    plugins,
    dshNodeModules,
  }
}

export function loadConfig(options: LoadOptions = {}): AppConfig {
  const path = findConfigFile(options)
  let raw: unknown = {}
  if (path && existsSync(path)) {
    try {
      // Windows editors love writing a UTF-8 BOM; JSON.parse does not.
      const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
      raw = JSON.parse(text)
    } catch (error) {
      throw new Error(`解析配置失败 (${path}): ${(error as Error).message}`)
    }
  }
  return normalizeConfig(raw, { ...options, configPath: path })
}

/** Fails fast with an actionable message instead of a 401 in the middle of a run. */
export function validateConfig(config: AppConfig): string[] {
  const problems: string[] = []
  for (const role of ROLE_NAMES) {
    const cfg = config.roles[role]
    if (cfg.mock) continue
    if (!/^https?:\/\//.test(cfg.baseUrl)) {
      problems.push(`roles.${role}.baseUrl 必须是 http(s) 地址，当前为 "${cfg.baseUrl}"`)
    }
    if (!cfg.model) problems.push(`roles.${role}.model 不能为空`)
    if (!cfg.apiKey) {
      const preset = PROVIDER_PRESETS[cfg.provider]
      const hint = preset?.envKey ? `或设置环境变量 ${preset.envKey}` : ''
      problems.push(`roles.${role}.apiKey 为空：请在配置里填写 ${hint}`.trim())
    }
  }
  return problems
}

export const EXAMPLE_CONFIG = {
  workspace: '.',
  maxRounds: 3,
  maxSteps: 40,
  exec: { enabled: true, timeoutMs: 300000 },
  tui: { columns: 'auto', showTokens: true },
  review: { enabled: true, maxCorrections: 2 },
  skills: { enabled: true, dir: null, disabled: [] },
  cost: DEFAULT_COST,
  vision: DEFAULT_VISION,
  git: DEFAULT_GIT,
  leader: {
    enabled: true,
    directMaxTokens: 900,
    directMaxChars: 80,
    workKeywords: [
      '写', '改', '实现', '修复', '生成', '创建', '新增', '删除', '重写', '重构', '优化', '添加',
      '部署', '安装', '运行', '执行', '测试', '调试', '排查', '提交', '合并', '迁移', '升级',
      'html', 'css', 'js', 'ts', 'py', 'java', 'go', 'rust', 'sql', 'json', 'yaml', '脚本', '函数',
      '接口', '数据库', '页面', '组件', '游戏', '网站', '插件', '配置', '文档', 'README',
      'bug', 'error', '报错', '崩溃', '失败', '性能',
    ],
  },
  roles: {
    // L 只做分流：要么直接答（省掉 A/B/C 的全部 token），要么把活交给 A
    leader: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '${DEEPSEEK_API_KEY}',
      model: 'deepseek-chat',
      temperature: 0.1,
      maxTokens: 1024,
    },
    planner: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '${DEEPSEEK_API_KEY}',
      model: 'deepseek-chat',
      temperature: 0.3,
      maxTokens: 4096,
    },
    implementer: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '${DEEPSEEK_API_KEY}',
      model: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 8192,
    },
    verifier: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '${DEEPSEEK_API_KEY}',
      model: 'deepseek-reasoner',
      temperature: 0.1,
      maxTokens: 4096,
    },
  },
  plugins: [] as string[],
}

export function writeExampleConfig(target: string): string {
  if (existsSync(target)) throw new Error(`已存在同名文件: ${target}`)
  writeFileSync(target, `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`, 'utf8')
  return target
}
