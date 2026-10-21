import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { EXAMPLE_CONFIG, normalizeConfig } from '../src/config.ts'
import type { AppConfig } from '../src/config.ts'
import type { TuiInputStream, TuiOutputStream } from '../src/tui/app.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

export function tempWorkspace(name: string): string {
  const dir = join(
    here,
    '.tmp',
    `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

export function removeDir(dir: string): void {
  // Windows 上刚被 kill 的子进程可能还占着 cwd，删目录会 EPERM：
  // 重试几次，最后还不行就交给系统（清理失败不该把测试判成失败）
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }
}

export function mockConfig(workspace: string, overrides: Record<string, unknown> = {}): AppConfig {
  return normalizeConfig({ ...EXAMPLE_CONFIG, ...overrides }, { mock: true, workspace })
}

export interface FakeTerminal {
  out: TuiOutputStream
  input: TuiInputStream
  send(text: string): void
  output(): string
  text(): string
}

export function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
}

/** A terminal that records what the TUI writes and lets a test type at it. */
export function fakeTerminal(columns = 110, rows = 34): FakeTerminal {
  let buffer = ''
  const listeners = new Set<(chunk: string) => void>()
  const out: TuiOutputStream = {
    columns,
    rows,
    write(chunk: string) {
      buffer += chunk
      return true
    },
    on() {
      return undefined
    },
    off() {
      return undefined
    },
  }
  const input: TuiInputStream = {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
    on(_event: 'data', listener: (chunk: string) => void) {
      listeners.add(listener)
      return undefined
    },
    off(_event: 'data', listener: (chunk: string) => void) {
      listeners.delete(listener)
      return undefined
    },
  }
  return {
    out,
    input,
    send(text: string) {
      for (const listener of [...listeners]) listener(text)
    },
    output: () => buffer,
    text: () => stripAnsi(buffer),
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
