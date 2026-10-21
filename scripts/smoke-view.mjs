import Module from 'node:module'
import { createRequire } from 'node:module'

/** 用假 vscode 调 resolveWebviewView：面板打开时走的就是这条路。 */

const registered = []
const disposable = () => ({ dispose() {} })
const uri = (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` })

let viewProvider = null

const vscode = {
  version: 'test',
  Uri: {
    file: uri,
    joinPath: (base, ...parts) => uri([base.fsPath, ...parts].join('/').replace(/\/+/g, '/')),
    parse: (t) => ({ toString: () => t }),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1 },
  ThemeColor: class {},
  EventEmitter: class {
    event() {
      return disposable()
    }
    fire() {}
  },
  window: {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' }),
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    registerWebviewViewProvider: (id, provider) => {
      registered.push(`view:${id}`)
      viewProvider = provider
      return disposable()
    },
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
        asWebviewUri: (u) => u,
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
    workspaceFolders: [{ uri: uri('D:/hhd/pi') }],
    getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
    onDidChangeConfiguration: () => disposable(),
    onDidChangeWorkspaceFolders: () => disposable(),
    openTextDocument: async () => ({}),
    onDidSaveTextDocument: () => disposable(),
  },
  commands: {
    registerCommand: (id) => {
      registered.push(id)
      return disposable()
    },
    executeCommand: async () => undefined,
  },
  env: { openExternal: async () => true },
  l10n: { t: (text) => text },
}

const originalLoad = Module._load
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscode
  return originalLoad.call(this, request, parent, isMain)
}

const require2 = createRequire(import.meta.url)
const ext = require2('../vscode/extension.cjs')

const context = {
  extensionPath: 'D:/hhd/pi/vscode',
  extensionUri: uri('D:/hhd/pi/vscode'),
  globalStorageUri: uri(process.env.TEMP + '/qz-global'),
  subscriptions: [],
  extension: { packageJSON: { version: '0.0.0-test' } },
}

await ext.activate(context)
console.log('activate OK；view provider:', registered.filter((r) => r.startsWith('view:')).join(', ') || '(没注册)')

if (!viewProvider) {
  console.log('✘ 没有注册 view provider')
  process.exit(1)
}

// 模拟 VS Code 打开侧栏时给的 view 对象
const messages = []
const view = {
  webview: {
    options: {},
    html: '',
    cspSource: 'vscode-webview://abc',
    asWebviewUri: (target) => ({ toString: () => String(target.toString()).replace('file://', 'vscode-resource:') }),
    onDidReceiveMessage: () => disposable(),
    postMessage: async (message) => {
      messages.push(message)
      return true
    },
  },
  onDidDispose: () => disposable(),
  onDidChangeVisibility: () => disposable(),
  visible: true,
  show: () => {},
}

try {
  await viewProvider.resolveWebviewView(view)
  console.log('resolveWebviewView OK')
  console.log('  生成的 HTML 长度:', view.webview.html.length)
  console.log('  有 CSP:', view.webview.html.includes('Content-Security-Policy'))
  console.log('  有 rail:', view.webview.html.includes('class="rail"'))
  console.log('  占位符残留:', /__CSP__|__STYLE__|__SCRIPT__|__NONCE__/.test(view.webview.html))
  console.log('  脚本 URI 形如:', (view.webview.html.match(/src="([^"]+)"/) || [])[1])
} catch (error) {
  console.log('✘ resolveWebviewView 抛错:', error && error.message)
  console.log(String(error && error.stack).split('\n').slice(0, 8).join('\n'))
}

await new Promise((r) => setTimeout(r, 1500))
console.log('面板收到的消息:', JSON.stringify(messages).slice(0, 300))
process.exit(0)
