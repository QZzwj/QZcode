import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const require2 = createRequire(import.meta.url)
const lib = require2('../vscode/lib.cjs')

/**
 * 生成一张"离线预览页"：直接用扩展里的真页面模板（lib.chatWebviewHtml /
 * settingsWebviewHtml），把资源换成 file:// 绝对路径，再塞一段桩脚本喂假数据。
 *
 * 仓库里因此不需要任何 .html 文件，预览与产品页面也不会漂移。
 */
export function buildPreviewPage({ kind = 'chat', stub = '', name = 'preview' } = {}) {
  const media = new URL('../vscode/media/', import.meta.url)
  const styleUri = new URL(kind === 'chat' ? 'chat.css' : 'settings.css', media).href
  const scriptUri = new URL(kind === 'chat' ? 'chat.js' : 'settings.js', media).href
  const nonce = 'preview'

  const options = {
    cspSource: 'file:',
    styleUri,
    scriptUri,
    nonce,
    serverOrigin: 'http://127.0.0.1:*',
  }
  const html = kind === 'chat' ? lib.chatWebviewHtml(options) : lib.settingsWebviewHtml(options)

  // 把桩脚本插在真脚本之前（同一个 nonce，否则 CSP 会拦）
  const stubTag = `<script nonce="${nonce}">${stub}</script>\n    `
  const marker = `<script nonce="${nonce}" src=`
  const index = html.indexOf(marker)
  if (index < 0) throw new Error('找不到脚本标签，页面模板可能变了')
  const injected = html.slice(0, index) + stubTag + html.slice(index)

  const file = join(tmpdir(), `qz-preview-${name}-${Date.now()}.html`)
  writeFileSync(file, injected, 'utf8')
  return pathToFileURL(file).href
}

/** 常用桩：假 vscode API + 假 EventSource + 假 fetch。 */
export function vscodeStub({ events = [], init = {}, onReady = '' } = {}) {
  return `
    window.__QZ_EVENTS__ = ${JSON.stringify(events)};
    window.__QZ_INIT__ = ${JSON.stringify(init)};
    window.__QZ_READY__ = function () { ${onReady} };

    class FakeEventSource {
      constructor() {
        const list = window.__QZ_EVENTS__ || [];
        let index = 0;
        const tick = () => {
          if (index >= list.length) return;
          if (this.onmessage) this.onmessage({ data: JSON.stringify(list[index++]) });
          window.__QZ_TIMER__ = setTimeout(tick, 90);
        };
        window.__QZ_TIMER__ = setTimeout(tick, 120);
      }
      close() { clearTimeout(window.__QZ_TIMER__); }
    }
    window.EventSource = FakeEventSource;
    window.fetch = async () => ({ ok: true, json: async () => ({ runId: 'preview' }) });

    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        if (message.type !== 'ready') return;
        setTimeout(() => {
          window.postMessage({ type: 'init', url: 'http://127.0.0.1:60608', ...window.__QZ_INIT__ }, '*');
          window.__QZ_READY__();
        }, 60);
      },
    });
  `
}
