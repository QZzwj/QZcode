/*
 * A small, cordis-shaped plugin kernel.
 *
 * "Everything is a plugin" only works when the host is a graph of contexts, not a
 * monolith. This kernel is deliberately tiny: a context tree, a service registry,
 * an event bus, and effect disposal. Its surface mirrors the parts of
 * @deepseek-ai/cordis that real harness plugins actually touch, so a plugin written
 * against this API is one adapter away from running inside DeepSeek Harness, and a
 * plain cordis plugin can usually be loaded here unchanged.
 *
 * API parity notes (see docs/plugins.md):
 *   ctx.plugin(fn, config)   -> mounts a child scope, returns a disposer
 *   ctx.set(name, value)     -> registers a service on this context
 *   ctx.get<T>(name)         -> looks up a service, walking up to the root
 *   ctx.tools / ctx.llm ...  -> service access through property syntax
 *   ctx.on(evt, fn)          -> subscribe, returns a disposer
 *   ctx.emit(evt, ...args)   -> publish
 *   ctx.effect(dispose)      -> tie a cleanup to this scope's lifetime
 *   ctx.inject(['tools'], fn)-> run once the listed services exist
 */

export type Disposable = () => void

/**
 * A tool in pi's extension format (`pi.registerTool({...})`). The adapter below
 * accepts either pi's `execute(input, ctx) -> { content }` shape or qzcode's
 * native `run(args, runtime) -> { ok, output }` shape.
 */
export interface PiToolDefinition {
  name: string
  description?: string
  /** JSON Schema for the arguments. `schema` is accepted as an alias. */
  parameters?: Record<string, unknown>
  schema?: Record<string, unknown>
  execute?(input: Record<string, unknown>, ctx: unknown): unknown
  run?(
    input: Record<string, unknown>,
    runtime: unknown,
  ): { ok: boolean; output: string } | Promise<{ ok: boolean; output: string }>
  annotations?: { readOnlyHint?: boolean }
  readOnly?: boolean
}

function piContentToText(result: unknown): { ok: boolean; output: string } {
  if (typeof result === 'string') return { ok: true, output: result }
  if (!result || typeof result !== 'object') return { ok: true, output: String(result ?? '') }
  const record = result as Record<string, unknown>
  const content = record.content
  const text = Array.isArray(content)
    ? content
        .map((part) => {
          if (typeof part === 'string') return part
          if (part && typeof part === 'object') {
            const entry = part as Record<string, unknown>
            if (typeof entry.text === 'string') return entry.text
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
    : typeof content === 'string'
      ? content
      : typeof record.output === 'string'
        ? record.output
        : JSON.stringify(result)
  return { ok: record.isError === true ? false : true, output: text }
}


export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export type PluginFn<C = unknown> = (
  ctx: Context,
  config: C,
) => void | Disposable | Promise<void | Disposable>

export interface PluginObject<C = unknown> {
  name?: string
  /** Services this plugin needs before it can run. */
  inject?: string[]
  apply: PluginFn<C>
}

export type AnyPlugin<C = unknown> = PluginFn<C> | PluginObject<C>

export interface PluginRecord {
  name: string
  source: string
  status: 'active' | 'skipped' | 'failed'
  detail?: string
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function bindLogger(base: Logger, scope: string): Logger {
  const tag = `[${scope}]`
  return {
    debug: (...a) => base.debug(tag, ...a),
    info: (...a) => base.info(tag, ...a),
    warn: (...a) => base.warn(tag, ...a),
    error: (...a) => base.error(tag, ...a),
  }
}

export function pluginName(plugin: AnyPlugin, fallback = 'anonymous'): string {
  const name = typeof plugin === 'function' ? plugin.name : plugin.name || plugin.apply.name
  // ESM gives anonymous default exports the name "default"; that is not a plugin name.
  if (!name || name === 'default' || name === 'anonymous') return fallback
  return name
}

export class Context {
  readonly name: string
  readonly parent: Context | null
  readonly logger: Logger
  /** Populated by the loader so `plugins list` can report provenance. */
  readonly records: PluginRecord[] = []

  private _services = new Map<string, unknown>()
  private _listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private _hooks = new Map<string, ((value: unknown, meta?: unknown) => unknown)[]>()
  private _children = new Set<Context>()
  private _effects: Disposable[] = []
  private _disposed = false

  constructor(name = 'root', parent: Context | null = null, logger: Logger = silentLogger) {
    this.name = name
    this.parent = parent
    this.logger = parent ? bindLogger(parent.logger, name) : bindLogger(logger, name)
  }

  // ---------------------------------------------------------------- services

  set<T>(name: string, value: T): T {
    this._services.set(name, value)
    this.emit('service', name, value)
    return value
  }

  provides(name: string): boolean {
    return this.lookup(name).found
  }

  get<T>(name: string): T {
    const hit = this.lookup(name)
    if (!hit.found) {
      throw new Error(`service "${name}" is not available in context "${this.name}"`)
    }
    return hit.value as T
  }

  /** Non-throwing accessor, handy in optional integrations. */
  tryGet<T>(name: string): T | undefined {
    const hit = this.lookup(name)
    return hit.found ? (hit.value as T) : undefined
  }

  private lookup(name: string): { found: boolean; value?: unknown } {
    let cursor: Context | null = this
    while (cursor) {
      if (cursor._services.has(name)) {
        return { found: true, value: cursor._services.get(name) }
      }
      cursor = cursor.parent
    }
    return { found: false }
  }

  // ------------------------------------------------------------------ events

  /**
   * Listeners live on the root context, so an event emitted by a plugin is
   * visible to the app and vice versa: one bus for the whole tree, scoped only
   * by lifetime. That is what cordis' events feel like in practice.
   */
  private get bus(): Map<string, Set<(...args: unknown[]) => void>> {
    return this.parent ? this.parent.bus : this._listeners
  }

  on(event: string, listener: (...args: any[]) => void): Disposable {
    // pi treats these two as gate/transform hooks (their return value matters),
    // so `pi.on("tool_call")` has to reach the hook chain, not the event bus.
    if (event === 'tool_call' || event === 'tool_result') {
      return this.hook(event, listener as (value: unknown, meta?: unknown) => unknown)
    }
    const bus = this.bus
    let bucket = bus.get(event)
    if (!bucket) {
      bucket = new Set()
      bus.set(event, bucket)
    }
    bucket.add(listener)
    return () => {
      bucket?.delete(listener)
      if (bucket && bucket.size === 0) bus.delete(event)
    }
  }

  once(event: string, listener: (...args: any[]) => void): Disposable {
    const off = this.on(event, (...args) => {
      off()
      listener(...args)
    })
    return off
  }

  emit(event: string, ...args: unknown[]): void {
    const bucket = this.bus.get(event)
    if (!bucket) return
    for (const listener of [...bucket]) {
      try {
        listener(...args)
      } catch (error) {
        this.logger.error(`listener for "${event}" threw`, error)
      }
    }
  }

  // --------------------------------------------------------------- lifecycle

  effect(dispose: Disposable): Disposable {
    if (this._disposed) {
      dispose()
      return dispose
    }
    this._effects.push(dispose)
    return () => {
      const index = this._effects.indexOf(dispose)
      if (index >= 0) this._effects.splice(index, 1)
      dispose()
    }
  }

  /** Mount a plugin in a child scope. */
  plugin<C>(plugin: AnyPlugin<C>, config?: C): Disposable {
    const name = pluginName(plugin as AnyPlugin, `plugin-${this._children.size + 1}`)
    const child = new Context(name, this, this.logger)
    this._children.add(child)
    const dispose = () => this.unmount(child)

    const fn: PluginFn<C> =
      typeof plugin === 'function' ? plugin : (plugin.apply.bind(plugin) as PluginFn<C>)
    const deps = typeof plugin === 'function' ? undefined : plugin.inject
    const args = (config ?? (typeof plugin === 'function' ? undefined : undefined)) as C

    const start = () => {
      try {
        const result = fn(child, args)
        if (result && typeof result === 'function') child.effect(result)
        else if (result && typeof (result as Promise<unknown>).then === 'function') {
          void (result as Promise<void | Disposable>).then(
            (later) => {
              if (typeof later === 'function') child.effect(later)
            },
            (error) => child.logger.error('plugin failed', error),
          )
        }
      } catch (error) {
        child.logger.error('plugin failed', error)
        this.unmount(child)
        throw error
      }
    }

    if (deps && deps.length > 0) {
      const off = this._waitFor(child, deps, start)
      child.effect(off)
    } else {
      start()
    }
    return dispose
  }

  private _waitFor(child: Context, deps: string[], run: () => void): Disposable {
    const missing = () => deps.filter((dep) => !child.provides(dep))
    if (missing().length === 0) {
      run()
      return () => {}
    }
    const off = this.on('service', () => {
      if (missing().length === 0) {
        off()
        run()
      }
    })
    return off
  }

  /** Convenience wrapper that reads like cordis' `ctx.inject([...], cb)`. */
  inject(deps: string[], run: (ctx: Context) => void): Disposable {
    return this.plugin(
      {
        name: `inject:${deps.join('+')}`,
        inject: deps,
        apply: (ctx) => {
          run(ctx)
        },
      },
      undefined,
    )
  }

  // ------------------------------------------------- pi-compatible surface
  // These let an extension written for pi (`export default (pi) => pi.registerTool(...)`)
  // run unchanged: the same object is also a cordis-style context.

  /** `pi.ui` equivalent. Notifications land in the TUI log strip and the debug log. */
  get ui(): { notify(message: string, level?: 'info' | 'warn' | 'error'): void } {
    const self = this
    return {
      notify(message: string, level: 'info' | 'warn' | 'error' = 'info') {
        const notify = self.tryGet<(text: string, kind?: string) => void>('notify')
        if (notify) notify(message, level)
        else self.logger.info(`[notify] ${message}`)
      },
    }
  }

  registerTool(definition: PiToolDefinition): string {
    const tools = this.tryGet<{ register(tool: unknown): void }>('tools')
    if (!tools) throw new Error('tools 服务不可用：宿主还没初始化？')
    if (!definition || typeof definition.name !== 'string' || !definition.name) {
      throw new Error('registerTool 需要 name')
    }
    if (typeof definition.execute !== 'function' && typeof definition.run !== 'function') {
      throw new Error(`工具 ${definition.name} 必须实现 execute() 或 run()`)
    }
    const self = this
    tools.register({
      name: definition.name,
      description: definition.description ?? '',
      parameters: definition.parameters ?? definition.schema ?? { type: 'object', properties: {} },
      readOnly: definition.annotations?.readOnlyHint ?? definition.readOnly ?? false,
      async run(args: Record<string, unknown>, runtime: { workspace?: string }) {
        if (typeof definition.run === 'function') return await definition.run(args, runtime)
        const result = await definition.execute?.(args, { ui: self.ui, cwd: runtime?.workspace })
        return piContentToText(result)
      },
    })
    this.emit('tool:registered', definition.name)
    return definition.name
  }

  registerCommand(
    name: string,
    definition: {
      description?: string
      handler: (args: string, ctx: { ui: { notify(message: string, level?: 'info' | 'warn' | 'error'): void } }) => unknown
    },
  ): string {
    const registry = this.tryGet<{ register(def: unknown): void }>('commands')
    if (!registry) throw new Error('commands 服务不可用：宿主还没初始化？')
    const self = this
    registry.register({
      name,
      description: definition.description ?? '',
      // 调用方的 notify 优先：这样命令的输出能回到「是谁按的 /命令」（HTTP 响应、TUI 状态行），
      // 而不是只进宿主启动时的日志。
      handler: (args: string, caller?: { notify?: (message: string, level?: string) => void }) =>
        definition.handler(args, {
          ui: {
            notify(message: string, level: 'info' | 'warn' | 'error' = 'info') {
              if (caller?.notify) caller.notify(message, level)
              else self.ui.notify(message, level)
            },
          },
        }),
    })
    this.emit('command:registered', name)
    return name
  }

  /** Async, ordered hook (pi's transform/gate events). Later handlers see earlier changes. */
  hook<T>(name: string, handler: (value: T, meta?: unknown) => unknown): Disposable {
    const root = this.rootCtx
    const list = root._hooks.get(name) ?? []
    list.push(handler as (value: unknown, meta?: unknown) => unknown)
    root._hooks.set(name, list)
    return () => {
      const bucket = root._hooks.get(name)
      if (!bucket) return
      const index = bucket.indexOf(handler as (value: unknown, meta?: unknown) => unknown)
      if (index >= 0) bucket.splice(index, 1)
      if (bucket.length === 0) root._hooks.delete(name)
    }
  }

  async runHook<T extends object>(name: string, value: T, meta?: unknown): Promise<T> {
    const list = this.rootCtx._hooks.get(name)
    if (!list || list.length === 0) return value
    let current: object = value
    for (const handler of [...list]) {
      const outcome = await handler(current, meta)
      if (outcome && typeof outcome === 'object') current = { ...current, ...(outcome as object) }
    }
    return current as T
  }

  get hasHooks(): boolean {
    return this.rootCtx._hooks.size > 0
  }

  private get rootCtx(): Context {
    return this.parent ? this.parent.rootCtx : this
  }

  private unmount(child: Context): void {
    if (!this._children.delete(child)) return
    child.dispose()
  }

  get children(): Context[] {
    return [...this._children]
  }

  get disposed(): boolean {
    return this._disposed
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    for (const child of [...this._children]) {
      this._children.delete(child)
      child.dispose()
    }
    for (const dispose of this._effects.splice(0).reverse()) {
      try {
        dispose()
      } catch (error) {
        this.logger.error('effect dispose failed', error)
      }
    }
    this._listeners.clear()
    this._hooks.clear()
    this._services.clear()
  }
}

/**
 * Context that exposes services as properties, so plugin code can write
 * `ctx.tools.register(...)` instead of `ctx.get('tools').register(...)`.
 */
export function createContext(name = 'root', logger: Logger = silentLogger): Context {
  const context = new Context(name, null, logger)
  return new Proxy(context, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver)
      if (prop in target) {
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return target.tryGet(prop)
    },
    has(target, prop) {
      if (typeof prop === 'string' && prop in target) return true
      if (typeof prop === 'string' && target.provides(prop)) return true
      return Reflect.has(target, prop)
    },
  }) as Context
}
