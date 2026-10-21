#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  EXAMPLE_CONFIG,
  ROLE_NAMES,
  findConfigFile,
  loadConfig,
  normalizeConfig,
  validateConfig,
  writeExampleConfig,
} from './config.ts'
import type { AppConfig } from './config.ts'
import { createContext } from './kernel.ts'
import type { Logger, PluginRecord } from './kernel.ts'
import { CommandRegistry } from './commands.ts'
import { wireHost } from './host.ts'
import { createPlainReporter, runPipeline } from './pipeline.ts'
import type { Reporter, RunResult } from './pipeline.ts'
import { Toolbox, createTools } from './tools.ts'
import { detectDshAppDir, loadPlugins } from './plugins/loader.ts'
import { runTui } from './tui/app.ts'
import { createWebServer } from './web/server.ts'

interface Args {
  command: 'tui' | 'web' | 'run' | 'plugins' | 'config' | 'help' | 'version' | 'init'
  config?: string
  workspace?: string
  mock: boolean
  exec: boolean
  rounds?: number
  goal?: string
  json: boolean
  debug: boolean
  host?: string
  port?: number
  open: boolean
  positional: string[]
}

const HELP = `
QZcode — 四角色接力编码流水线（L 管全程 · A 出任务书 · B 实现 · C 核验）

用法:
  qzcode                        启动 TUI
  qzcode web                     启动后端服务（VS Code 侧栏用，不再自带网页界面）
  qzcode run "<目标>"           一次性执行，纯文本输出
  qzcode init [路径]            生成配置文件模板
  qzcode plugins                列出已加载/未加载的插件
  qzcode config                 打印解析后的配置（隐藏密钥）

选项:
  -c, --config <path>   指定配置文件（默认找 ./qzcode.json）
  -w, --workspace <dir> 覆盖工作区
  -g, --goal <text>     预设目标（TUI 下会自动开始）
  -m, --mock            使用脚本化模型，不联网、不需要 API key
      --no-exec         禁止 agent 执行 shell 命令
  -r, --rounds <n>      最大轮次 A→B→C（默认 3）
      --json            run 模式输出 JSON 结果
      --port <n>        web 模式端口（默认 4319，0 = 随机）
      --host <addr>     web 模式监听地址（默认 127.0.0.1）
      --open / --no-open  web 模式是否自动打开浏览器（默认不打开）
  -d, --debug           把诊断日志写到 .qzcode/debug.log
  -h, --help            显示帮助
  -v, --version         显示版本

示例:
  qzcode web --open --mock          # 只想在浏览器里看看（调试用）
  qzcode web --port 5000            # 指定端口
  qzcode run "给 src/utils.ts 加 parseDuration 并补测试"
  qzcode -c ./team.json -r 5        # 用团队配置，最多 5 轮
`

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'tui',
    mock: false,
    exec: true,
    json: false,
    debug: false,
    // 默认不开浏览器：web 是扩展/前端的后端，只有显式 --open 才弹浏览器
  open: false,
    positional: [],
  }
  const commands = new Set(['web', 'tui', 'run', 'plugins', 'config', 'help', 'init', 'version'])
  let index = 0
  for (; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('-') && commands.has(arg) && args.positional.length === 0) {
      args.command = arg as Args['command']
      continue
    }
    if (arg.startsWith('-')) {
      const [flag, inline] = arg.split('=', 2)
      const take = () => (inline !== undefined ? inline : argv[++index] ?? '')
      switch (flag) {
        case '-c':
        case '--config':
          args.config = take()
          break
        case '-w':
        case '--workspace':
          args.workspace = take()
          break
        case '-g':
        case '--goal':
          args.goal = take()
          break
        case '-r':
        case '--rounds':
          args.rounds = Number.parseInt(take(), 10)
          break
        case '-m':
        case '--mock':
          args.mock = true
          break
        case '--no-exec':
          args.exec = false
          break
        case '--json':
          args.json = true
          break
        case '--port':
          args.port = Number.parseInt(take(), 10)
          break
        case '--host':
          args.host = take()
          break
        case '--no-open':
          args.open = false
          break
        case '-d':
        case '--debug':
          args.debug = true
          break
        case '-h':
        case '--help':
          args.command = 'help'
          break
        case '-v':
        case '--version':
          args.command = 'version'
          break
        default:
          throw new Error(`未知选项: ${flag}（--help 查看用法）`)
      }
      continue
    }
    args.positional.push(arg)
  }
  return args
}

function makeLogger(debug: boolean, logPath: string): Logger {
  const write = (level: string, args: unknown[]) => {
    if (!debug) return
    const line = `${new Date().toISOString()} ${level} ${args
      .map((item) => (item instanceof Error ? item.stack ?? item.message : typeof item === 'string' ? item : JSON.stringify(item)))
      .join(' ')}\n`
    try {
      appendFileSync(logPath, line, 'utf8')
    } catch {
      // logging must never take the app down
    }
  }
  return {
    debug: (...args) => write('DEBUG', args),
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
  }
}

function silentReporter(): Reporter {
  return {
    phase() {},
    text() {},
    textEnd() {},
    tool() {},
    note() {},
    verdict() {},
    usage() {},
    done() {},
  }
}

function maskKey(key: string): string {
  if (!key) return '(空)'
  if (key.length <= 8) return `${key.slice(0, 2)}***`
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

function resolveConfig(args: Args): { config: AppConfig; notes: string[] } {
  const notes: string[] = []
  const loadOptions = {
    configPath: args.config,
    workspace: args.workspace,
    mock: args.mock,
    exec: args.exec,
    maxRounds: Number.isFinite(args.rounds) ? args.rounds : undefined,
  }
  const found = findConfigFile({ configPath: args.config })
  if (!found) {
    if (!args.mock) {
      notes.push('没有找到配置文件，将使用内置默认值（DeepSeek 端点 + 环境变量 DEEPSEEK_API_KEY）。')
      notes.push('建议先运行 `qzcode init` 生成 qzcode.json。')
    }
    const fallback = normalizeConfig(EXAMPLE_CONFIG, { ...loadOptions, mock: args.mock || !hasAnyKey() })
    if (!args.mock && !hasAnyKey()) {
      notes.push('未检测到任何 API key，已自动切换到 mock 模式（`/mock` 可切回）。')
    }
    return { config: fallback, notes }
  }
  const config = loadConfig(loadOptions)
  return { config, notes }
}

function hasAnyKey(): boolean {  return Boolean(
    process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.MOONSHOT_API_KEY ||
      process.env.ZHIPU_API_KEY,
  )
}

/** Best-effort "open this URL in the default browser"; never fatal. */
function openBrowser(url: string): void {
  const command =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/d', '/s', '/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] }
  try {
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Headless machines: printing the URL is enough.
  }
}

function printConfig(config: AppConfig): void {
  const lines: string[] = []
  lines.push(`配置文件: ${config.path || '(未找到)'}`)
  lines.push(`工作区:   ${config.workspace}`)
  lines.push(`轮次:     ${config.maxRounds}`)
  lines.push(`最大步骤: ${config.maxSteps}`)
  lines.push(`命令执行: ${config.exec.enabled ? 'on' : 'off'} (timeout ${config.exec.timeoutMs}ms)`)
  lines.push(`插件:     ${config.plugins.length > 0 ? config.plugins.join(', ') : '(无)'}`)
  const dsh = config.dshNodeModules ?? detectDshAppDir()
  lines.push(`DSH 安装: ${dsh ?? '(未检测到，@deepseek-ai/* 导入将不可用)'}`)
  for (const role of ROLE_NAMES) {
    const cfg = config.roles[role]
    lines.push(
      `\n[${role}]\n  provider : ${cfg.provider}\n  baseUrl  : ${cfg.baseUrl}\n  model    : ${cfg.model}\n  apiKey   : ${maskKey(cfg.apiKey)}\n  temp     : ${cfg.temperature}\n  maxTokens: ${cfg.maxTokens}\n  mock     : ${cfg.mock}`,
    )
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

function printPlugins(records: PluginRecord[], config: AppConfig): void {
  const dsh = config.dshNodeModules ?? detectDshAppDir()
  const lines = [`qzcode 插件`, `DSH 安装: ${dsh ?? '(未检测到)'}`, '']
  if (records.length === 0) {
    lines.push('(没有配置插件；在 qzcode.json 的 plugins[] 里加路径)')
  }
  for (const record of records) {
    lines.push(`${record.status === 'active' ? '✔' : record.status === 'skipped' ? '○' : '✘'} ${record.name}`)
    lines.push(`   source: ${record.source}`)
    if (record.detail) lines.push(`   detail: ${record.detail}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function main(argv: string[]): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }

  if (args.command === 'help') {
    process.stdout.write(`${HELP.trim()}\n`)
    return 0
  }
  if (args.command === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    process.stdout.write(`qzcode ${pkg.version} · by QZzwj (node ${process.version})\n`)
    return 0
  }
  if (args.command === 'init') {
    const target = resolve(args.positional[0] ?? args.config ?? 'qzcode.json')
    if (existsSync(target)) {
      process.stderr.write(`已存在: ${target}\n`)
      return 1
    }
    writeExampleConfig(target)
    process.stdout.write(`已生成 ${target}\n下一步：填入 roles.* 的 apiKey（或设置 DEEPSEEK_API_KEY），然后运行 qzcode\n`)
    return 0
  }

  const { config, notes } = resolveConfig(args)
  const logDir = join(config.root || process.cwd(), '.qzcode')
  const logger = makeLogger(args.debug, join(logDir, 'debug.log'))
  const notices: string[] = [...notes]

  const problems = config.roles.planner.mock ? [] : validateConfig(config)
  if (problems.length > 0) {
    process.stderr.write(`配置有问题：\n${problems.map((p) => `  - ${p}`).join('\n')}\n`)
    process.stderr.write('提示：`qzcode init` 生成模板，或加 --mock 用脚本化模型先跑通。\n')
    return 1
  }

  const ctx = createContext('qzcode', logger)
  const toolbox = new Toolbox(createTools())
  const toolRuntime = { workspace: config.workspace, exec: config.exec }
  const commands = new CommandRegistry()
  ctx.set('commands', commands)
  wireHost(ctx, toolbox)

  if (args.command === 'config') {
    printConfig(config)
    return 0
  }

  let records: PluginRecord[] = []
  try {
    records = await loadPlugins({
      ctx,
      config,
      toolbox,
      logger,
      notify(message, level) {
        notices.push(message)
        logger.info('plugin notify', message, level ?? 'info')
      },
    })
  } catch (error) {
    process.stderr.write(`插件加载失败: ${(error as Error).message}\n`)
    return 1
  }

  if (args.command === 'plugins') {
    printPlugins(records, config)
    return 0
  }

  if (args.command === 'web') {
    const server = await createWebServer({
      config,
      toolbox,
      toolRuntime,
      plugins: records,
      commands,
      logger,
      host: args.host,
      port: args.port,
      emit: (event, payload) => ctx.emit(event, payload),
    })
    process.stdout.write(`qzcode GUI: ${server.url}\n`)
    process.stdout.write('（Ctrl+C 结束）\n')
    for (const note of notices) process.stdout.write(`· ${note}\n`)
    if (args.open) openBrowser(server.url)
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        resolve()
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })
    await server.close()
    ctx.dispose()
    process.stdout.write('\n已停止。\n')
    return 0
  }

  if (args.command === 'run') {
    const goal = (args.goal ?? args.positional.join(' ')).trim()
    if (!goal) {
      process.stderr.write('缺少目标。用法: QZcode run "<目标>"\n')
      return 1
    }
    const reporter = args.json ? silentReporter() : createPlainReporter((line) => process.stdout.write(`${line}\n`))
    if (!args.json) {
      for (const note of notices) process.stdout.write(`· ${note}\n`)
    }
    let result: RunResult
    try {
      result = await runPipeline({
        config,
        goal,
        toolbox,
        toolRuntime,
        reporter,
        emit: (event, payload) => ctx.emit(event, payload),
      })
    } catch (error) {
      process.stderr.write(`运行失败: ${(error as Error).message}\n`)
      return 1
    }
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: result.ok,
            rounds: result.rounds,
            tokens: result.usage,
            elapsedMs: result.elapsedMs,
            plan: result.plan,
            verdict: result.verdict,
          },
          null,
          2,
        )}\n`,
      )
    }
    return result.ok ? 0 : 2
  }

  // interactive TUI
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('当前不是交互式终端。用 `qzcode run "<目标>"` 一次性执行，或加 --goal。\n')
    return 1
  }
  const goal = args.goal ?? (args.positional.join(' ').trim() || undefined)
  try {
    await runTui({
      config,
      toolbox,
      toolRuntime,
      plugins: records,
      commands,
      goal,
      autoStart: Boolean(goal),
      notices,
      emit: (event, payload) => ctx.emit(event, payload),
    })
  } finally {
    ctx.dispose()
  }
  return 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`未捕获错误: ${(error as Error).stack ?? error}\n`)
    process.exitCode = 1
  })
