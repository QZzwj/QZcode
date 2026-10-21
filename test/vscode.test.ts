import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { removeDir, sleep, tempWorkspace } from './helpers.ts'

const require = createRequire(import.meta.url)
const lib = require('../vscode/lib.cjs') as {
  parseServerUrl(text: string): string | null
  browserUrl(url: string): string
  buildServerArgs(options: Record<string, unknown>): string[]
  resolveCliPath(options: Record<string, unknown>): { path: string; source: string } | null
  peerVersionDirs(extensionPath: string): string[]
  resolveConfigFile(options: Record<string, unknown>): string
  resolveConfigTarget(options: {
    setting?: string
    workspaceFolders?: string[]
    globalDir?: string
  }): { path: string; source: string; exists: boolean } | null
  escapeHtml(value: string): string
  workbenchHtml(options: {
    cspSource: string
    styleUri: string
    scriptUri: string
    logoUri: string
    nonce: string
    baseUrl: string
  }): string
  settingsWebviewHtml(options: {
    cspSource: string
    styleUri: string
    scriptUri: string
    nonce: string
    serverOrigin?: string
  }): string
  chatWebviewHtml(options: {
    cspSource: string
    styleUri: string
    scriptUri: string
    nonce: string
    serverOrigin?: string
  }): string
  goalFromSelection(options: Record<string, unknown>): string
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(repoRoot, 'src', 'cli.ts')

test('the manifest is branded QZcode and every contributed id is namespaced', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'vscode', 'package.json'), 'utf8')) as {
    name: string
    displayName: string
    main: string
    icon: string
    activationEvents: string[]
    contributes: {
      commands: { command: string; title: string }[]
      viewsContainers: {
        activitybar?: { id: string; icon: string; when?: string }[]
        secondarySidebar?: { id: string; icon: string; when?: string }[]
      }
      views: Record<string, { id: string; type?: string }[]>
      configuration: { properties: Record<string, unknown> }
    }
  }
  assert.equal(manifest.name, 'qzcode')
  assert.equal(manifest.displayName, 'QZcode')
  assert.ok(readFileSync(join(repoRoot, 'vscode', manifest.main), 'utf8').length > 0)

  // 面板要挂在右侧栏（secondarySidebar），不是左侧活动栏
  assert.ok(manifest.contributes.viewsContainers.secondarySidebar, '视图必须挂在右侧栏')
  const container = manifest.contributes.viewsContainers.secondarySidebar[0]
  assert.equal(container.id, 'qzcode')
  assert.equal(container.icon, 'media/icon.png', '侧栏图标用品牌 logo（PNG，透明底，白/黑主题都能看清）')
  // 只允许一个容器：多一个容器在侧栏里就会多出一个"QZcode"图标
  assert.deepEqual(Object.keys(manifest.contributes.viewsContainers), ['secondarySidebar'])
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar.length, 1)

  
  // 扩展列表里的图标仍是 PNG（彩色，白底黑底都能看清那种）
  const pngPath = join(repoRoot, 'vscode', manifest.icon)
  assert.ok(existsSync(pngPath), `icon must exist: ${manifest.icon}`)
  assert.ok(readFileSync(pngPath).length > 1000, '扩展图标不能是空文件')
  // 主界面是侧栏里的 webview 聊天，不是一个占满屏幕的 iframe 面板。两套容器只会出现一套。
    assert.deepEqual(Object.keys(manifest.contributes.views), ['qzcode'])
  const primary = manifest.contributes.views.qzcode ?? []
  assert.deepEqual(primary.map((view) => view.id), ['qzcode.chat'])
  assert.equal(primary[0].type, 'webview', '侧栏应该是 webview 视图')
  assert.ok(manifest.activationEvents.includes('onView:qzcode.chat'), 'view must activate on open')

  const commandIds = manifest.contributes.commands.map((command) => command.command)
  assert.equal(commandIds.length, 14)
  for (const id of commandIds) {
    assert.match(id, /^qzcode\./, `command must be namespaced: ${id}`)
  }
  for (const command of manifest.contributes.commands) {
    // 品牌走 category：命令面板显示 "QZcode: 新建任务…"，侧栏标题栏只显示标题
    const entry = command as { command: string; title: string; category?: string }
    assert.equal(entry.category, 'QZcode', `命令要有 QZcode 分类：${entry.command}`)
    assert.doesNotMatch(entry.title, /^QZcode[:：]/, `标题别带前缀（会和分类叠成两个）：${entry.title}`)
  }

  for (const key of Object.keys(manifest.contributes.configuration.properties)) {
    assert.match(key, /^qzcode\./, `setting must be namespaced: ${key}`)
  }

  const activationCommands = manifest.activationEvents
    .filter((event) => event.startsWith('onCommand:'))
    .map((event) => event.slice('onCommand:'.length))
  for (const id of activationCommands) {
    assert.ok(commandIds.includes(id), `activation event points at an unknown command: ${id}`)
  }
  // 反过来断言：不许在启动时激活（打开 VS Code ≠ 要用 QZcode）
  assert.ok(
    !manifest.activationEvents.includes('onStartupFinished'),
    '不该挂在 onStartupFinished 上启动',
  )
})

test('the sidebar chat webview stays inside the CSP and points at media files', () => {
  const html = lib.chatWebviewHtml({
    cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
    styleUri: 'https://file+.vscode-resource.vscode-cdn.net/media/chat.css',
    scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/chat.js',
    nonce: 'nonce42',
  })
  assert.ok(!html.includes('__CSP__'), 'CSP 占位符必须被替换')
  assert.ok(!html.includes('__SCRIPT__') && !html.includes('__STYLE__'))
  assert.match(html, /connect-src http:\/\/127\.0\.0\.1:\*/, '只允许连本地服务')
  assert.match(html, /script-src 'nonce-nonce42'/)
  assert.match(html, /src="[^"]*media\/chat\.js"/)
  assert.match(html, /href="[^"]*media\/chat\.css"/)
  assert.match(html, /default-src 'none'/)
  assert.ok(!html.includes('unsafe-eval'))

  // 视图资源必须真实存在，否则侧栏会是一片空白
  for (const file of ['chat.css', 'chat.js']) {
    const full = join(repoRoot, 'vscode', 'media', file)
    assert.ok(existsSync(full), `missing media/${file}`)
    assert.ok(readFileSync(full).length > 300, `media/${file} 太小`)
  }
  // 页面本体是 pages.cjs 里的模板字符串：安装包里不许再有 .html
  const pages = readFileSync(join(repoRoot, 'vscode', 'pages.cjs'), 'utf8')
  assert.match(pages, /CHAT_PAGE/, '聊天页模板')
  assert.match(pages, /SETTINGS_PAGE/, '设置页模板')
  assert.equal(
    existsSync(join(repoRoot, 'vscode', 'media', 'chat.html')),
    false,
    'media 里不该再放 chat.html（页面由 pages.cjs 生成）',
  )
})

test('parseServerUrl picks the url out of server output', () => {
  assert.equal(lib.parseServerUrl('qzcode GUI: http://127.0.0.1:4319/\n'), 'http://127.0.0.1:4319')
  assert.equal(
    lib.parseServerUrl('noise\nsome log\nqzcode GUI: http://127.0.0.1:52311/\n（Ctrl+C 结束）\n'),
    'http://127.0.0.1:52311',
  )
  assert.equal(lib.parseServerUrl('还在启动…'), null)
})

test('browserUrl rewrites wildcard hosts', () => {
  assert.equal(lib.browserUrl('http://0.0.0.0:4000/'), 'http://127.0.0.1:4000/')
  assert.equal(lib.browserUrl('http://127.0.0.1:4000/'), 'http://127.0.0.1:4000/')
})

test('buildServerArgs mirrors the CLI flags', () => {
  const args = lib.buildServerArgs({
    cliPath: 'C:/pi/src/cli.ts',
    workspace: 'C:/work',
    configFile: 'C:/work/qzcode.json',
    mock: true,
    exec: false,
    rounds: 4,
    debug: true,
    port: 0,
  })
  assert.deepEqual(args, [
    'C:/pi/src/cli.ts',
    'web',
    '--no-open',
    '--port',
    '0',
    '--workspace',
    'C:/work',
    '--config',
    'C:/work/qzcode.json',
    '--mock',
    '--no-exec',
    '--rounds',
    '4',
    '--debug',
  ])
  const minimal = lib.buildServerArgs({ cliPath: 'x', port: 0, exec: true })
  assert.deepEqual(minimal, ['x', 'web', '--no-open', '--port', '0'])
})

test('resolveCliPath prefers the setting, then the bundled backend, then the repo', () => {
  const fromSetting = lib.resolveCliPath({ setting: cliPath, workspaceFolders: [], extensionPath: '' })
  assert.equal(fromSetting?.source, 'setting')
  assert.equal(fromSetting?.path, cliPath)

  // 扩展自带的后端：装好即用，不需要仓库
  const bundledPath = join(repoRoot, 'vscode', 'backend', 'dist', 'cli.js')
  assert.ok(existsSync(bundledPath), '缺少 vscode/backend/dist/cli.js（npm run bundle:backend 生成）')
  const fromBundled = lib.resolveCliPath({
    setting: '',
    workspaceFolders: [],
    extensionPath: join(repoRoot, 'vscode'),
  })
  assert.equal(fromBundled?.source, 'bundled')
  assert.equal(fromBundled?.path, bundledPath)

  const fromSibling = lib.resolveCliPath({
    setting: '',
    workspaceFolders: ['C:/nope'],
    extensionPath: join(repoRoot, 'vscode'),
  })
  assert.equal(fromSibling?.source, 'bundled', '自带后端优先于兄弟仓库')

  assert.equal(lib.resolveCliPath({ setting: '', workspaceFolders: ['C:/nope'], extensionPath: 'C:/nope2' }), null)
})

test('resolveConfigFile looks at setting, workspace, then global storage', () => {
  const dir = tempWorkspace('configfind')
  try {
    const workspaceConfig = join(dir, 'qzcode.json')
    writeFileSync(workspaceConfig, '{"maxRounds":2}', 'utf8')
    const globalDir = join(dir, 'global')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, 'qzcode.json'), '{"maxRounds":5}', 'utf8')

    assert.equal(lib.resolveConfigFile({ setting: workspaceConfig, workspaceFolders: [dir], globalDir }), workspaceConfig)
    assert.equal(lib.resolveConfigFile({ setting: '', workspaceFolders: [dir], globalDir }), workspaceConfig)
    assert.equal(lib.resolveConfigFile({ setting: '', workspaceFolders: [join(dir, 'empty')], globalDir }), join(globalDir, 'qzcode.json'))
    assert.equal(lib.resolveConfigFile({ setting: '', workspaceFolders: [], globalDir: '' }), '')
  } finally {
    removeDir(dir)
  }
})

test('the bundled backend runs on its own, without the repo', { timeout: 40_000 }, async () => {
  const bundled = join(repoRoot, 'vscode', 'backend', 'dist', 'cli.js')
  const dir = tempWorkspace('standalone')
  const outPath = join(dir, 'stdout.log')
  const errPath = join(dir, 'stderr.log')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  // 用扩展真正会用的参数：--config 指向"用户目录"里的配置，workspace 指向用户项目
  const configPath = join(dir, 'qzcode.json')
  const child = spawn(
    process.execPath,
    [bundled, 'web', '--mock', '--no-open', '--port', '0', '--workspace', dir, '--config', configPath],
    { cwd: dir, stdio: ['ignore', outFd, errFd], windowsHide: true },
  )
  closeSync(outFd)
  closeSync(errFd)

  try {
    let url: string | null = null
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !url) {
      await sleep(100)
      url = lib.parseServerUrl(readFileSync(outPath, 'utf8'))
    }
    assert.ok(url, `自带后端没起来：${readFileSync(outPath, 'utf8')} ${readFileSync(errPath, 'utf8')}`)

    const health = await fetch(`${url}/api/health`)
    assert.equal(health.status, 200)
    // 只做插件：后端只提供 API，不再提供任何网页
    for (const route of ['/', '/chat', '/app.js']) {
      const response = await fetch(`${url}${route}`)
      assert.equal(response.status, 404, `${route} 不该再提供网页`)
    }
    const providers = (await (await fetch(`${url}/api/providers`)).json()) as { providers: unknown[] }
    assert.ok(providers.providers.length >= 5)
  } finally {
    child.kill()
    await sleep(100)
    removeDir(dir)
  }
})

test('goalFromSelection keeps the selected code and the user instruction', () => {
  const goal = lib.goalFromSelection({
    selection: 'export const x = 1',
    filePath: 'src/a.ts',
    instruction: '加一个 y',
  })
  assert.match(goal, /加一个 y/)
  assert.match(goal, /src\/a\.ts/)
  assert.match(goal, /export const x = 1/)
  assert.ok(!goal.includes('undefined'))
  assert.equal(lib.goalFromSelection({ selection: '', instruction: '只给指令' }), '只给指令')
})

test('the spawned server prints a url the extension can use, and answers the API', { timeout: 40_000 }, async () => {
  const dir = tempWorkspace('vscode')
  // 沙箱里不能给子进程接管道，所以走"输出重定向到文件"，扩展那边拿到的是同样的 stdout。
  const outPath = join(dir, 'stdout.log')
  const errPath = join(dir, 'stderr.log')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  const child = spawn(process.execPath, [cliPath, 'web', '--mock', '--no-open', '--port', '0', '--workspace', dir], {
    cwd: repoRoot,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  })
  closeSync(outFd)
  closeSync(errFd)

  try {
    let url: string | null = null
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !url) {
      await sleep(100)
      url = lib.parseServerUrl(readFileSync(outPath, 'utf8'))
    }
    assert.ok(url, `服务没有打印 URL：${readFileSync(outPath, 'utf8')} ${readFileSync(errPath, 'utf8')}`)

    const health = await fetch(`${url}/api/health`)
    assert.equal(health.status, 200)

    const started = await fetch(`${url}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '从 VS Code 发起的任务' }),
    })
    assert.equal(started.status, 200)
    const { runId } = (await started.json()) as { runId: string }

    let status = 'running'
    const runDeadline = Date.now() + 25_000
    while (Date.now() < runDeadline && status === 'running') {
      await sleep(150)
      const snapshot = (await (await fetch(`${url}/api/run?id=${runId}`)).json()) as { status: string }
      status = snapshot.status
    }
    assert.equal(status, 'passed', 'GUI 服务跑完一轮 mock 流水线')

  } finally {
    child.kill()
    await sleep(100)
    removeDir(dir)
  }
})

test('模型设置面板的 HTML 也在 CSP 里，并且指向 media 文件', () => {
  const html = lib.settingsWebviewHtml({
    cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
    styleUri: 'https://file+.vscode-resource.vscode-cdn.net/media/settings.css',
    scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/settings.js',
    nonce: 'n42',
  })
  assert.ok(!html.includes('__CSP__') && !html.includes('__SCRIPT__') && !html.includes('__STYLE__'))
  assert.match(html, /default-src 'none'/)
  assert.match(html, /script-src 'nonce-n42'/)
  assert.match(html, /connect-src http:\/\/127\.0\.0\.1:\*/)
  assert.match(html, /id="cards"/)
  assert.match(html, /src="[^"]*media\/settings\.js"/)
  assert.match(html, /href="[^"]*media\/settings\.css"/)
  for (const file of ['settings.css', 'settings.js']) {
    const full = join(repoRoot, 'vscode', 'media', file)
    assert.ok(existsSync(full), `缺少 media/${file}`)
    assert.ok(readFileSync(full).length > 400, `media/${file} 太小`)
  }
  assert.equal(
    existsSync(join(repoRoot, 'vscode', 'media', 'settings.html')),
    false,
    'media 里不该再放 settings.html',
  )

  // 供应商必须能完全自定义：面板要能改写下面每一个字段
  const script = readFileSync(join(repoRoot, 'vscode', 'media', 'settings.js'), 'utf8')
  assert.match(script, /自定义（手动填写全部字段）/, '供应商下拉里要有自定义入口')
  assert.match(script, /获取模型/, '要能从端点拉模型列表')
  assert.match(script, /cardStatus/, '测试/保存的反馈要写在对应卡片下面，不能只丢在面板底栏')
  assert.match(script, /setRoleStatus/, '反馈按角色落到各自卡片')
  assert.match(script, /modelSelects/, '拉到列表后要能变成下拉选择')
  for (const token of ['provider', 'baseUrl', 'model', 'apiKey', 'temperature', 'maxTokens', 'headers', 'timeoutMs', 'retries']) {
    assert.ok(script.includes(token), `设置面板必须能填 ${token}`)
  }
})
test('本版本后端被清掉时，借用相邻已安装版本（升级过程中的自救）', () => {
  const root = tempWorkspace('peerq')
  try {
    // 模拟 %USERPROFILE%\.vscode\extensions 下的两个版本
    const oldDir = join(root, 'qzcode.qzcode-0.7.0')
    const newDir = join(root, 'qzcode.qzcode-0.7.1')
    mkdirSync(join(newDir, 'backend', 'dist'), { recursive: true })
    mkdirSync(join(oldDir, 'backend', 'dist'), { recursive: true })
    writeFileSync(join(newDir, 'backend', 'dist', 'cli.js'), '// new', 'utf8')
    writeFileSync(join(oldDir, 'backend', 'dist', 'cli.js'), '// old', 'utf8')

    // 旧版本目录在跑，但 dist 文件被删了（正是用户遇到的场景）
    rmSync(join(oldDir, 'backend', 'dist', 'cli.js'))
    const resolved = lib.resolveCliPath({ setting: '', workspaceFolders: [], extensionPath: oldDir })
    assert.equal(resolved?.source, 'bundled-peer', '应该借用相邻版本的后端')
    assert.equal(resolved?.path, join(newDir, 'backend', 'dist', 'cli.js'))

    // 相邻版本也没有时才真的失败
    rmSync(join(newDir, 'backend', 'dist', 'cli.js'))
    assert.equal(lib.resolveCliPath({ setting: '', workspaceFolders: [], extensionPath: oldDir }), null)
  } finally {
    removeDir(root)
  }
})
test('侧栏连不上时会自己重新要地址并重试（不再只丢一句 Failed to fetch）', () => {
  const script = readFileSync(join(repoRoot, 'vscode', 'media', 'chat.js'), 'utf8')
  assert.match(script, /needUrl/, '连不上要向扩展要新地址')
  assert.match(script, /waitForUrl/, '要等地址回来')
  assert.match(script, /restartServer/, '要能一键重启后端')
  assert.match(script, /attempts = 2/, '至少重试一次')
  const ext = readFileSync(join(repoRoot, 'vscode', 'extension.cjs'), 'utf8')
  assert.match(ext, /pushFreshUrl/, '扩展要能探活并重推地址')
  assert.match(ext, /api\/health/, '要先探活再决定要不要重启')
})
test('侧栏有强制停止：发送键二合一 + Esc + 命令', () => {
  const page = readFileSync(join(repoRoot, 'vscode', 'pages.cjs'), 'utf8')
  // 停止和发送合成一个按钮：页面里只有一个 #send
  assert.doesNotMatch(page, /id="stop"/, '不该再有独立的停止按钮')
  assert.match(page, /id="send"/, '发送/停止共用一个按钮')
  assert.match(page, /class="icon-stop"/, '忙碌时把箭头换成停止方块')
  const script = readFileSync(join(repoRoot, 'vscode', 'media', 'chat.js'), 'utf8')
  assert.match(script, /async function stopRun/, '停止逻辑')
  assert.match(script, /api\/cancel/, '要真的打取消接口')
  assert.match(script, /Escape/, 'Esc 也能停')
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'vscode', 'package.json'), 'utf8'))
  const cancelCommand = pkg.contributes.commands.find((item: { command: string }) => item.command === 'qzcode.cancelRun')
  assert.ok(cancelCommand, '命令面板要有 QZcode: 强制停止当前运行')
})
test('打开配置的顺序和运行时一致：设置 → 工作区 → 全局存储', () => {
  const root = tempWorkspace('config-target')
  try {
    const workspace = join(root, 'ws')
    const globalDir = join(root, 'global')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(globalDir, { recursive: true })

    // 都没有：落在最后一个候选（全局存储），并标 exists=false
    const none = lib.resolveConfigTarget({ setting: '', workspaceFolders: [workspace], globalDir })
    assert.equal(none?.exists, false)
    assert.equal(none?.source, 'global', '没有文件时应该提示在全局存储里生成，而不是工作区')

    // 只有全局存储有（用户现在的真实情况）：必须找到它，别说"还没有配置"
    writeFileSync(join(globalDir, 'qzcode.json'), '{}', 'utf8')
    const globalOnly = lib.resolveConfigTarget({ setting: '', workspaceFolders: [workspace], globalDir })
    assert.equal(globalOnly?.exists, true)
    assert.equal(globalOnly?.source, 'global')
    assert.equal(globalOnly?.path, join(globalDir, 'qzcode.json'))

    // 工作区也有一份：工作区优先（后端起服务时也是这样）
    writeFileSync(join(workspace, 'qzcode.json'), '{}', 'utf8')
    const both = lib.resolveConfigTarget({ setting: '', workspaceFolders: [workspace], globalDir })
    assert.equal(both?.source, 'workspace')

    // 设置里指定了就最优先
    const explicit = join(root, 'explicit.json')
    writeFileSync(explicit, '{}', 'utf8')
    const withSetting = lib.resolveConfigTarget({ setting: explicit, workspaceFolders: [workspace], globalDir })
    assert.equal(withSetting?.source, 'setting')
  } finally {
    removeDir(root)
  }
})

test('加载速度：只在打开侧栏时激活，不在启动时预热后端', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'vscode', 'package.json'), 'utf8')) as {
    activationEvents: string[]
  }
  // 打开 VS Code 不该激活：只允许 onView + onCommand（onCommand 只在点命令时才触发）
  const events = pkg.activationEvents
  assert.ok(events.includes('onView:qzcode.chat'), '打开侧栏要能激活')
  assert.ok(!events.includes('onStartupFinished'), '不许在启动时激活')
  for (const event of events) {
    assert.match(event, /^(onView:qzcode\.chat|onCommand:qzcode\.)/, `只允许 onView / onCommand：${event}`)
  }
  // 每个菜单里能点的命令都必须有 onCommand，否则就是 command not found
  const pkgCommands = (JSON.parse(readFileSync(join(repoRoot, 'vscode', 'package.json'), 'utf8')) as {
    contributes: { commands: { command: string }[] }
  }).contributes.commands
  for (const item of pkgCommands) {
    assert.ok(events.includes(`onCommand:${item.command}`), `缺少激活事件: ${item.command}`)
  }

  const ext = readFileSync(join(repoRoot, 'vscode', 'extension.cjs'), 'utf8')
  // activate 里不许有同步等待后端的调用
  const activateBody = ext.slice(ext.indexOf('function activate('), ext.indexOf('function deactivate('))
  assert.doesNotMatch(activateBody, /^ {2}await ensureServer\(\)/m, 'activate 顶层不许 await 后端（命令回调里可以有）')
  assert.doesNotMatch(activateBody, /^ {2}void ensureServer\(\)/m, 'activate 顶层不许立刻预热后端（只能在延迟里预热）')
  // autoStart 必须延迟，不占激活时间
  assert.match(activateBody, /setTimeout\(\(\) => \{[\s\S]*?ensureServer\(\)[\s\S]*?\}, 1500\)/, 'autoStart 要延迟预热')

  // 有计时打点，慢的时候能从日志看出来
  assert.match(ext, /\[perf\] activate 完成/, '要打激活耗时')
  assert.match(ext, /\[perf\] 后端就绪/, '要打后端就绪耗时')
  // cli 路径缓存：重启不再扫盘
  assert.match(ext, /cliPathCache/, '要缓存 cli 路径')

  // 面板在等后端时要有明确状态
  const chat = readFileSync(join(repoRoot, 'vscode', 'media', 'chat.js'), 'utf8')
  assert.match(chat, /正在启动后端/, '等后端期间要有状态提示')
})

test('工作区监听：服务没起来时不误重启（否则加载时间翻倍）', () => {
  const ext = readFileSync(join(repoRoot, 'vscode', 'extension.cjs'), 'utf8')
  const guard = /if \(!next \|\| !runtime\.workspace \|\| next === runtime\.workspace\) return/
  assert.match(ext, guard, 'workspaceChanged 必须先判断"服务是否已就绪"')
})

test('打包清单必须覆盖所有 require（否则装完就打不开）', () => {
  const ignore = readFileSync(join(repoRoot, 'vscode', '.vscodeignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  // 白名单模式：第一行是 '*'，后面的 '!xxx' 才是真正被打包进去的
  const allowed = (file: string): boolean =>
    ignore.some((rule) => {
      if (!rule.startsWith('!')) return false
      const pattern = rule.slice(1)
      if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -3))
      return file === pattern
    })

  for (const entry of ['extension.cjs', 'lib.cjs']) {
    const source = readFileSync(join(repoRoot, 'vscode', entry), 'utf8')
    const requires = [...source.matchAll(/require\('\.\/([^']+)'\)/g)].map((match) => match[1])
    for (const required of requires) {
      assert.ok(
        existsSync(join(repoRoot, 'vscode', required)),
        `${entry} 引用的 ${required} 不存在`,
      )
      assert.ok(
        allowed(required),
        `.vscodeignore 没把 ${required} 放进包里（${entry} 会 require 失败，扩展打不开）`,
      )
    }
  }

  for (const file of ['extension.cjs', 'lib.cjs', 'pages.cjs', 'package.json']) {
    assert.ok(allowed(file), `${file} 必须在打包白名单里`)
  }
})

test('侧栏空状态：L 管全程，A→B→C 是执行链', () => {
  const page = readFileSync(join(repoRoot, 'vscode', 'pages.cjs'), 'utf8')
  const flow = page.slice(page.indexOf('class="empty-flow"'), page.indexOf('id="examples"'))
  assert.match(flow, /class="role-l"[^]*?管全程/, 'L 要写成"管全程"，不是"分流"')
  assert.doesNotMatch(flow, /角色-l[^]*?>\s*分流/, '不能把 L 降级成一次性分流')
  // 执行链里 A 才是写任务书的那个人
  const chain = page.slice(page.indexOf('class="empty-chain"'))
  assert.match(chain, /role-a">A<\/b>写任务书/, 'A 负责写任务书')
  assert.match(chain, /role-b">B<\/b>实现/, 'B 负责实现')
  assert.match(chain, /role-c">C<\/b>核验/, 'C 负责核验')

  // L 的提示词也要说清自己是主控（管全程），不是"流水线之前的判断者"
  const leader = readFileSync(join(repoRoot, 'src', 'prompts', 'leader.md'), 'utf8')
  assert.match(leader, /主控/, 'L 的定位是主控')
  assert.match(leader, /管的是全程/, '要写清管全程')
})
