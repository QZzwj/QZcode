'use strict'

/*
 * QZcode 的 VS Code 壳。
 *
 * 分工：扩展只负责「拉起本地服务 + 把 GUI 放进 Webview + 把编辑器里的东西喂进去」，
 * A/B/C 流水线、工具、插件、SSE 全在 src/ 里那一份实现中。这样 TUI、浏览器、VS Code
 * 三个入口共用一套代码，扩展本身不需要构建步骤（VS Code 直接跑 CJS）。
 */

const vscode = require('vscode')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { randomBytes } = require('node:crypto')
const lib = require('./lib.cjs')

/** @type {{ child: import('node:child_process').ChildProcess | null, url: string | null, panel: any, status: any, starting: Promise<string> | null }} */
const runtime = {
  child: null,
  url: null,
  panel: null,
  panels: new Map(),
  status: null,
  starting: null,
  chat: null,
  lastError: null,
  globalDir: '',
  extensionPath: '',
  version: '',
}

/**
 * 侧边栏聊天视图（WebviewView）。这是扩展的主界面：贴着 VS Code 主题、
 * 只有一列对话，模型/供应商选择器就在输入框旁边——不用打开任何大面板。
 */
class ChatView {
  constructor(context) {
    this.context = context
    this.view = null
  }

  async resolveWebviewView(view) {
    traceBoot('面板已打开（resolveWebviewView）')
    this.view = view
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media')
    view.webview.options = { enableScripts: true, localResourceRoots: [media] }
    view.webview.html = lib.chatWebviewHtml({
      cspSource: view.webview.cspSource,
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css')).toString(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js')).toString(),
      nonce: randomBytes(16).toString('hex'),
    })

    view.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'saveVision') {
        try {
          const result = await api('/api/vision', { ...message, type: undefined })
          this.view.webview.postMessage({ type: 'visionSaved', result })
          output().appendLine(`[vision] 开关=${message.enabled ? '开' : '关'} 模型=${message.model || '(空)'}`)
        } catch (error) {
          this.view.webview.postMessage({
            type: 'visionSaved',
            result: { ok: false, error: String(error.message) },
          })
        }
        return
      }
      if (message.type === 'setGit') {
        try {
          await api('/api/git', { autoCommit: message.autoCommit === true })
          output().appendLine(`[git] 自动提交=${message.autoCommit === true ? '开' : '关'}`)
        } catch (error) {
          vscode.window.showWarningMessage(`切换自动提交失败：${error.message}`)
        }
        return
      }
      if (message.type === 'webviewError') {
        traceBoot(`webview 报错：${String(message.error).slice(0, 300)}`)
        output().appendLine(`[webview] ${String(message.error).slice(0, 500)}`)
        return
      }
      if (message.type === 'ready') await this.push()
      // 侧栏拿到了空/过期地址时会主动来要；这里确保服务起着并把最新地址推回去
      else if (message.type === 'showDiff') await showRunDiff()
      else if (message.type === 'rollback') await rollbackRun()
      else if (message.type === 'needUrl') await pushFreshUrl()
      else if (message.type === 'restartServer') await vscode.commands.executeCommand('qzcode.restart')
      else if (message.type === 'pickProvider') await chooseProvider()
      else if (message.type === 'openExternal') {
        const url = lib.browserUrl(message.url || runtime.url || '')
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url))
      }
    })

    view.onDidDispose(() => {
      this.view = null
    })

    void this.push()
  }

  /** 把服务地址 + 供应商状态推给 webview（它自己去拉数据）。 */
  async push() {
    if (!this.view) return
    try {
      const url = await ensureServer()
      const providers = await api('/api/providers').catch(() => null)
      const roles = await api('/api/roles').catch(() => null)
      const git = roles && roles.git ? roles.git : { autoCommit: false, repo: false }
      const vision = roles && roles.vision ? roles.vision : null
      const workspace = (roles && roles.workspace) || runtime.workspace || ''
      this.view.webview.postMessage({ type: 'init', url, providers, git, vision, workspace })
      traceBoot(`已推送 init url=${url || '(空)'}`)
      if (!runtime.firstPaintLogged) {
        runtime.firstPaintLogged = true
        output().appendLine(`[perf] 面板可用（已推送 init）`)
      }
    } catch (error) {
      this.view.webview.postMessage({ type: 'init', url: '', error: String(error.message ?? error) })
      traceBoot(`推送 init 失败：${String(error.message ?? error).split('\n')[0]}`)
    }
  }

  async pushProviders() {
    if (!this.view || !runtime.url) return
    const providers = await api('/api/providers').catch(() => null)
    if (providers) this.view.webview.postMessage({ type: 'providers', providers })
  }
}

function settings() {
  const config = vscode.workspace.getConfiguration('qzcode')
  return {
    cliPath: config.get('cliPath') || '',
    nodePath: config.get('nodePath') || 'node',
    configFile: config.get('configFile') || '',
    mock: config.get('mock') === true,
    exec: config.get('exec') !== false,
    rounds: config.get('rounds') || 0,
    log: config.get('log') === true,
  }
}

/**
 * 当前工作区：优先用"正在编辑文件所在的那个文件夹"（多根工作区时才对），
 * 否则用第一个文件夹。没有打开文件夹就返回空串——不要偷偷用扩展自己的目录。
 */
function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) return ''
  if (folders.length === 1) return folders[0].uri.fsPath
  const active = vscode.window.activeTextEditor?.document?.uri?.fsPath
  if (active) {
    const hit = folders.find((folder) => active.startsWith(folder.uri.fsPath))
    if (hit) return hit.uri.fsPath
  }
  return folders[0].uri.fsPath
}

/**
 * 启动自检日志：写到 <globalStorage>/activate.log。
 * 面板打不开时，"到底哪一步没走到"看一眼这个文件就知道。
 */
function traceBoot(message) {
  try {
    if (!runtime.globalDir) return
    const file = path.join(runtime.globalDir, 'activate.log')
    const line = `${new Date().toISOString()} [${runtime.version || '?'}] ${message}\n`
    fs.mkdirSync(runtime.globalDir, { recursive: true })
    fs.appendFileSync(file, line, 'utf8')
  } catch {
    // 日志本身失败不能影响激活
  }
}

function output() {
  if (!runtime.channel) {
    runtime.channel = vscode.window.createOutputChannel('QZcode')
  }
  return runtime.channel
}

function setStatus(text, tooltip) {
  if (!runtime.status) {
    runtime.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    // 点状态栏回到侧栏聊天（主界面），大面板另有命令
    runtime.status.command = 'qzcode.openChat'
    runtime.status.show()
  }
  runtime.status.text = text
  runtime.status.tooltip = tooltip ?? 'QZcode · A 规划 → B 实现 → C 核验'
}

/** 模型设置面板：A/B/C 三个角色各自的 provider / model / key。 */
function showSettings() {
  runtime.panels = runtime.panels ?? new Map()
  const viewType = 'qzcode.settings'
  const existing = runtime.panels.get(viewType)
  if (existing) {
    existing.reveal(vscode.ViewColumn.Active)
    void pushRoles(existing)
    return existing
  }

  const media = vscode.Uri.joinPath(vscode.Uri.file(runtime.extensionPath), 'media')
  const panel = vscode.window.createWebviewPanel(viewType, 'QZcode 设置', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [media],
  })
  runtime.panels.set(viewType, panel)

  panel.webview.html = lib.settingsWebviewHtml({
    cspSource: panel.webview.cspSource,
    styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'settings.css')).toString(),
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'settings.js')).toString(),
    nonce: randomBytes(16).toString('hex'),
  })

  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message !== 'object') return
    try {
      if (message.type === 'ready') {
        await pushRoles(panel)
        try {
          await ensureServer()
          const catalog = await api('/api/skills').catch(() => ({ skills: [] }))
          panel.webview.postMessage({ type: 'skills', catalog: catalog.skills ?? [] })
        } catch {
          // 技能目录拉不到不影响其它功能
        }
        return
      }
      if (message.type === 'openConfig') {
        await openConfigFile()
        return
      }
      if (message.type === 'save') {
        await ensureServer()
        const saved = await api('/api/roles', message.patch)
        await pushRoles(panel, saved, message.patch?.role)
        await refreshStatus()
        await runtime.chat?.pushProviders()
        output().appendLine(`[settings] 保存 ${message.patch?.role}: ${JSON.stringify(message.patch).slice(0, 200)}`)
        return
      }
      if (message.type === 'reloadSkills' || message.type === 'readySkills') {
        await ensureServer()
        const result = await api('/api/skills').catch(() => ({ skills: [] }))
        panel.webview.postMessage({ type: 'skills', catalog: result.skills ?? [] })
        return
      }
      if (message.type === 'removeSkill') {
        await ensureServer()
        try {
          const result = await api('/api/skills/remove', { name: message.name })
          panel.webview.postMessage({ type: 'removed', result })
          const catalog = await api('/api/skills').catch(() => ({ skills: [] }))
          panel.webview.postMessage({ type: 'skills', catalog: catalog.skills ?? [] })
        } catch (error) {
          panel.webview.postMessage({ type: 'removed', result: { ok: false, error: String(error.message ?? error) } })
        }
        return
      }
      if (message.type === 'reloadCost') {
        await ensureServer()
        const data = await api('/api/cost').catch(() => null)
        panel.webview.postMessage({ type: 'cost', data })
        return
      }
      if (message.type === 'importSkill') {
        await ensureServer()
        try {
          const result = await api('/api/skills/import', {
            source: message.source,
            value: message.value,
          })
          panel.webview.postMessage({ type: 'imported', result })
          output().appendLine(`[skills] 导入 ${message.source} → ${result.ok ? result.skill?.name : 'FAIL ' + result.error}`)
          if (result.ok) {
            const catalog = await api('/api/skills').catch(() => ({ skills: [] }))
            panel.webview.postMessage({ type: 'skills', catalog: catalog.skills ?? [] })
          }
        } catch (error) {
          panel.webview.postMessage({ type: 'imported', result: { ok: false, error: String(error.message ?? error) } })
        }
        return
      }
      if (message.type === 'models') {
        await ensureServer()
        try {
          const result = await api('/api/models', {
            role: message.role,
            baseUrl: message.patch?.baseUrl,
            apiKey: message.patch?.apiKey,
            headers: message.patch?.headers,
          })
          panel.webview.postMessage({ type: 'models', role: message.role, result })
          output().appendLine(
            `[models] ${message.role} → ${result.ok ? `${result.models.length} 个模型` : `失败 ${result.error}`}`,
          )
        } catch (error) {
          panel.webview.postMessage({ type: 'models', role: message.role, result: {
            ok: false,
            models: [],
            error: String(error.message ?? error),
          } })
        }
        return
      }
      if (message.type === 'testRole') {
        await ensureServer()
        if (message.patch) await api('/api/roles', { ...message.patch, role: message.role })
        const result = await api('/api/roles', { testRole: message.role })
        panel.webview.postMessage({ type: 'tested', role: message.role, result })
        await pushRoles(panel)
        output().appendLine(
          `[test] ${message.role} → ${result.ok ? 'OK' : 'FAIL'} ${result.ms}ms ${result.error ?? ''}`,
        )
        return
      }
      if (message.type === 'copy') {
        await ensureServer()
        // 先把当前卡片（可能刚改但没保存）落盘，再复制给另外两个角色
        if (message.patch) {
          // 先把当前卡片（可能刚改没保存）落盘，再复制 —— 全部字段都带上
          await api('/api/roles', { ...message.patch, role: message.from })
        }
        const saved = await api('/api/roles', { copyFrom: message.from })
        await pushRoles(panel, { ...saved, copied: true }, message.from)
        await refreshStatus()
        await runtime.chat?.pushProviders()
        return
      }
    } catch (error) {
      panel.webview.postMessage({ type: 'error', message: String(error.message ?? error) })
      output().appendLine(`[settings] 失败: ${error.message}`)
    }
  })

  panel.onDidDispose(() => {
    runtime.panels?.delete(viewType)
  })

  void pushRoles(panel)
  return panel
}

/** 把当前角色配置推给设置面板（saved 有值时顺带回执警告）。 */
async function pushRoles(panel, saved, role) {
  try {
    await ensureServer()
    const state = await api('/api/roles')
    panel.webview.postMessage(
      saved
        ? { type: 'saved', role, state, warnings: saved.warnings ?? [], persistError: saved.persistError }
        : { type: 'state', state },
    )
  } catch (error) {
    panel.webview.postMessage({ type: 'state', error: String(error.message ?? error) })
  }
}

/** 换 AI 供应商：QuickPick → 可选填 key → 后端写回配置（下一轮生效，不用重启）。 */
async function chooseProvider() {
  let state
  try {
    state = await api('/api/providers')
  } catch (error) {
    vscode.window.showErrorMessage(`QZcode：读不到供应商列表（${error.message}）`)
    return
  }

  const current = state.current
  const items = (state.providers ?? []).map((provider) => ({
    label: `${provider.active ? '$(check) ' : '$(circle-small-filled) '}${provider.label}`,
    description: provider.baseUrl,
    detail: [
      provider.hasKey ? '已有 key' : provider.envKey ? `需要 ${provider.envKey}` : '本地模型，不需要 key',
      provider.active ? `当前 · ${current.model}` : '',
      current.mock && provider.active ? 'mock 模式下不会真的调用' : '',
    ]
      .filter(Boolean)
      .join(' · '),
    provider,
  }))

  const picked = await vscode.window.showQuickPick(items, {
    title: 'QZcode · 更换 AI 供应商',
    placeHolder: `当前 ${current.provider} · ${current.model}`,
    matchOnDescription: true,
    ignoreFocusOut: true,
  })
  if (!picked) return

  const provider = picked.provider
  let apiKey
  if (!provider.hasKey) {
    const value = await vscode.window.showInputBox({
      title: `QZcode · ${provider.id} 的 API key`,
      prompt: provider.envKey
        ? `留空则用环境变量 ${provider.envKey}（要重启 VS Code 才读得到）`
        : '留空表示这个供应商不需要 key',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-...',
    })
    if (value === undefined) return
    apiKey = value.trim() || undefined
  }

  try {
    const result = await api('/api/providers', { provider: provider.id, apiKey })
    const model = result.state?.current?.model ?? provider.model
    await refreshStatus()
    await runtime.chat?.pushProviders()
    void vscode.commands.executeCommand('qzcode.openChat')
    const warnings = result.warnings ?? []
    if (result.persistError) {
      vscode.window.showWarningMessage(`QZcode：已切到 ${provider.id} · ${model}，但${result.persistError}`)
    } else {
      const suffix = warnings.length > 0 ? `（${warnings[0]}）` : ''
      vscode.window.showInformationMessage(`QZcode：已切到 ${provider.id} · ${model}${suffix}`)
    }
    output().appendLine(`[provider] ${provider.id} · ${model} · warnings=${warnings.join(' | ') || 'none'}`)
  } catch (error) {
    vscode.window.showErrorMessage(`QZcode：切换失败（${error.message}）`)
  }
}


/** 拉起 `qzcode web`，并从 stdout 里认出端口。 */
/** resolveCliPath 会 stat 一堆候选路径；缓存结果，重启时不再扫盘。 */
let cliPathCache = null

async function ensureServer() {
  if (runtime.url) return runtime.url
  if (runtime.starting) return runtime.starting

  runtime.starting = (async () => {
    const config = settings()
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
    const resolved =
      cliPathCache ??
      lib.resolveCliPath({
        setting: config.cliPath,
        workspaceFolders: folders,
        extensionPath: __dirname,
      })
    if (resolved) cliPathCache = resolved
    if (!resolved) {
      const searched = lib
        .describeCandidates({ setting: config.cliPath, workspaceFolders: folders, extensionPath: __dirname })
        .map((line) => `  · ${line}`)
        .join('\n')
      throw new Error(
        `扩展自带的后端不见了（backend/dist/cli.js）。\n找过这些位置：\n${searched}\n` +
          '处理办法：重装扩展（code --install-extension qzcode.vsix --force）后重载窗口。',
      )
    }

    const globalDir = runtime.globalDir
    const existingConfig = lib.resolveConfigFile({
      setting: config.configFile,
      workspaceFolders: folders,
      globalDir,
    })
    // 没有配置文件时把配置放到扩展的全局存储里，别污染用户项目；先用 mock 保证能跑起来
    let configFile = existingConfig
    if (!configFile && globalDir) {
      try {
        fs.mkdirSync(globalDir, { recursive: true })
        configFile = path.join(globalDir, 'qzcode.json')
      } catch (error) {
        output().appendLine(`[config] 无法创建全局配置目录: ${error.message}`)
      }
    }
    if (!existingConfig && !config.mock) {
      output().appendLine('[config] 还没有配置文件，先用脚本化模型（mock）跑起来；选好供应商后会自动写配置')
    }

    let root = workspaceRoot()
    if (!root && runtime.globalDir) {
      // 没打开文件夹：用一个专门的空目录跑，别写进扩展目录
      root = path.join(runtime.globalDir, 'scratch')
      try {
        fs.mkdirSync(root, { recursive: true })
      } catch {
        root = ''
      }
      output().appendLine(`[workspace] 没有打开的文件夹，先工作在这个临时目录：${root}`)
      vscode.window.setStatusBarMessage('QZcode：未打开文件夹，任务会写到临时目录', 6000)
    }
    runtime.workspace = root
    output().appendLine(`[workspace] ${root || '(未指定)'}`)
    const args = lib.buildServerArgs({
      cliPath: resolved.path,
      workspace: root || undefined,
      configFile: configFile || undefined,
      mock: config.mock || !existingConfig,
      exec: config.exec,
      rounds: config.rounds || undefined,
      debug: config.log,
      port: 0,
    })
    output().appendLine(`[backend] ${resolved.source} → ${resolved.path}`)

    const serverStarted = Date.now()
    output().appendLine(`[start] ${config.nodePath} ${args.join(' ')}`)
    setStatus('$(sync~spin) QZcode 启动中')

    const child = spawn(config.nodePath, args, {
      cwd: root || path.dirname(resolved.path),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QZCODE_VSCODE: '1' },
      windowsHide: true,
    })
    runtime.child = child
    child.on('exit', (code, signal) => {
      if (runtime.child !== child) return
      runtime.child = null
      runtime.url = null
      output().appendLine(`[exit] 后端退出 code=${code} signal=${signal ?? '-'}`)
      setStatus('$(error) QZcode 已停止')
      void runtime.chat?.push()
    })

    const url = await new Promise((resolve, reject) => {
      let buffer = ''
      let stderrTail = ''
      const timer = setTimeout(() => reject(new Error('等待 QZcode 服务超时（10s）')), 10_000)
      const finish = (error, value) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        output().appendLine(`[server] ${String(chunk).trimEnd()}`)
        const found = lib.parseServerUrl(buffer)
        if (found) finish(null, found)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        const text = String(chunk)
        buffer += text
        // 留最后一段错误输出，失败时直接显示在错误页上，不用去翻输出面板
        stderrTail = `${stderrTail}${text}`.slice(-3000)
        output().appendLine(`[server:err] ${text.trimEnd()}`)
        const found = lib.parseServerUrl(buffer)
        if (found) finish(null, found)
      })
      child.on('error', (error) => finish(error))
      child.on('exit', (code) => {
        const detail = stderrTail.trim()
        finish(
          new Error(
            `QZcode 服务退出（code ${code}）` +
              (detail ? `\n\n后端的报错：\n${detail}` : '') +
              `\n\n配置文件：${configFile || '(没有，用的是内置默认值 + mock)'}` +
              `\n工作区：${root || '(未打开文件夹)'}`,
          ),
        )
      })
    })

    runtime.url = url
    setStatus('$(circle-filled) QZcode 就绪', url)
    output().appendLine(`[ready] ${url}`)
    if (typeof serverStarted === 'number') {
      output().appendLine(`[perf] 后端就绪，用时 ${Date.now() - serverStarted}ms`)
    }
    void runtime.chat?.push()
    refreshStatus()
    return url
  })()

  try {
    return await runtime.starting
  } finally {
    runtime.starting = null
  }
}

async function api(pathname, body) {
  const base = await ensureServer()
  const response = await fetch(`${base}${pathname}`, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload
}

/** 状态栏跟着服务里的运行状态走：轮次、阶段、通过与否。 */
/** 侧栏说连不上：先探活；活着就只重推地址，真死了才杀掉重启。 */
  /** 看本次运行改了什么：走 VS Code 原生 diff（左边快照，右边现状）。 */
  async function showRunDiff() {
    let payload
    try {
      payload = await api('/api/diff')
    } catch (error) {
      vscode.window.showWarningMessage(`没有可看的改动：${error.message}`)
      return
    }
    const files = payload.files ?? []
    if (files.length === 0) {
      vscode.window.showInformationMessage('本次运行没有留下文件改动')
      return
    }
    const root = workspaceRoot() ?? ''
    const snapDir = path.join(root, '.qzcode', 'snapshots', String(payload.runId))
    const picked = await vscode.window.showQuickPick(
      files.map((file) => ({
        label: `${file.status === 'created' ? '＋' : file.status === 'deleted' ? '－' : '±'} ${file.path}`,
        description: `+${file.added} −${file.removed}`,
        file,
      })),
      { placeHolder: `改动 ${files.length} 个文件（+${payload.added} −${payload.removed}）` },
    )
    if (!picked) return
    const target = picked.file
    const right = vscode.Uri.file(path.join(root, target.path))
    const snapshotName = String(target.path).replace(/\//g, '__')
    const left = vscode.Uri.file(path.join(snapDir, snapshotName))
    if (target.status === 'created') {
      const doc = await vscode.workspace.openTextDocument(right)
      await vscode.window.showTextDocument(doc, { preview: true })
      return
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${target.path}（改动前 ↔ 改动后）`,
      { preview: true },
    )
  }

  /** 回滚上一次运行动过的文件。 */
  async function rollbackRun(runId) {
    const answer = await vscode.window.showWarningMessage(
      '把这次运行改过的文件恢复原状？（新建的文件会被删掉）',
      { modal: true },
      '回滚',
    )
    if (answer !== '回滚') return
    try {
      const result = await api('/api/rollback', runId ? { runId } : {})
      const parts = []
      if (result.restored?.length) parts.push(`恢复 ${result.restored.length} 个`)
      if (result.deleted?.length) parts.push(`删除 ${result.deleted.length} 个`)
      if (result.failed?.length) parts.push(`失败 ${result.failed.length} 个`)
      const text = parts.join('，') || '没有需要回滚的改动'
      vscode.window.showInformationMessage(`QZcode 回滚：${text}`)
      output().appendLine(`[rollback] ${result.runId}: ${text}`)
    } catch (error) {
      vscode.window.showErrorMessage(`回滚失败：${error.message}`)
    }
  }

  async function pushFreshUrl() {
    if (runtime.url) {
      try {
        const response = await fetch(`${runtime.url}/api/health`)
        if (response.ok) {
          output().appendLine(`[health] ${runtime.url} 仍然在线，重推地址`)
          await runtime.chat?.push()
          return
        }
      } catch {
        // 连不上，往下走重启流程
      }
      output().appendLine(`[health] ${runtime.url} 连不上，重启后端`)
      runtime.url = null
      if (runtime.child) {
        runtime.child.kill()
        runtime.child = null
      }
    }
    await runtime.chat?.push()
  }

  async function refreshStatus() {
  if (!runtime.url) return
  try {
    const state = await api('/api/state')
    const active = state.runs.find((run) => run.status === 'running')
    if (active) {
      setStatus(`$(sync~spin) QZcode ${active.rounds ? `第 ${active.rounds} 轮` : '运行中'}`, active.goal)
      return
    }
    const last = state.runs[0]
    if (!last) {
      setStatus('$(circle-outline) QZcode', '点击打开工作台')
      return
    }
    const icon = last.status === 'passed' ? '$(pass-filled)' : last.status === 'failed' ? '$(error)' : '$(circle-outline)'
    setStatus(`${icon} QZcode · ${last.rounds} 轮`, last.goal)
  } catch {
    setStatus('$(warning) QZcode', '服务未运行，点击启动')
  }
}





async function startTask(goal) {
  const text = String(goal ?? '').trim()
  if (!text) {
    vscode.window.showWarningMessage('QZcode：目标为空')
    return
  }
  void vscode.commands.executeCommand('qzcode.openChat')
  try {
    const started = await api('/api/run', { goal: text })
    output().appendLine(`[run] ${started.runId} ${text}`)
    setStatus('$(sync~spin) QZcode 运行中', text)
    pollWhileRunning()
  } catch (error) {
    vscode.window.showErrorMessage(`QZcode：${error.message}`)
  }
}

function pollWhileRunning() {
  if (runtime.poll) return
  runtime.poll = setInterval(async () => {
    await refreshStatus()
    try {
      const state = await api('/api/state')
      if (!state.runs.some((run) => run.status === 'running')) {
        clearInterval(runtime.poll)
        runtime.poll = null
      }
    } catch {
      clearInterval(runtime.poll)
      runtime.poll = null
    }
  }, 2000)
}

function stopServer() {
  if (runtime.poll) {
    clearInterval(runtime.poll)
    runtime.poll = null
  }
  if (runtime.child) {
    output().appendLine('[stop] 停止 QZcode 服务')
    runtime.child.kill()
    runtime.child = null
  }
  runtime.url = null
  setStatus('$(circle-outline) QZcode', '点击打开工作台')
}

/** 打开（或生成）qzcode.json：插件的唯一开关就在这里。 */
async function openConfigFile() {
  const config = settings()
  const root = workspaceRoot()
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
  // 和 ensureServer 一致：设置 → 工作区 → 扩展全局存储（后端实际用的那份就在这）
  const target = lib.resolveConfigTarget({
    setting: config.configFile,
    workspaceFolders: folders,
    globalDir: runtime.globalDir,
  })

  if (!target) {
    vscode.window.showWarningMessage('没有可写配置的位置：先打开一个文件夹，或在设置里指定 qzcode.configFile')
    return
  }

  if (target.exists) {
    output().appendLine(`[config] 打开 ${target.path}（来源：${target.source}）`)
    await vscode.window.showTextDocument(vscode.Uri.file(target.path))
    return
  }

  const where =
    target.source === 'global'
      ? '扩展的全局存储（后端默认就用这份，不会污染你的项目）'
      : target.source === 'workspace'
        ? '当前工作区根目录'
        : '设置里指定的位置'
  const choice = await vscode.window.showInformationMessage(
    `还没有配置文件，在${where}生成一份模板？\n${target.path}`,
    '生成模板',
    '取消',
  )
  if (choice !== '生成模板') return

  const resolved = lib.resolveCliPath({
    setting: config.cliPath,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    extensionPath: __dirname,
  })
  if (!resolved) {
    vscode.window.showErrorMessage(
      '找不到用于生成模板的后端（cli.js）。扩展自带的后端就在 vscode/backend/dist 里，重装扩展或重载窗口后再试。',
    )
    return
  }
  const child = spawn(config.nodePath, [resolved.path, 'init', target.path], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve) => child.on('exit', resolve))
  await vscode.window.showTextDocument(vscode.Uri.file(target.path))
  output().appendLine(`[config] 已生成 ${target.path}`)
}

/** 插件加载失败时说清楚缺什么，指向日志或配置，而不是静默空转。 */
async function warnAboutPlugins() {
  let state
  try {
    state = await api('/api/state')
  } catch {
    return
  }
  const plugins = state.config?.plugins ?? []
  const failed = plugins.filter((plugin) => plugin.status === 'failed')
  if (failed.length > 0) {
    const detail = failed.map((plugin) => `${plugin.name}: ${plugin.detail}`).join('\n')
    const choice = await vscode.window.showWarningMessage(
      `QZcode：${failed.length} 个插件没加载成功（${failed.map((plugin) => plugin.name).join(', ')}）`,
      '打开插件配置',
      '显示日志',
    )
    if (choice === '打开插件配置') await openConfigFile()
    else if (choice === '显示日志') {
      output().appendLine(`[plugins] ${detail}`)
      output().show()
    }
    return
  }
  if (plugins.length > 0) {
    output().appendLine(`[plugins] 已加载 ${plugins.length} 个：${plugins.map((plugin) => plugin.name).join(', ')}`)
  }
}

function activate(context) {
  const activateStarted = Date.now()
  output().appendLine(`[activate] extension=${context.extensionPath}`)
  traceBoot(`activate 开始 pid=${process.pid}`)
  runtime.extensionPath = context.extensionPath
  runtime.version = context.extension.packageJSON.version
  runtime.globalDir = context.globalStorageUri ? context.globalStorageUri.fsPath : ''
  setStatus('$(circle-outline) QZcode', '点击打开工作台')

  const chat = new ChatView(context)
  runtime.chat = chat
  /**
   * 工作区变了（打开/关闭文件夹、在多根里切到另一个子目录）就重启后端，
   * 让它在新目录里干活。切文件会频繁触发，所以带 600ms 去抖 + 变化判断。
   */
  let workspaceTimer = null
  const workspaceChanged = () => {
    if (workspaceTimer) clearTimeout(workspaceTimer)
    workspaceTimer = setTimeout(async () => {
      workspaceTimer = null
      const next = workspaceRoot()
      // 后端还没起来时不要"重启"（runtime.workspace 为空 = 首次启动中，
      // 以前这里会把它刚起好的进程杀掉再起一遍，加载时间直接翻倍）
      if (!next || !runtime.workspace || next === runtime.workspace) return
      output().appendLine(`[workspace] 切到 ${next}，重启后端…`)
      stopServer()
      try {
        await ensureServer()
        vscode.window.setStatusBarMessage(
          `QZcode：工作区已切到 ${path.basename(next)}`,
          5000,
        )
      } catch (error) {
        output().appendLine(`[workspace] 重启失败: ${error.message}`)
        vscode.window.showErrorMessage(`QZcode 换工作区失败：${error.message}`)
      }
    }, 600)
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void workspaceChanged()
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void workspaceChanged()
    }),
  )

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('qzcode.chat', chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    
  )

  

  context.subscriptions.push(
    vscode.commands.registerCommand('qzcode.newTask', async () => {
      const goal = await vscode.window.showInputBox({
        title: 'QZcode · 新任务',
        prompt: 'A 会先写任务书与验收标准，B 实现，C 核验',
        placeHolder: '例如：给 src/utils.ts 加 parseDuration，并补测试',
        ignoreFocusOut: true,
      })
      if (goal) await startTask(goal)
    }),

    vscode.commands.registerCommand('qzcode.runSelection', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showWarningMessage('QZcode：先打开一个文件')
        return
      }
      const instruction = await vscode.window.showInputBox({
        title: 'QZcode · 对选中内容做什么',
        prompt: '留空则按“完成需求 + 补验证”处理',
        placeHolder: '例如：把这个函数改成流式解析，并补边界测试',
        ignoreFocusOut: true,
      })
      if (instruction === undefined) return
      const goal = lib.goalFromSelection({
        selection: editor.document.getText(editor.selection),
        filePath: vscode.workspace.asRelativePath(editor.document.uri),
        instruction,
      })
      await startTask(goal)
    }),

    vscode.commands.registerCommand('qzcode.openChat', async () => {
      await vscode.commands.executeCommand('qzcode.chat.focus')
      await refreshStatus()
    }),

    vscode.commands.registerCommand('qzcode.chooseProvider', async () => {
      await chooseProvider()
    }),

    vscode.commands.registerCommand('qzcode.openSettings', () => {
      showSettings()
    }),

    vscode.commands.registerCommand('qzcode.openConfig', async () => {
      await openConfigFile()
    }),

    vscode.commands.registerCommand('qzcode.showLog', () => output().show()),

    // 侧栏出现多个 QZcode 图标时，用它查清楚到底是谁贡献的
    vscode.commands.registerCommand('qzcode.diagnose', () => {
      const channel = output()
      channel.show(true)
      channel.appendLine('')
      channel.appendLine('========== QZcode 诊断 ==========')
      channel.appendLine(`VS Code ${vscode.version} · ${vscode.env.appName}`)
      channel.appendLine(`本扩展 ${runtime.version} → ${runtime.extensionPath}`)
      channel.appendLine(`node: ${process.version} · 扩展宿主 pid ${process.pid}`)

      const providers = []
      for (const ext of vscode.extensions.all) {
        const containers = ext.packageJSON?.contributes?.viewsContainers
        if (!containers) continue
        for (const [slot, list] of Object.entries(containers)) {
          for (const item of list ?? []) {
            const text = `${item.id ?? ''} ${item.title ?? ''}`.toLowerCase()
            if (!text.includes('qzcode')) continue
            providers.push(
              `  ${slot}: id=${item.id} title=${item.title} ← ${ext.id}@${ext.packageJSON?.version}` +
                ` (${ext.isActive ? 'active' : 'inactive'}) ${ext.extensionPath}`,
            )
          }
        }
      }
      channel.appendLine(`--- 贡献 qzcode 容器的扩展（${providers.length} 个）---`)
      channel.appendLine(providers.length ? providers.join('\n') : '  一个都没有：图标是渲染层缓存，重启 VS Code 即可')
      const qz = vscode.extensions.all.filter((ext) => ext.id === 'qzcode.qzcode')
      channel.appendLine(`--- 本扩展被加载了 ${qz.length} 次 ---`)
      for (const ext of qz) channel.appendLine(`  ${ext.packageJSON?.version} ${ext.extensionPath}`)
      channel.appendLine('==================================')
    }),

    vscode.commands.registerCommand('qzcode.stopServer', () => {
      stopServer()
      vscode.window.showInformationMessage('QZcode 服务已停止')
    }),

    vscode.commands.registerCommand('qzcode.showDiff', async () => {
      await showRunDiff()
    }),

    vscode.commands.registerCommand('qzcode.rollback', async () => {
      await rollbackRun()
    }),

    vscode.commands.registerCommand('qzcode.doctor', async () => {
      const channel = output()
      channel.show(true)
      channel.appendLine('[doctor] 体检中…（会做一次很小的网络探测）')
      try {
        const result = await api('/api/doctor')
        channel.appendLine('')
        channel.appendLine(String(result.text ?? ''))
        const { ok, warn, error } = result.summary ?? { ok: 0, warn: 0, error: 0 }
        const text = `QZcode 体检：${ok} 正常 / ${warn} 警告 / ${error} 错误`
        if (error > 0) {
          const first = (result.checks ?? []).find((check) => check.level === 'error')
          const pick = await vscode.window.showWarningMessage(text, '打开设置', '显示日志')
          if (pick === '打开设置') await vscode.commands.executeCommand('qzcode.openSettings')
          else if (pick === '显示日志') channel.show(true)
          if (first?.fix) channel.appendLine(`[doctor] 先修这条：${first.fix}`)
        } else {
          vscode.window.setStatusBarMessage(`$(pass-filled) ${text}`, 5000)
        }
      } catch (error) {
        vscode.window.showErrorMessage(`体检失败：${error.message}`)
        channel.appendLine(`[doctor] 失败: ${error.message}`)
      }
    }),

    vscode.commands.registerCommand('qzcode.cancelRun', async () => {
      try {
        await api('/api/cancel', {})
        vscode.window.setStatusBarMessage('$(debug-stop) QZcode 已发送停止请求', 3000)
        output().appendLine('[cancel] 已请求停止当前运行')
      } catch (error) {
        vscode.window.showWarningMessage(`停止失败：${error.message}`)
      }
    }),

    vscode.commands.registerCommand('qzcode.restart', async () => {
      stopServer()
      void vscode.commands.executeCommand('qzcode.openChat')
      await ensureServer()
      vscode.window.showInformationMessage('QZcode 已重启')
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('qzcode')) return
      stopServer()
      void vscode.commands.executeCommand('qzcode.openChat')
    }),
  )

  output().appendLine(`[perf] activate 完成，用时 ${Date.now() - activateStarted}ms`)
  traceBoot(`activate 完成 用时=${Date.now() - activateStarted}ms workspace=${workspaceRoot() || '(无)'}`)
  // autoStart：延迟预热，不占激活时间（打开面板时通常已经热好了）
  const config = vscode.workspace.getConfiguration('qzcode')
  if (config.get('autoStart') === true && workspaceRoot()) {
    setTimeout(() => {
      void ensureServer()
        .then(() => refreshStatus())
        .catch((error) => output().appendLine(`[autoStart] ${error.message}`))
    }, 1500)
  }
}

function deactivate() {
  stopServer()
  if (runtime.channel) runtime.channel.dispose()
  runtime.channel = null
}

module.exports = { activate, deactivate }
