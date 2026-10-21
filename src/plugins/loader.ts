import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppConfig } from '../config.ts'
import type { Context, Logger, PluginRecord } from '../kernel.ts'
import { pluginName } from '../kernel.ts'
import type { AnyPlugin } from '../kernel.ts'
import type { LlmClient } from '../llm.ts'
import { createClient } from '../llm.ts'
import type { ToolSpec, Toolbox } from '../tools.ts'

export interface PluginHostOptions {
  ctx: Context
  config: AppConfig
  toolbox: Toolbox
  logger: Logger
  notify(message: string, level?: 'info' | 'warn' | 'error'): void
}

/** Services a plugin can rely on: the same names a cordis plugin would inject. */
export interface HostServices {
  logger: Logger
  config: AppConfig
  tools: { register(tool: ToolSpec): void; list(): string[] }
  notify(message: string, level?: 'info' | 'warn' | 'error'): void
  fs: {
    read(path: string): string
    write(path: string, content: string): void
    exists(path: string): boolean
  }
  llm: { create(role: 'planner' | 'implementer' | 'verifier'): LlmClient }
  /** Marker so DSH-aware plugins can tell they are not inside the real harness. */
  dsh: { host: 'qzcode'; version: string; compatible: boolean }
}

let resolverRegistered = false
let resolverRoot = ''

/**
 * Registers the @deepseek-ai/* resolver once per process. Returns false when the
 * hook could not be installed (Node < 20.6, disabled loaders, ...).
 */
export function enableDshResolution(appDir: string): boolean {
  if (resolverRegistered && resolverRoot === appDir) return true
  try {
    register(new URL('./dsh-resolver.mjs', import.meta.url), {
      parentURL: pathToFileURL(`${join(appDir, 'index.js')}`).href,
      data: { root: appDir },
    })
    resolverRegistered = true
    resolverRoot = appDir
    return true
  } catch {
    return false
  }
}

/** Best-effort discovery of a local DeepSeek Harness install. */
export function detectDshAppDir(): string | null {
  const fromEnv = process.env.QZCODE_DSH_ROOT ?? process.env.DSH_APP_DIR ?? ''
  if (fromEnv && existsSync(fromEnv)) return normalizeAppDir(fromEnv)

  const candidates: string[] = []
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    candidates.push(join(local, 'Programs', 'DSH Desktop', 'resources', 'app'))
    candidates.push(join(local, 'Programs', 'deepseek-harness', 'resources', 'app'))
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    candidates.push(join(pf, 'DSH Desktop', 'resources', 'app'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/DSH Desktop.app/Contents/Resources/app')
    candidates.push(join(homedir(), 'Applications', 'DSH Desktop.app', 'Contents', 'Resources', 'app'))
  } else {
    candidates.push(join(homedir(), '.local', 'share', 'dsh-desktop', 'resources', 'app'))
    candidates.push('/opt/DSH Desktop/resources/app')
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules', '@deepseek-ai'))) return candidate
  }
  return null
}

function normalizeAppDir(dir: string): string {
  return basename(dir) === 'node_modules' ? dirname(dir) : dir
}

function installHostServices(options: PluginHostOptions): void {
  const { ctx, config, toolbox, logger, notify } = options
  const services: HostServices = {
    logger,
    config,
    tools: {
      register(tool: ToolSpec) {
        toolbox.register(tool)
        ctx.emit('tool:registered', tool.name)
      },
      list() {
        return toolbox.list().map((tool) => tool.name)
      },
    },
    notify,
    fs: {
      read(path: string) {
        return readFileSync(resolve(config.workspace, path), 'utf8')
      },
      write(path: string, content: string) {
        writeFileSync(resolve(config.workspace, path), content, 'utf8')
      },
      exists(path: string) {
        return existsSync(resolve(config.workspace, path))
      },
    },
    llm: {
      create(role) {
        return createClient(config.roles[role])
      },
    },
    dsh: { host: 'qzcode', version: '0.1.0', compatible: false },
  }
  for (const [name, value] of Object.entries(services)) {
    if (!ctx.provides(name)) ctx.set(name, value)
  }
}

/** Unwraps the many shapes a plugin module can take. */
function unwrapPlugin(module: Record<string, unknown>): AnyPlugin | null {
  const candidate = (module.default ?? module) as unknown
  if (typeof candidate === 'function') return candidate as AnyPlugin
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>
    if (typeof record.apply === 'function') {
      return {
        name: typeof record.name === 'string' ? record.name : undefined,
        inject: Array.isArray(record.inject) ? (record.inject as string[]) : undefined,
        apply: record.apply as never,
      }
    }
    if (typeof record.default === 'function') return record.default as AnyPlugin
  }
  return null
}

function explainImportFailure(error: unknown, spec: string): string {
  const code = (error as { code?: string }).code
  const message = (error as Error).message ?? String(error)
  if (code === 'ERR_MODULE_NOT_FOUND' || message.includes('Cannot find package')) {
    const missing = message.match(/'([^']+)'/)?.[1] ?? ''
    if (missing.startsWith('@deepseek-ai/') || missing.startsWith('@earendil-works/')) {
      return `依赖 ${missing} 属于 DeepSeek Harness 运行时，未能在本机找到。设置 config.dshNodeModules 指向 DSH 安装目录（含 node_modules）。`
    }
    return `缺少依赖 ${missing || '(未知)'}；先在该插件所在目录安装依赖。`
  }
  if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    return `插件用了 Node 类型剥离不支持的类型语法（enum/namespace/参数属性）：${message}`
  }
  return `${spec}: ${message}`
}

export async function loadPlugins(options: PluginHostOptions): Promise<PluginRecord[]> {
  const { ctx, config, logger, toolbox } = options
  installHostServices(options)
  const records: PluginRecord[] = []
  const seen = new Set<string>()

  const dshDir = config.dshNodeModules ? normalizeAppDir(config.dshNodeModules) : detectDshAppDir()
  if (dshDir) enableDshResolution(dshDir)

  for (const spec of config.plugins) {
    if (seen.has(spec)) continue
    seen.add(spec)
    const fallbackName = basename(spec).replace(/\.(?:[cm]?ts|[cm]?js)$/i, '')
    const isPath = spec.startsWith('.') || isAbsolute(spec) || spec.startsWith('file:')
    const target = spec.startsWith('file:')
      ? spec
      : isPath
        ? pathToFileURL(isAbsolute(spec) ? spec : resolve(config.root, spec)).href
        : spec

    try {
      const module = (await import(target)) as Record<string, unknown>
      const plugin = unwrapPlugin(module)
      if (!plugin) {
        records.push({
          name: fallbackName,
          source: spec,
          status: 'failed',
          detail: '模块没有导出插件（需要 default 函数或 { apply } 对象）',
        })
        continue
      }
      const record: PluginRecord = { name: pluginName(plugin, fallbackName), source: spec, status: 'active' }
      ctx.plugin(plugin)
      records.push(record)
      logger.info(`plugin loaded: ${record.name} (${spec})`)
    } catch (error) {
      const detail = explainImportFailure(error, spec)
      records.push({ name: fallbackName, source: spec, status: 'failed', detail })
      logger.error(`plugin failed: ${spec}`, detail)
    }
  }

  ctx.records.push(...records)
  ctx.emit('plugins:loaded', records)
  void toolbox
  return records
}
