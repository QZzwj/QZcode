import { existsSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROLE_NAMES, ROLE_TITLES, type AppConfig, type RoleName } from './config.ts'
import { listSkills } from './skills.ts'
import { resolveShell } from './tools.ts'

/**
 * 体检：把所有"你踩到才发现"的环境问题，一条命令说清楚。
 * 只读 + 一次极小的网络探测，不写任何配置。
 */

export type CheckLevel = 'ok' | 'warn' | 'error'

export interface Check {
  id: string
  name: string
  level: CheckLevel
  detail: string
  /** 有问题时给出可执行的下一步。 */
  fix?: string
}

export interface DoctorResult {
  ok: boolean
  checks: Check[]
  summary: { ok: number; warn: number; error: number }
}

export interface DoctorOptions {
  config: AppConfig
  /** 是否做网络探测（/models）。默认 true，单角色超时 6s。 */
  network?: boolean
  skillsDir?: string | null
}

function roleCheck(config: AppConfig, role: RoleName): Check {
  const current = config.roles[role]
  const name = `角色 ${role}（${ROLE_TITLES[role]}）`
  const problems: string[] = []

  if (!current.model?.trim()) problems.push('没有模型名')
  if (!/^https?:\/\//i.test(current.baseUrl ?? '')) problems.push(`接口地址不是 http(s)：${current.baseUrl || '(空)'}`)
  if (current.mock) {
    return {
      id: `role.${role}`,
      name,
      level: problems.length > 0 ? 'warn' : 'ok',
      detail: problems.length > 0 ? `${problems.join('；')}（当前是 mock，不影响试跑）` : 'mock 模式，不调真实端点',
    }
  }
  if (!current.apiKey) {
    return {
      id: `role.${role}`,
      name,
      level: 'error',
      detail: `${current.provider} 还没有 key`,
      fix: '设置面板里给这个角色填 key（换供应商不会复用别家的 key）',
    }
  }
  return {
    id: `role.${role}`,
    name,
    level: problems.length > 0 ? 'error' : 'ok',
    detail: problems.length > 0 ? problems.join('；') : `${current.provider} / ${current.model} → ${current.baseUrl}`,
    fix: problems.length > 0 ? '打开 QZcode 设置，改这一张卡片' : undefined,
  }
}

async function networkCheck(config: AppConfig, role: RoleName): Promise<Check | null> {
  const current = config.roles[role]
  if (current.mock || !current.apiKey) return null
  const base = current.baseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return null
  const name = `端点连通 ${role}`
  try {
    const response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${current.apiKey}`, ...current.headers },
      signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 160)
      return {
        id: `net.${role}`,
        name,
        level: response.status === 401 || response.status === 403 ? 'error' : 'warn',
        detail: `/models 返回 ${response.status}：${text || '(空)'}`,
        fix:
          response.status === 401 || response.status === 403
            ? `确认这个 key 属于 "${current.provider}" 这家供应商`
            : '端点可达但报错，检查模型名与额度',
      }
    }
    const payload = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null
    const models = (payload?.data ?? []).map((item) => String(item.id ?? '')).filter(Boolean)
    if (models.length > 0 && current.model && !models.includes(current.model)) {
      return {
        id: `net.${role}`,
        name,
        level: 'error',
        detail: `模型 "${current.model}" 不在端点清单里（端点有 ${models.length} 个）`,
        fix: '设置面板里点「获取模型」从清单里选一个',
      }
    }
    return {
      id: `net.${role}`,
      name,
      level: 'ok',
      detail: `可用，端点共 ${models.length} 个模型`,
    }
  } catch (error) {
    return {
      id: `net.${role}`,
      name,
      level: 'error',
      detail: `连不上：${(error as Error).message}`,
      fix: '检查地址/网络；公司网络可能需要代理',
    }
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const { config } = options
  const checks: Check[] = []

  // 1) 运行时
  const major = Number(process.version.replace(/^v/, '').split('.')[0])
  checks.push({
    id: 'runtime.node',
    name: 'Node 版本',
    level: major >= 18 ? 'ok' : 'error',
    detail: `${process.version}（${process.platform} ${process.arch}）`,
    fix: major >= 18 ? undefined : '升级到 Node 18+（仓库里直接跑 .ts 需要 22.19+）',
  })

  // 2) 配置
  const configPath = config.path || '(未指定)'
  checks.push({
    id: 'config.file',
    name: '配置文件',
    level: config.path && existsSync(config.path) ? 'ok' : 'warn',
    detail: config.path
      ? `${configPath}${existsSync(config.path) ? '' : '（不存在，用的是内置默认值）'}`
      : '没有配置文件，用内置默认值 + mock',
    fix: config.path && !existsSync(config.path) ? '命令面板 QZcode: 设置 → 保存一次会写出来' : undefined,
  })

  // 3) 工作区可写
  const workspace = config.workspace || config.root
  let writable = false
  let writeDetail = workspace
  try {
    if (existsSync(workspace) && statSync(workspace).isDirectory()) {
      const probe = join(workspace, `.qzcode-doctor-${Date.now()}.tmp`)
      writeFileSync(probe, 'ok', 'utf8')
      unlinkSync(probe)
      writable = true
    } else {
      writeDetail = `${workspace}（不存在）`
    }
  } catch (error) {
    writeDetail = `${workspace}（不可写：${(error as Error).message}）`
  }
  checks.push({
    id: 'workspace.write',
    name: '工作区可写',
    level: writable ? 'ok' : 'error',
    detail: writeDetail,
    fix: writable ? undefined : 'B 需要在这里创建/修改文件；换一个目录或修权限',
  })

  // 4) shell（B 的命令都从这走）
  try {
    const shell = resolveShell()
    const isBash = /bash/i.test(shell.file)
    checks.push({
      id: 'shell',
      name: 'bash 工具的 shell',
      level: 'ok',
      detail: `${shell.file}${isBash ? '（POSIX 命令可用）' : '（不是 bash：ls -la 这类会失败）'}`,
      fix: isBash ? undefined : '装 Git Bash，或设置 QZCODE_SHELL 指向 bash',
    })
  } catch (error) {
    checks.push({
      id: 'shell',
      name: 'bash 工具的 shell',
      level: 'error',
      detail: (error as Error).message,
    })
  }

  // 5) 四个角色
  for (const role of ROLE_NAMES) checks.push(roleCheck(config, role))

  // 6) 网络探测（可选）
  if (options.network !== false) {
    const results = await Promise.all(ROLE_NAMES.map((role) => networkCheck(config, role)))
    for (const result of results) if (result) checks.push(result)
  }

  // 7) 技能
  try {
    const skills = listSkills(options.skillsDir ?? config.skills.dir)
    const userSkills = skills.filter((skill) => skill.source === 'user')
    checks.push({
      id: 'skills',
      name: '技能',
      level: 'ok',
      detail: `${skills.length} 个（内置 ${skills.length - userSkills.length} / 导入 ${userSkills.length}）${
        config.skills.disabled.length > 0 ? `，已停用 ${config.skills.disabled.join('、')}` : ''
      }`,
    })
  } catch (error) {
    checks.push({ id: 'skills', name: '技能', level: 'warn', detail: (error as Error).message })
  }

  // 8) 插件
  checks.push({
    id: 'plugins',
    name: '插件',
    level: 'ok',
    detail: config.plugins.length > 0 ? `配置了 ${config.plugins.length} 个` : '没有插件',
    fix: config.plugins.length > 0 ? '插件是否真的加载成功，看 QZcode 输出面板 [plugins] 行' : undefined,
  })

  // 9) 保护性配置
  checks.push({
    id: 'guards',
    name: '安全阀',
    level: 'ok',
    detail: `轮次上限 ${config.maxRounds} · A 复核 ${
      config.review.enabled ? `开（最多退回 ${config.review.maxCorrections} 次）` : '关'
    } · L 分流 ${config.leader.enabled ? '开' : '关'} · 执行命令 ${config.exec.enabled ? '允许' : '禁止'}`,
  })

  const summary = { ok: 0, warn: 0, error: 0 }
  for (const check of checks) summary[check.level] += 1
  return { ok: summary.error === 0, checks, summary }
}

/** 把结果排成人读的顺序：先错误，再警告，最后正常。 */
export function sortChecks(checks: Check[]): Check[] {
  const order: Record<CheckLevel, number> = { error: 0, warn: 1, ok: 2 }
  return [...checks].sort((a, b) => order[a.level] - order[b.level])
}

export function formatDoctor(result: DoctorResult): string {
  const icon: Record<CheckLevel, string> = { ok: '[ok]', warn: '[!!]', error: '[XX]' }
  const lines = sortChecks(result.checks).map((check) => {
    const head = `${icon[check.level]} ${check.name}: ${check.detail}`
    return check.fix ? `${head}\n      → ${check.fix}` : head
  })
  const { ok, warn, error } = result.summary
  return [`QZcode 体检：${ok} 项正常、${warn} 项警告、${error} 项错误`, '', ...lines].join('\n')
}

/** 给测试/临时目录用：确保目录存在（体检会往里写探针文件再删）。 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
