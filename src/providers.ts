import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROVIDER_CATALOG, catalogLabel, findCatalogEntry } from './catalog.ts'
import { PROVIDER_PRESETS, ROLE_NAMES, ROLE_TITLES, type AppConfig, type RoleName } from './config.ts'

/** 供应商清单 + 换供应商（内存生效，并尽量写回配置文件）。 */

export interface ProviderEntry {
  id: string
  /** 用户自己配置过（正在用 / 以前填过 key）；false = 代码自带的内置预设。 */
  configured?: boolean
  label: string
  baseUrl: string
  model: string
  envKey: string
  /** 这个供应商现在就是当前生效的那个。 */
  active: boolean
  /** 当前配置里已有可用的 key（含环境变量）。 */
  hasKey: boolean
}

export interface CatalogItem {
  id: string
  /** 下拉里显示的文字（名称 · 站点 · N 个版本） */
  label: string
  name: string
  site: string
  /** 内置的 OpenAI 兼容地址；空 = 要用户自己填 */
  baseUrl: string
  model: string
  /** 需要网关/路由 */
  needsRoute: boolean
  /** 当前某个角色正在用的就是它 */
  current: boolean
}

export interface ProviderState {
  providers: ProviderEntry[]
  /** 下拉里的供应商清单（只是选项，不代表已配置） */
  catalog: CatalogItem[]
  current: {
    provider: string
    model: string
    baseUrl: string
    hasKey: boolean
    mock: boolean
  }
  /** 写回的配置文件路径，null 表示只在内存里生效。 */
  configPath: string | null
  workspace: string
}

export interface ApplyProviderOptions {
  provider: string
  /** 写进三个角色（不传则保留各自现有的 key）。 */
  apiKey?: string
  /** 三个角色共用；传对象可以分别指定。 */
  model?: string | Partial<Record<RoleName, string>>
  /** 自定义端点（ollama / 自建网关常用）。 */
  baseUrl?: string
}

export interface ApplyProviderResult {
  state: ProviderState
  /** 实际改了哪些角色。 */
  changed: RoleName[]
  /** 写回文件失败时的原因（内存里仍然生效）。 */
  persistError?: string
  /** 提示信息，比如"还没填 key"。 */
  warnings: string[]
}

function keyLooksSet(role: { apiKey: string; provider: string }): boolean {
  return Boolean(role.apiKey && role.apiKey.trim())
}

/** 下拉用的清单：当前在用的那家会被标出来（但列表本身只是选项）。 */
function buildCatalog(active: string): CatalogItem[] {
  return PROVIDER_CATALOG.map((entry) => ({
    id: entry.id,
    label: catalogLabel(entry),
    name: entry.name,
    site: entry.site,
    baseUrl: entry.baseUrl,
    model: entry.model ?? '',
    needsRoute: entry.needsRoute === true,
    current: entry.id === active,
  }))
}

export function listProviders(config: AppConfig): ProviderState {
  const active = config.roles.planner.provider
  /**
   * 用户在界面上"真的配置过"的供应商：
   * 当前正在用的那家，或者某个角色以前填过 key 的那家（keyHistory）。
   * 其余的都是代码里自带的内置预设——界面上要和"我自己的"分开显示，
   * 否则用户会以为 deepseek/openai/lmstudio 这些是他自己建的。
   */
  const configuredIds = new Set<string>([active])
  for (const role of ROLE_NAMES) {
    const history = config.roles[role].keyHistory ?? {}
    for (const [id, key] of Object.entries(history)) {
      if (key && key.trim()) configuredIds.add(id)
    }
  }

  const providers: ProviderEntry[] = Object.entries(PROVIDER_PRESETS).map(([id, preset]) => ({
    id,
    label: preset.model ? `${id} · ${preset.model}` : id,
    baseUrl: preset.baseUrl,
    model: preset.model,
    envKey: preset.envKey,
    active: id === active,
    configured: configuredIds.has(id),
    hasKey: keyLooksSet(config.roles.planner) || Boolean(preset.envKey && process.env[preset.envKey]),
  }))

  // 配置里用了非预设的端点（自建网关）也要能看见
  if (!PROVIDER_PRESETS[active]) {
    providers.unshift({
      id: active,
      label: `${active} · ${config.roles.planner.model}`,
      baseUrl: config.roles.planner.baseUrl,
      model: config.roles.planner.model,
      envKey: '',
      active: true,
      configured: true,
      hasKey: keyLooksSet(config.roles.planner),
    })
  }

  return {
    providers,
    catalog: buildCatalog(active),
    current: {
      provider: active,
      model: config.roles.planner.model,
      baseUrl: config.roles.planner.baseUrl,
      hasKey: keyLooksSet(config.roles.planner),
      mock: ROLE_NAMES.every((role) => config.roles[role].mock),
    },
    configPath: config.path || null,
    // 后端干活用的目录（跟着 VS Code 当前打开的文件夹）
    workspace: config.workspace || config.root,
  }
}

function modelFor(role: RoleName, model: ApplyProviderOptions['model'], fallback: string): string {
  if (!model) return fallback
  if (typeof model === 'string') return model
  return model[role] ?? fallback
}

export function applyProvider(config: AppConfig, options: ApplyProviderOptions): ApplyProviderResult {
  // 清单里的平台优先（地址/模型可能和旧的预设表不同）
  const catalog = findCatalogEntry(options.provider)
  const preset = catalog
    ? { baseUrl: catalog.baseUrl, model: catalog.model ?? '', envKey: catalog.envKey ?? '' }
    : PROVIDER_PRESETS[options.provider]
  if (!preset) {
    throw new Error(
      `未知供应商 "${options.provider}"。可选：${Object.keys(PROVIDER_PRESETS).join(' / ')}`,
    )
  }

  const baseUrl = (options.baseUrl ?? preset.baseUrl).replace(/\/+$/, '')
  const changed: RoleName[] = []
  const warnings: string[] = []

  for (const role of ROLE_NAMES) {
    const target = config.roles[role]
    target.provider = options.provider
    target.baseUrl = baseUrl
    target.model = modelFor(role, options.model, preset.model)
    target.mock = false
    if (options.apiKey !== undefined) target.apiKey = options.apiKey.trim()
    changed.push(role)
  }

  const planner = config.roles.planner
  if (!planner.apiKey && preset.envKey && !process.env[preset.envKey]) {
    warnings.push(`还没有 API key：把它填进 ${preset.envKey} 环境变量，或在下一次切换时直接粘贴 key。`)
  }

  const target = config.path || join(config.workspace || config.root, 'qzcode.json')
  const result: ApplyProviderResult = { state: listProviders(config), changed, warnings }
  const persistError = persist(config, target)
  if (persistError) {
    result.persistError = persistError
  } else {
    config.path = target
    result.state.configPath = target
    warnings.push(`已写入 ${target}（含 apiKey，别提交到仓库）`)
  }
  return result
}

/**
 * 尽量写回配置文件：保留文件里未知的字段，只覆盖 roles 与 provider 相关项。
 * 读不动（JSONC 注释、权限）就返回原因，让调用方告诉用户"只在内存生效"。
 */
export function persist(config: AppConfig, target = config.path): string | undefined {
  if (!target) return '还没有配置文件路径，改动只在内存里生效'
  let raw: Record<string, unknown> = {}
  try {
    const text = readFileSync(target, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : (error as Error).message
    if (message) return `配置文件读不动（${message}），改动只在内存里生效`
  }

  const existingRoles =
    raw.roles && typeof raw.roles === 'object' ? (raw.roles as Record<string, Record<string, unknown>>) : {}
  const roles: Record<string, unknown> = { ...existingRoles }
  for (const role of ROLE_NAMES) {
    const current = config.roles[role]
    roles[role] = {
      ...(existingRoles[role] ?? {}),
      provider: current.provider,
      baseUrl: current.baseUrl,
      model: current.model,
      apiKey: current.apiKey,
      keyHistory: { ...current.keyHistory },
      // 这几个以前漏了，改完面板重启就丢，这里一并写回
      temperature: current.temperature,
      maxTokens: current.maxTokens,
      headers: { ...current.headers },
      timeoutMs: current.timeoutMs,
      retries: current.retries,
      ...(current.maxSteps > 0 ? { maxSteps: current.maxSteps } : {}),
    }
  }
  raw.roles = roles
  if (raw.maxRounds === undefined) raw.maxRounds = config.maxRounds
  if (raw.plugins === undefined && config.plugins.length > 0) raw.plugins = config.plugins

  try {
    writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    return undefined
  } catch (error) {
    return `写配置文件失败（${(error as Error).message}），改动只在内存里生效`
  }
}

// --------------------------------------------------------------- 模型设置面板

/** 单个角色的完整模型配置（设置面板用）。 */
export interface RoleDetail {
  role: RoleName
  title: string
  provider: string
  baseUrl: string
  model: string
  hasKey: boolean
  /** 打码后的 key，只给人看。 */
  keyHint: string
  /** 这个角色勾选的技能。 */
  skills: string[]
  /** 当前这家供应商有没有 key（换供应商后不会复用别家的）。 */
  hasKeyForProvider: boolean
  /** 存过 key 的供应商清单。 */
  storedKeyProviders: string[]
  temperature: number
  maxTokens: number
  maxSteps: number
  /** 自定义请求头（自建网关常用来带网关 key / 组织 id）。 */
  headers: Record<string, string>
  timeoutMs: number
  retries: number
  mock: boolean
  /** 这个 provider 不在预设清单里 = 全手填的自定义供应商。 */
  custom: boolean
}

export interface RolesState {
  /** 供应商下拉清单（只是选项，不代表已配置）。 */
  catalog?: unknown[]
  roles: RoleDetail[]
  providers: ProviderEntry[]
  configPath: string | null
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}****`
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export function listRoles(config: AppConfig): RolesState {
  return {
    providers: listProviders(config).providers,
    // 下拉用的供应商清单（缺了它设置面板里只剩当前这一家）
    catalog: listProviders(config).catalog,
    configPath: config.path || null,
    roles: ROLE_NAMES.map((role) => {
      const current = config.roles[role]
      return {
        role,
        title: ROLE_TITLES[role],
        provider: current.provider,
        baseUrl: current.baseUrl,
        model: current.model,
        hasKey: Boolean(current.apiKey),
        keyHint: maskKey(current.apiKey),
        skills: [...(current.skills ?? [])],
        hasKeyForProvider: Boolean(current.keyHistory?.[current.provider] ?? current.apiKey),
        storedKeyProviders: Object.keys(current.keyHistory ?? {}).filter(
          (provider) => current.keyHistory[provider],
        ),
        temperature: current.temperature,
        maxTokens: current.maxTokens,
        maxSteps: current.maxSteps,
        headers: { ...current.headers },
        timeoutMs: current.timeoutMs,
        retries: current.retries,
        mock: current.mock,
        custom: !PROVIDER_PRESETS[current.provider],
      }
    }),
  }
}

export interface RolePatch {
  role: RoleName
  provider?: string
  baseUrl?: string
  model?: string
  /** 传空字符串表示清掉 key；不传表示不动。 */
  apiKey?: string
  temperature?: number
  maxTokens?: number
  maxSteps?: number
  /** 自定义请求头：传进来就整体替换（传 {} 表示清空）。 */
  headers?: Record<string, string>
  timeoutMs?: number
  retries?: number
  /** 这个角色启用的技能（传空数组 = 交回"按技能声明的 roles 自动生效"）。 */
  skills?: string[]
  mock?: boolean
}

export interface ApplyRoleResult {
  state: RolesState
  persistError?: string
  warnings: string[]
}

function cleanHeaders(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object') return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const name = String(key ?? '').trim()
    if (!name) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    out[name] = String(value).trim()
  }
  return out
}

/** 改单个角色的模型配置（内存生效 + 尽量写回配置）。 */
export function applyRole(config: AppConfig, patch: RolePatch): ApplyRoleResult {
  const role = patch.role
  if (!ROLE_NAMES.includes(role)) throw new Error(`未知角色: ${String(role)}`)
  const target = config.roles[role]
  const warnings: string[] = []

  if (patch.provider !== undefined) {
    const name = patch.provider.trim()
    if (!name) throw new Error('provider 不能为空（自定义供应商也要给个名字，比如 my-gateway）')
    const preset = PROVIDER_PRESETS[name]
    // 预设之外的 id 允许存在，但必须自带 baseUrl —— 这就是"全手填"
    if (!preset && !(patch.baseUrl ?? '').trim()) {
      throw new Error(`自定义供应商 "${name}" 必须填接口地址（baseUrl），否则不知道往哪发请求`)
    }
    const previous = target.provider
    target.provider = name
    if (preset) {
      target.baseUrl = (patch.baseUrl ?? preset.baseUrl).replace(/\/+$/, '')
      // 换供应商时模型跟着预设走，除非调用方明确指定
      if (patch.model === undefined) target.model = preset.model
    }
    // 换供应商时必须换 key：先在历史里找这家的，找不到就清空等用户填
    if (name !== previous && patch.apiKey === undefined) {
      const remembered = target.keyHistory[name]
      target.apiKey = remembered ?? ''
      if (!remembered) {
        warnings.push(`已切换到 ${name}：还没有这家的 key，请填写后保存（不会复用 ${previous} 的 key）`)
      }
    }
  }
  if (patch.baseUrl !== undefined) target.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '')
  if (patch.model !== undefined) target.model = patch.model.trim()
  if (patch.apiKey !== undefined) {
    target.apiKey = patch.apiKey.trim()
    if (target.apiKey) {
      target.keyHistory = { ...target.keyHistory, [target.provider]: target.apiKey }
    } else {
      const nextHistory = { ...target.keyHistory }
      delete nextHistory[target.provider]
      target.keyHistory = nextHistory
    }
  }
  if (patch.temperature !== undefined) target.temperature = Math.max(0, Math.min(2, patch.temperature))
  if (patch.maxTokens !== undefined) target.maxTokens = Math.max(256, Math.min(200_000, Math.trunc(patch.maxTokens)))
  if (patch.maxSteps !== undefined) target.maxSteps = Math.max(1, Math.min(200, Math.trunc(patch.maxSteps)))
  if (patch.headers !== undefined) target.headers = cleanHeaders(patch.headers)
  if (patch.timeoutMs !== undefined) target.timeoutMs = Math.max(1000, Math.min(3_600_000, Math.trunc(patch.timeoutMs)))
  if (patch.retries !== undefined) target.retries = Math.max(0, Math.min(10, Math.trunc(patch.retries)))
  if (patch.skills !== undefined) {
    target.skills = patch.skills.map((name) => name.trim()).filter(Boolean)
  }

  // 接口地址写歪了直接拒绝：否则只会得到一个"后端退出码 1"的黑盒错误
  if (!/^https?:\/\//i.test(target.baseUrl)) {
    throw new Error(
      `${role} 的接口地址必须是 http(s):// 开头，当前是 "${target.baseUrl || '(空)'}"。` +
        '常见错误：把模型名填进了接口地址，或把接口地址填进了 API key。',
    )
  }
  if (patch.mock !== undefined) target.mock = patch.mock

  if (!target.model) warnings.push(`${role} 的 model 是空的，真实模型跑不起来`)
  if (!target.apiKey && !target.mock) {
    const preset = PROVIDER_PRESETS[target.provider]
    warnings.push(
      preset?.envKey ? `${role} 还没有 key：填在面板里，或用环境变量 ${preset.envKey}` : `${role} 还没有 key`,
    )
  }

  const result: ApplyRoleResult = { state: listRoles(config), warnings }
  const target2 = config.path || join(config.workspace || config.root, 'qzcode.json')
  const persistError = persist(config, target2)
  if (persistError) result.persistError = persistError
  else {
    config.path = target2
    result.state.configPath = target2
  }
  return result
}

/** 把某个角色的模型配置复制给其它角色（"三个都用这套"）。 */
export function copyRole(config: AppConfig, from: RoleName, to: RoleName[]): ApplyRoleResult {
  const source = config.roles[from]
  const targets = to.filter((role) => role !== from)
  if (targets.length === 0) throw new Error('没有可复制的目标角色')
  const warnings: string[] = []
  let persistError: string | undefined
  for (const role of targets) {
    const result = applyRole(config, {
      role,
      provider: source.provider,
      baseUrl: source.baseUrl,
      model: source.model,
      apiKey: source.apiKey,
      temperature: source.temperature,
      maxTokens: source.maxTokens,
      headers: { ...source.headers },
      timeoutMs: source.timeoutMs,
      retries: source.retries,
      mock: source.mock,
    })
    warnings.push(...result.warnings)
    if (result.persistError) persistError = result.persistError
  }
  const out: ApplyRoleResult = { state: listRoles(config), warnings }
  if (persistError) out.persistError = persistError
  return out
}
