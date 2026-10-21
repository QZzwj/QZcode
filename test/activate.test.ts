import assert from 'node:assert/strict'
import Module from 'node:module'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * 真跑一次 extension.cjs 的 activate()：用假 vscode 模块，验证
 * ① 不抛错（TDZ、require 路径这类只在运行时炸的问题）
 * ② 每个贡献的命令都真的注册上了（否则就是 "command not found"）
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const disposable = (): { dispose(): void } => ({ dispose() {} })

type UriLike = { fsPath: string; scheme: string; toString(): string }
const uri = (p: string): UriLike => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` })

function createStub() {
  const registered: string[] = []

  const vscode = {
    version: 'test',
    Uri: {
      file: uri,
      joinPath: (base: UriLike, ...parts: string[]): UriLike =>
        uri([base.fsPath, ...parts].join('/').replace(/\/+/g, '/')),
      parse: (text: string) => ({ toString: () => text }),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, One: 1 },
    ThemeColor: class {},
    EventEmitter: class {
      event(): { dispose(): void } {
        return disposable()
      }
      fire(): void {}
    },
    window: {
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' }),
      createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
      registerWebviewViewProvider: () => disposable(),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      setStatusBarMessage: () => disposable(),
      createWebviewPanel: () => ({
        webview: {
          html: '',
          cspSource: 'x',
          options: {},
          asWebviewUri: (target: unknown) => target,
          onDidReceiveMessage: () => disposable(),
          postMessage: async () => true,
        },
        onDidDispose: () => disposable(),
        reveal() {},
        dispose() {},
      }),
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: () => disposable(),
    },
    workspace: {
      workspaceFolders: [{ uri: uri(repoRoot) }],
      getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
      onDidChangeConfiguration: () => disposable(),
      onDidChangeWorkspaceFolders: () => disposable(),
      openTextDocument: async () => ({ uri: uri(repoRoot) }),
      onDidSaveTextDocument: () => disposable(),
    },
    commands: {
      registerCommand: (id: string) => {
        registered.push(id)
        return disposable()
      },
      executeCommand: async () => undefined,
    },
    env: { openExternal: async () => true },
    l10n: { t: (text: string) => text },
  }

  return { vscode, registered }
}

test('activate() 不抛错，且每个贡献的命令都注册上了', async () => {
  const { vscode, registered } = createStub()

  const loader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const originalLoad = loader._load
  loader._load = function patched(this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') return vscode
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    const require2 = createRequire(import.meta.url)
    const entry = require2.resolve('../vscode/extension.cjs')
    delete require2.cache[entry]
    const ext = require2(entry) as {
      activate(context: unknown): Promise<void>
      deactivate?(): void
    }

    const context = {
      extensionPath: join(repoRoot, 'vscode'),
      extensionUri: uri(join(repoRoot, 'vscode')),
      globalStorageUri: uri(join(repoRoot, '.tmp-global')),
      subscriptions: [] as { dispose(): void }[],
      extension: { packageJSON: { version: '0.0.0-test' } },
    }

    await ext.activate(context)

    const manifest = JSON.parse(readFileSync(join(repoRoot, 'vscode', 'package.json'), 'utf8')) as {
      contributes: { commands: { command: string }[] }
    }
    for (const item of manifest.contributes.commands) {
      assert.ok(registered.includes(item.command), `命令没注册上（会 command not found）：${item.command}`)
    }

    ext.deactivate?.()
  } finally {
    loader._load = originalLoad
  }
})
