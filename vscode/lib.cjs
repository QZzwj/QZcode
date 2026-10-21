'use strict'

/*
 * 纯函数，供 extension.cjs 使用，也便于在 node 里单测（这里不 require('vscode')）。
 */

const fs = require('node:fs')
const { CHAT_PAGE, SETTINGS_PAGE } = require('./pages.cjs')
const path = require('node:path')

/** 从 `qzcode web` 的 stdout 里认出服务地址。 */
const SERVER_URL_PATTERN = /qzcode GUI:\s*(https?:\/\/[^\s]+)/i

function parseServerUrl(text) {
  const match = SERVER_URL_PATTERN.exec(String(text ?? ''))
  return match ? match[1].replace(/\/+$/, '') : null
}

/** 0.0.0.0 / :: 监听时，浏览器要访问的仍然是回环地址。 */
function browserUrl(serverUrl) {
  return String(serverUrl).replace('://0.0.0.0', '://127.0.0.1').replace('://[::]', '://127.0.0.1')
}

function buildServerArgs(options) {
  const args = [options.cliPath, 'web', '--no-open', '--port', String(options.port ?? 0)]
  if (options.workspace) args.push('--workspace', options.workspace)
  if (options.configFile) args.push('--config', options.configFile)
  if (options.mock) args.push('--mock')
  if (options.exec === false) args.push('--no-exec')
  if (options.rounds) args.push('--rounds', String(options.rounds))
  if (options.debug) args.push('--debug')
  return args
}

/**
 * 找 CLI 的位置：设置项 → 工作区 → 扩展旁边（仓库内布局）。
 * 返回 { path, source } 或 null。
 */
/**
 * 找出同一扩展的其它已安装版本目录（`…/extensions/qzcode.qzcode-x.y.z`），新的在前。
 * 用途：升级过程中旧版本的窗口还在跑、但它的目录已被清掉时，可以借用另一个版本的后端。
 */
function peerVersionDirs(extensionPath) {
  if (!extensionPath) return []
  const root = path.dirname(extensionPath)
  const self = path.basename(extensionPath)
  const prefix = self.replace(/-\d+\.\d+\.\d+.*$/, '')
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && entry.name !== self)
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((name) => path.join(root, name))
}

function resolveCliPath(options) {
  const candidates = []
  if (options.setting) candidates.push({ path: options.setting, source: 'setting' })
  // 自带的完整后端（编译好的 JS，Node ≥ 18 就能跑，不依赖仓库）
  if (options.extensionPath) {
    candidates.push({ path: path.join(options.extensionPath, 'backend', 'dist', 'cli.js'), source: 'bundled' })
    candidates.push({ path: path.join(options.extensionPath, 'backend', 'src', 'cli.ts'), source: 'bundled-ts' })
    // 升级途中：本版本目录被清掉时，借用相邻版本的后端（避免直接趴窝）
    for (const peer of peerVersionDirs(options.extensionPath)) {
      candidates.push({ path: path.join(peer, 'backend', 'dist', 'cli.js'), source: 'bundled-peer' })
    }
    candidates.push({ path: path.join(options.extensionPath, '..', 'src', 'cli.ts'), source: 'extension-sibling' })
  }
  for (const folder of options.workspaceFolders ?? []) {
    candidates.push({ path: path.join(folder, 'src', 'cli.ts'), source: 'workspace' })
  }
  for (const candidate of candidates) {
    try {
      if (candidate.path && fs.existsSync(candidate.path)) {
        return { path: path.resolve(candidate.path), source: candidate.source }
      }
    } catch {
      // 继续找下一个
    }
  }
  return null
}

/** 出错时把"找过哪些地方"列出来，省得用户猜。 */
function describeCandidates(options) {
  const lines = []
  if (options.setting) lines.push(`qzcode.cliPath → ${options.setting}`)
  if (options.extensionPath) {
    lines.push(`自带后端 → ${path.join(options.extensionPath, 'backend', 'dist', 'cli.js')}`)
    lines.push(`兄弟仓库 → ${path.join(options.extensionPath, '..', 'src', 'cli.ts')}`)
  }
  for (const folder of options.workspaceFolders ?? []) lines.push(`工作区 → ${path.join(folder, 'src', 'cli.ts')}`)
  return lines
}

/** 找一份可用的 qzcode.json：设置 → 工作区 → 全局存储（都没有就返回空串）。 */
function resolveConfigFile(options) {
  const candidates = []
  if (options.setting) candidates.push(options.setting)
  for (const folder of options.workspaceFolders ?? []) {
    candidates.push(path.join(folder, 'qzcode.json'))
    candidates.push(path.join(folder, 'pi-trio.json'))
  }
  if (options.globalDir) candidates.push(path.join(options.globalDir, 'qzcode.json'))
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      // 下一个
    }
  }
  return ''
}

/**
 * 配置文件该打开/创建在哪 —— 顺序必须和 ensureServer() 一致，
 * 否则会出现"提示还没有配置、实际后端正在用另一份"的误导。
 * 顺序：设置 → 工作区 qzcode.json → 扩展全局存储。
 */
function resolveConfigTarget(options) {
  const candidates = []
  if (options.setting) candidates.push({ path: options.setting, source: 'setting' })
  for (const folder of options.workspaceFolders ?? []) {
    candidates.push({ path: path.join(folder, 'qzcode.json'), source: 'workspace' })
  }
  if (options.globalDir) {
    candidates.push({ path: path.join(options.globalDir, 'qzcode.json'), source: 'global' })
  }
  for (const candidate of candidates) {
    try {
      if (candidate.path && fs.existsSync(candidate.path)) {
        return { path: path.resolve(candidate.path), source: candidate.source, exists: true }
      }
    } catch {
      // 继续找下一个
    }
  }
  // 一个都没有时：默认在全局存储里建（后端启动时用的就是这份），
  // 没有全局目录才退回工作区/设置指定的位置
  const preferred =
    candidates.find((candidate) => candidate.source === 'global') ??
    candidates.find((candidate) => candidate.source === 'workspace') ??
    candidates[0]
  return preferred
    ? { path: path.resolve(preferred.path), source: preferred.source, exists: false }
    : null
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/** 选中代码 / 当前文件 → 一条可读的目标。 */
function goalFromSelection(options) {
  const text = String(options.selection ?? '').trim()
  const file = String(options.filePath ?? '').trim()
  const instruction = String(options.instruction ?? '').trim()
  if (!text) return instruction
  const where = file ? `（来自 ${file}）` : ''
  const ask = instruction || '请针对下面这段选中代码完成需求：先给出任务书与验收标准，再实现，最后核验。'
  return `${ask}${where}\n\n\`\`\`\n${text.slice(0, 6000)}\n\`\`\``
}

/** 侧栏聊天视图的 HTML：CSP 只允许它连本地服务，脚本/样式走 media/ 里的文件。 */
function chatWebviewHtml(options) {
  const nonce = options.nonce ?? ''
  const origin = options.serverOrigin ?? 'http://127.0.0.1:*'
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `img-src ${options.cspSource} data: ${origin}`,
    `font-src ${options.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${origin}`,
  ].join('; ')
  const template = CHAT_PAGE
  return template
    .replace('__CSP__', csp)
    .replace('__STYLE__', String(options.styleUri ?? ''))
    .replace('__SCRIPT__', String(options.scriptUri ?? ''))
    .replace('__NONCE__', nonce)
}

/** 模型设置面板的 HTML（同样是占位符替换，CSP 只允许连本地服务）。 */
function settingsWebviewHtml(options) {
  const nonce = options.nonce ?? ''
  const origin = options.serverOrigin ?? 'http://127.0.0.1:*'
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `img-src ${options.cspSource} data:`,
    `font-src ${options.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${origin}`,
  ].join('; ')
  const template = SETTINGS_PAGE
  return template
    .replace('__CSP__', csp)
    .replace('__STYLE__', String(options.styleUri ?? ''))
    .replace('__SCRIPT__', String(options.scriptUri ?? ''))
    .replace('__NONCE__', nonce)
}

module.exports = {
  parseServerUrl,
  browserUrl,
  buildServerArgs,
  resolveCliPath,
  peerVersionDirs,
  describeCandidates,
  escapeHtml,
  chatWebviewHtml,
  settingsWebviewHtml,
  resolveConfigFile,
  resolveConfigTarget,
  goalFromSelection,
  SERVER_URL_PATTERN,
}
