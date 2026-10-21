import type { AppConfig } from './config.ts'

/** A `/command` that extensions can add, mirroring pi's `pi.registerCommand()`. */
export interface CommandContext {
  notify(message: string, level?: 'info' | 'warn' | 'error'): void
  config: AppConfig
}

export interface CommandDef {
  /** Without the leading slash. */
  name: string
  description: string
  handler: (args: string, context: CommandContext) => unknown | Promise<unknown>
}

export function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, '').toLowerCase()
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDef>()

  register(def: CommandDef): void {
    const name = normalizeCommandName(def.name)
    if (!name) throw new Error('命令名不能为空')
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      throw new Error(`命令名只能包含字母、数字、下划线和短横线: ${def.name}`)
    }
    this.commands.set(name, { ...def, name })
  }

  get(name: string): CommandDef | undefined {
    return this.commands.get(normalizeCommandName(name))
  }

  has(name: string): boolean {
    return this.commands.has(normalizeCommandName(name))
  }

  list(): CommandDef[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}
