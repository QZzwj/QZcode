import Module from 'node:module'
import { createRequire } from 'node:module'

/** 用假 vscode 模块跑一次 activate()，看它到底注册了哪些命令、有没有抛错。 */

const registered = []
const disposables = []

function makeDisposable(onDispose) {
  return { dispose: onDispose ?? (() => {}) }
}

const vscodeStub = {
  version: '1.99.0-test',
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
    joinPath: (base, ...parts) => {
      const joined = [base.fsPath, ...parts].join('/').replace(/\/+/g, '/')
      return { fsPath: joined, scheme: 'file', toString: () => `file://${joined}` }
    },
    parse: (text) => ({ toString: () => text }),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1 },
  ThemeColor: class {},
  EventEmitter: class {
    constructor() {
      this.event = () => makeDisposable()
    }
    fire() {}
  },
  window: {
    createStatusBarItem: () => ({
      show() {},
      hide() {},
      dispose() {},
      text: '',
      tooltip: '',
      command: '',
    }),
    createOutputChannel: () => ({
      appendLine() {},
      append() {},
      show() {},
      dispose() {},
    }),
    registerWebviewViewProvider: () => {
      registered.push('registerWebviewViewProvider')
      return makeDisposable()
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    createWebviewPanel: () => ({
      webview: { html: '', cspSource: 'x', options: {}, asWebviewUri: (u) => u, onDidReceiveMessage: () => makeDisposable(), postMessage: async () => true },
      onDidDispose: () => makeDisposable(),
      reveal() {},
      dispose() {},
    }),
    setStatusBarMessage: () => makeDisposable(),
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => makeDisposable(),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'D:/example/qzcode' } }],
    getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
    onDidChangeConfiguration: () => makeDisposable(),
    onDidChangeWorkspaceFolders: () => makeDisposable(),
    openTextDocument: async () => ({}),
    onDidSaveTextDocument: () => makeDisposable(),
  },
  commands: {
    registerCommand: (id, handler) => {
      registered.push(id)
      void handler
      return makeDisposable()
    },
    executeCommand: async () => undefined,
  },
  env: { openExternal: async () => true },
  l10n: { t: (text) => text },
}

// 拦掉 require('vscode')
const originalLoad = Module._load
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub
  return originalLoad.call(this, request, parent, isMain)
}

const require2 = createRequire(import.meta.url)
const ext = require2('../vscode/extension.cjs')

const context = {
  extensionPath: 'D:/example/qzcode/vscode',
  extensionUri: vscodeStub.Uri.file('D:/example/qzcode/vscode'),
  globalStorageUri: vscodeStub.Uri.file(process.env.TEMP + '/qz-global'),
  subscriptions: disposables,
  extension: { packageJSON: { version: '0.0.0-test' } },
}

try {
  await ext.activate(context)
  console.log('activate() 成功')
} catch (error) {
  console.log('✘ activate() 抛错:', error && error.message)
  console.log(String(error && error.stack).split('\n').slice(0, 6).join('\n'))
}

console.log('\n注册的命令数:', registered.filter((id) => id.startsWith('qzcode.')).length)
console.log(registered.filter((id) => id.startsWith('qzcode.')).sort().join('\n'))

const want = ['qzcode.restart', 'qzcode.cancelRun', 'qzcode.newTask', 'qzcode.openSettings']
console.log('\n关键命令检查:')
for (const id of want) console.log(' ', registered.includes(id) ? '✔' : '✘', id)
