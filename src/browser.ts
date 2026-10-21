import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 浏览器验证：给 C（和 B 自测）一个真的能开浏览器的工具。
 *
 * 不装任何依赖——用机器上已有的 Chromium（Playwright 缓存里的 > Chrome > Edge），
 * 通过 DevTools Protocol 驱动：真鼠标按下/抬起、真空格按住、真触屏、截图、读 DOM。
 * 这样"浏览器没验证"就从模型嘴里的免责声明，变成一条可执行步骤。
 */

export interface BrowserCandidate {
  path: string
  source: string
}

/** 找一个能用的 Chromium：Playwright 缓存 → Chrome → Edge。 */
export function findBrowser(override?: string): BrowserCandidate | null {
  if (override && existsSync(override)) return { path: override, source: 'config' }

  const local = process.env.LOCALAPPDATA ?? process.env.HOME ?? ''
  const playwrightRoot = join(local, 'ms-playwright')

  // Playwright 的目录名带版本号（chromium-1243 / chromium_headless_shell-1148…），取最新的
  if (existsSync(playwrightRoot)) {
    try {
      const dirs = readdirSync(playwrightRoot)
        .filter((name) => name.startsWith('chromium'))
        .sort()
        .reverse()
      for (const dir of dirs) {
        const candidates = [
          join(playwrightRoot, dir, 'chrome-win', 'chrome.exe'),
          join(playwrightRoot, dir, 'chrome-linux', 'chrome'),
          join(playwrightRoot, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        ]
        const hit = candidates.find((item) => existsSync(item))
        if (hit) return { path: hit, source: `playwright/${dir}` }
      }
    } catch {
      // 读不动就往下找
    }
  }

  const standard = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(local, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  const found = standard.find((item) => existsSync(item))
  return found ? { path: found, source: 'system' } : null
}

const KEY_CODES: Record<string, { key: string; code: string; keyCode: number }> = {
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 },
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))))
    })
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface OpenOptions {
  /** 网址或本地文件路径（相对路径按工作区解析）。 */
  target: string
  width?: number
  height?: number
  mobile?: boolean
  /** 导航后额外等待的毫秒数（等动画/首帧）。 */
  settleMs?: number
}

export interface BrowserStatus {
  running: boolean
  browser: string | null
  source: string | null
  url: string | null
}

/**
 * 一个浏览器会话。所有方法都是"做一件事 + 返回可读结果"，
 * 出错时抛出带可操作提示的 Error（比如没装浏览器该装什么）。
 */
export class BrowserSession {
  private child: ChildProcess | null = null
  private socket: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private port = 0
  private currentUrl = ''
  private browserPath = ''
  private browserSource = ''
  private userDataDir = ''
  private viewport = { width: 1280, height: 800, mobile: false }

  status(): BrowserStatus {
    return {
      running: this.child !== null,
      browser: this.browserPath || null,
      source: this.browserSource || null,
      url: this.currentUrl || null,
    }
  }

  /** 启动（如果没启动）并打开页面。 */
  async open(options: OpenOptions): Promise<{ url: string; title: string; viewport: string }> {
    const target = this.resolveTarget(options.target)
    await this.launch()
    const width = options.width ?? this.viewport.width
    const height = options.height ?? this.viewport.height
    const mobile = options.mobile ?? this.viewport.mobile
    await this.setViewport(width, height, mobile)
    await this.navigate(target)
    const settle = options.settleMs ?? 600
    if (settle > 0) await sleep(settle)
    const title = String(await this.evaluate('document.title'))
    return {
      url: target,
      title,
      viewport: `${width}x${height}${mobile ? '（移动端）' : ''}`,
    }
  }

  private resolveTarget(target: string): string {
    if (/^(https?|file|data|about):/i.test(target)) return target
    // 本地路径：转成 file:// 并统一斜杠
    const absolute = target.replace(/\\/g, '/')
    const prefixed = absolute.startsWith('/') ? absolute : `/${absolute}`
    return `file://${encodeURI(prefixed).replace(/#/g, '%23')}`
  }

  private async launch(): Promise<void> {
    if (this.child) return
    if (typeof WebSocket !== 'function') {
      throw new Error('这个 Node 版本没有内置 WebSocket（需要 Node ≥ 22），无法驱动浏览器')
    }
    const found = findBrowser(process.env.QZCODE_BROWSER)
    if (!found) {
      throw new Error(
        '没找到可用的 Chromium：装了 Chrome/Edge 就能用；' +
          '或者用 Playwright 拉一份（npx playwright install chromium），也可以用 QZCODE_BROWSER 指定路径',
      )
    }
    this.browserPath = found.path
    this.browserSource = found.source
    this.port = await freePort()
    this.userDataDir = join(tmpdir(), `qz-browser-${Date.now().toString(36)}`)

    this.child = spawn(
      found.path,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--hide-scrollbars',
        '--mute-audio',
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.userDataDir}`,
        `--window-size=${this.viewport.width},${this.viewport.height}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    this.child.on('exit', () => {
      this.child = null
      this.socket = null
    })

    // 等 DevTools 端口就绪
    let wsUrl = ''
    for (let i = 0; i < 100 && !wsUrl; i++) {
      await sleep(150)
      try {
        const list = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as {
          type?: string
          webSocketDebuggerUrl?: string
        }[]
        const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl
      } catch {
        // 还没起来
      }
    }
    if (!wsUrl) {
      this.close()
      throw new Error('浏览器起来了但 DevTools 端口没响应（可能被安全软件拦了）')
    }

    this.socket = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket as WebSocket
      const timer = setTimeout(() => reject(new Error('连 DevTools 超时')), 10_000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('连 DevTools 失败'))
      })
      socket.addEventListener('message', (event) => {
        let payload: { id?: number; result?: unknown; error?: { message?: string } }
        try {
          payload = JSON.parse(String((event as MessageEvent).data))
        } catch {
          return
        }
        if (typeof payload.id !== 'number') return
        const entry = this.pending.get(payload.id)
        if (!entry) return
        this.pending.delete(payload.id)
        if (payload.error) entry.reject(new Error(payload.error.message ?? 'CDP 出错'))
        else entry.resolve(payload.result)
      })
    })

    await this.send('Page.enable')
    await this.send('Runtime.enable')
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('浏览器没启动'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  private async navigate(url: string): Promise<void> {
    await this.send('Page.navigate', { url })
    // 等 readyState=complete（最多 15s）
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      try {
        const state = await this.evaluate('document.readyState')
        if (state === 'complete') break
      } catch {
        // 导航中会短暂报错
      }
    }
    this.currentUrl = url
  }

  async setViewport(width: number, height: number, mobile: boolean): Promise<void> {
    this.viewport = { width, height, mobile }
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: mobile ? 3 : 1,
      mobile,
    })
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }
    if (result.exceptionDetails) {
      throw new Error(`页面里执行出错：${result.exceptionDetails.exception?.description ?? '未知'}`)
    }
    return result.result?.value
  }

  /** 按住鼠标（用于蓄力类交互），松开由 release 完成。 */
  async mouseDown(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    })
  }

  async mouseUp(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    })
  }

  /** 点一下（按下 + 抬起）。 */
  async click(x: number, y: number): Promise<void> {
    await this.mouseDown(x, y)
    await sleep(60)
    await this.mouseUp(x, y)
  }

  /** 按住指定时长再松开——"蓄力"类操作就靠它。 */
  async hold(ms: number, options: { x?: number; y?: number; key?: string } = {}): Promise<void> {
    const x = options.x ?? this.viewport.width / 2
    const y = options.y ?? this.viewport.height / 2
    if (options.key) {
      await this.keyDown(options.key)
      await sleep(ms)
      await this.keyUp(options.key)
      return
    }
    await this.mouseDown(x, y)
    await sleep(ms)
    await this.mouseUp(x, y)
  }

  async keyDown(name: string): Promise<void> {
    const spec = KEY_CODES[name] ?? { key: name, code: name, keyCode: name.charCodeAt(0) || 0 }
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      text: spec.key.length === 1 ? spec.key : undefined,
    })
  }

  async keyUp(name: string): Promise<void> {
    const spec = KEY_CODES[name] ?? { key: name, code: name, keyCode: name.charCodeAt(0) || 0 }
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    })
  }

  /** 触屏按住再松开（真 touch 事件，走 touchStart/touchEnd）。 */
  async touchHold(ms: number, x?: number, y?: number): Promise<void> {
    const px = x ?? this.viewport.width / 2
    const py = y ?? this.viewport.height / 2
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py }] })
    await sleep(ms)
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  /** 截图，返回写好的文件路径（给人和视觉模型看，文本模型看 eval 结果）。 */
  async screenshot(name: string, outDir?: string): Promise<string> {
    const dir = outDir ?? join(tmpdir(), 'qz-shots')
    mkdirSync(dir, { recursive: true })
    const safe = String(name || 'shot').replace(/[^\w.-]+/g, '-')
    const file = join(dir, safe.endsWith('.png') ? safe : `${safe}.png`)
    const shot = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data?: string }
    if (!shot.data) throw new Error('截图失败')
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    return file
  }

  /** 等一会儿（等动画、等 rAF 推进）。 */
  async wait(ms: number): Promise<void> {
    await sleep(Math.max(0, Math.min(30_000, ms)))
  }

  close(): void {
    try {
      this.socket?.close()
    } catch {
      // 忽略
    }
    this.socket = null
    try {
      this.child?.kill()
    } catch {
      // 忽略
    }
    this.child = null
    // 临时 user-data-dir 不删：Windows 上浏览器退出后可能还占着句柄
  }
}

/** 进程级单例：一个会话跑多次操作，省得每次重开浏览器。 */
let shared: BrowserSession | null = null

export function browserSession(): BrowserSession {
  if (!shared) shared = new BrowserSession()
  return shared
}

export function closeSharedBrowser(): void {
  shared?.close()
  shared = null
}

// 无论正常退出还是测试结束，都别把浏览器进程留下来
process.once('exit', () => {
  try {
    shared?.close()
  } catch {
    // 忽略
  }
})

/** 给提示词用：这台机器上有没有浏览器可用。 */
export function browserAvailability(): { ok: boolean; path?: string; source?: string } {
  const found = findBrowser(process.env.QZCODE_BROWSER)
  return found ? { ok: true, path: found.path, source: found.source } : { ok: false }
}

/** 目录里有没有像样的网页可以验（给环境说明用）。 */
export function looksLikeWebProject(workspace: string): boolean {
  try {
    return readdirSync(workspace).some((name) => {
      if (!/\.html?$/i.test(name)) return false
      try {
        return statSync(join(workspace, name)).isFile()
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}
