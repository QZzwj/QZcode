import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { ROLE_NAMES, type RoleName } from './config.ts'

/**
 * 技能（skill）= 一段可复用的方法论，按角色追加到系统提示词里。
 *
 * 文件格式（front matter 可选）：
 *   ---
 *   name: code-implementer
 *   title: 实现纪律（B）
 *   roles: implementer, verifier
 *   description: 一句话说明这个技能解决什么问题
 *   ---
 *   正文……
 *
 * 位置：
 *   - 内置：src/skills/*.md（随包发布）
 *   - 用户：<skillsDir>/*.md（导入进来的，扩展里放在 globalStorage）
 */

export interface Skill {
  name: string
  title: string
  description: string
  /** 这个技能适用于哪些角色（front matter 没写 = 全部）。 */
  roles: RoleName[]
  /** 正文（不含 front matter）。 */
  body: string
  source: 'builtin' | 'user'
  path: string
  /** 这个技能自带的参考资料（不内联进提示词，只给路径让模型按需 read）。 */
  references: { name: string; path: string }[]
}

const BUILTIN_DIR = new URL('./skills/', import.meta.url)

function asRoles(value: string | undefined): RoleName[] {
  if (!value) return ROLE_NAMES.slice()
  const wanted = value
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const roles = wanted.filter((item): item is RoleName => (ROLE_NAMES as readonly string[]).includes(item))
  return roles.length > 0 ? roles : ROLE_NAMES.slice()
}

/** 解析一份技能文本（front matter 可有可无）。 */
export function parseSkill(text: string, options: { name: string; source: 'builtin' | 'user'; path: string }): Skill {
  const normalized = text.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/)
  let meta: Record<string, string> = {}
  let body = normalized
  if (match) {
    body = normalized.slice(match[0].length)
    for (const line of match[1].split('\n')) {
      const at = line.indexOf(':')
      if (at <= 0) continue
      meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
  }
  const name = (meta.name || options.name).replace(/[^\w.-]+/g, '-').toLowerCase()
  return {
    name,
    title: meta.title || name,
    description: meta.description || '',
    roles: asRoles(meta.roles),
    body: body.trim(),
    source: options.source,
    path: options.path,
    references: [],
  }
}

function readDir(dir: string, source: 'builtin' | 'user'): Skill[] {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const skills: Skill[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      // 形态一：skills/<name>.md
      if (statSync(full).isFile() && extname(entry).toLowerCase() === '.md') {
        skills.push(parseSkill(readFileSync(full, 'utf8'), { name: basename(entry, '.md'), source, path: full }))
        continue
      }
      // 形态二：skills/<name>/SKILL.md（导入整个仓库时就是这个形状）
      if (statSync(full).isDirectory()) {
        const skillFile = ['SKILL.md', 'skill.md'].map((item) => join(full, item)).find((item) => existsSync(item))
        if (!skillFile) continue
        const skill = parseSkill(readFileSync(skillFile, 'utf8'), { name: entry, source, path: skillFile })
        const refDir = join(full, 'references')
        if (existsSync(refDir) && statSync(refDir).isDirectory()) {
          skill.references = readdirSync(refDir)
            .filter((item) => extname(item).toLowerCase() === '.md')
            .map((item) => ({ name: basename(item, '.md'), path: join(refDir, item) }))
        }
        skills.push(skill)
      }
    } catch {
      // 单个条目读不动不影响其它技能
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** 列出全部可用技能（内置 + 用户目录）。同名时用户目录优先。 */
export function listSkills(userDir?: string | null): Skill[] {
  const builtin = readDir(BUILTIN_DIR.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'builtin')
  const user = userDir ? readDir(userDir, 'user') : []
  const byName = new Map<string, Skill>()
  for (const skill of builtin) byName.set(skill.name, skill)
  for (const skill of user) byName.set(skill.name, skill)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 某个角色能用的技能：
 * - 内置技能只要 front matter 的 roles 命中就生效（勾选列表不会把它们挤掉）
 * - 用户导入的技能同样要角色命中，并且当 allow 非空时必须被勾中
 *   （勾选列表为空 = 导入的技能按自己声明的 roles 自动生效）
 */
export function skillsForRole(role: RoleName, skills: Skill[], allow?: string[]): Skill[] {
  const applicable = skills.filter((skill) => skill.roles.includes(role))
  const wanted = new Set(allow ?? [])
  return applicable.filter((skill) => {
    if (skill.source === 'builtin') return true
    return wanted.size === 0 ? true : wanted.has(skill.name)
  })
}

/** 拼成系统提示词追加段。 */
export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return ''
  return skills
    .map((skill) => {
      const parts = [`## 技能：${skill.title || skill.name}`, skill.body]
      if (skill.references.length > 0) {
        parts.push(
          [
            '### 这个技能自带的参考资料（不要一次性全读）',
            '只在需要时用 read 工具打开对应文件：',
            ...skill.references.map((ref) => `- ${ref.name}: ${ref.path}`),
          ].join('\n'),
        )
      }
      return parts.join('\n\n')
    })
    .join('\n\n')
}

/** 把 roles 合并进已有 front matter；没有 front matter 就新建一个。 */
function withRolesFrontMatter(text: string, roles: string): string {
  // BOM / CRLF 必须先归一化，否则"看起来有 front matter"却匹配不上，会叠成两块
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const hasFrontMatter = /^---\n[\s\S]*?\n---\n?/.test(clean)
  const hasRoles = hasFrontMatter && /^---\n[\s\S]*?roles\s*:/m.test(clean)
  if (hasRoles) return clean
  if (hasFrontMatter) return clean.replace(/^---\n/, `---\nroles: ${roles}\n`)
  return `---\nroles: ${roles}\n---\n${clean}`
}

export interface ImportResult {
  ok: boolean
  skill?: Skill
  error?: string
  path?: string
}

/** 把外部技能导入用户目录（支持本地路径 / 链接 / 直接粘贴文本）。 */
export async function importSkill(options: {
  userDir: string
  source: 'path' | 'url' | 'text'
  value: string
  name?: string
  roles?: string
}): Promise<ImportResult> {
  try {
    let text = ''
    let suggested = options.name ?? ''

    if (options.source === 'text') {
      text = options.value
      suggested = suggested || 'imported-skill'
    } else if (options.source === 'path') {
      const target = resolve(options.value.trim())
      if (!existsSync(target)) return { ok: false, error: `找不到路径：${target}` }
      const stat = statSync(target)
      if (stat.isDirectory()) {
        // 目录里找 SKILL.md / skill.md / 第一个 md
        const candidates = ['SKILL.md', 'skill.md', 'README.md']
        const found = candidates.map((item) => join(target, item)).find((item) => existsSync(item))
        const fallback = readdirSync(target).find((item) => extname(item).toLowerCase() === '.md')
        const file = found ?? (fallback ? join(target, fallback) : null)
        if (!file) return { ok: false, error: `目录里没有 markdown 文件：${target}` }
        text = readFileSync(file, 'utf8')
        suggested = suggested || basename(target)
        // 整棵树复制过去，references/ 才会一起进来
        const destDir = join(options.userDir, suggested)
        cpSync(target, destDir, { recursive: true, force: true })
        const copiedSkill = ['SKILL.md', 'skill.md']
          .map((item) => join(destDir, item))
          .find((item) => existsSync(item))
        // 复制过来之后再把 roles 写进 front matter（不然导入的技能会默认全角色）
        if (copiedSkill) writeFileSync(copiedSkill, withRolesFrontMatter(readFileSync(copiedSkill, 'utf8'), options.roles || 'implementer, verifier'), 'utf8')
        const parsed = parseSkill(readFileSync(copiedSkill ?? file, 'utf8'), {
          name: suggested,
          source: 'user',
          path: copiedSkill ?? join(destDir, basename(file)),
        })
        const refDir = join(destDir, 'references')
        if (existsSync(refDir)) {
          parsed.references = readdirSync(refDir)
            .filter((item) => extname(item).toLowerCase() === '.md')
            .map((item) => ({ name: basename(item, '.md'), path: join(refDir, item) }))
        }
        return { ok: true, skill: parsed, path: destDir }
      } else {
        text = readFileSync(target, 'utf8')
        suggested = suggested || basename(target, extname(target))
      }
    } else {
      const response = await fetch(options.value.trim(), { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) return { ok: false, error: `下载失败：HTTP ${response.status}` }
      text = await response.text()
      suggested = suggested || basename(new URL(options.value).pathname, '.md') || 'imported-skill'
    }

    if (!text.trim()) return { ok: false, error: '内容为空' }

    // 没写 roles 的导入技能默认只给 B/C；已有 front matter 就把 roles 合并进去，别叠两个块
    // 没写 roles 的导入技能默认只给 B/C
    const withRoles = withRolesFrontMatter(text, options.roles || 'implementer, verifier')

    const skill = parseSkill(withRoles, {
      name: suggested || 'imported-skill',
      source: 'user',
      path: join(options.userDir, `${suggested || 'imported-skill'}.md`),
    })

    mkdirSync(options.userDir, { recursive: true })
    const target = join(options.userDir, `${skill.name}.md`)
    writeFileSync(target, withRoles, 'utf8')
    return { ok: true, skill: { ...skill, path: target }, path: target }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}
