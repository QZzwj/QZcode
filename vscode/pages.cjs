/**
 * webview 页面的 HTML 源码。
 *
 * 为什么放在 .cjs 里而不是 media/*.html：
 * 扩展安装包里不再出现任何 .html 文件；页面结构就是这个模块里的模板字符串，
 * lib.cjs 负责把占位符换成真实的 CSP / 资源 URI / nonce。
 * 预览和 UI 验收脚本也直接调用 lib 的函数拿同一份 HTML，不会和产品漂移。
 *
 * 聊天面板的设计方向是"接力计时牌"：左侧一条窄车道板（四段跑道 + 一根琥珀色的棒），
 * 右边是正文。棒落在哪一段，就是哪个模型正在干活；交棒时把分段时间钉在那一段上。
 * 占位符：__CSP__ __STYLE__ __SCRIPT__ __NONCE__
 */
const CHAT_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="__CSP__" />
    <link rel="stylesheet" href="__STYLE__" />
    <title>QZcode</title>
  </head>
  <body>
    <div class="app">
      <div class="thread-wrap">
        <div class="rail" id="rail" aria-hidden="true">
          <span class="rail-node" data-role="leader"></span>
          <span class="rail-line"></span>
          <span class="rail-node" data-role="planner"></span>
          <span class="rail-line"></span>
          <span class="rail-node" data-role="implementer"></span>
          <span class="rail-line"></span>
          <span class="rail-node" data-role="verifier"></span>
        </div>
        <div id="thread" class="thread">
          <div class="hint" id="hint">
            <div class="hint-title">一句话目标，四个模型接力</div>
            <div class="empty-flow">
              <span class="flow-item"><b class="role-l">L</b>管全程</span>
              <span class="flow-note">派活 · 盯进度 · 打回返工</span>
            </div>
            <div class="empty-chain">
              <span class="flow-item"><b class="role-a">A</b>写任务书</span>
              <span class="flow-arrow">→</span>
              <span class="flow-item"><b class="role-b">B</b>实现</span>
              <span class="flow-arrow">→</span>
              <span class="flow-item"><b class="role-c">C</b>核验</span>
            </div>
            <div class="examples" id="examples"></div>
          </div>
        </div>
      </div>

      <div class="composer">
        <div class="composer-box">
          <textarea id="input" rows="1" placeholder="描述你想完成的事…"></textarea>
          <div class="composer-bar">
            <button id="provider" class="chip" type="button" title="切换 AI 供应商">
              <span class="dot"></span><span id="provider-label">模型</span>
            </button>
            <span class="spacer"></span>
            <button id="new-task" class="icon-btn" type="button" title="新任务" aria-label="新建任务">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button id="send" class="send" type="button" title="发送 (Enter)" aria-label="发送">
              <svg class="icon-send" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
              <svg class="icon-stop" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
            </button>
          </div>
        </div>

        <div class="composer-foot">
          <label class="toggle" id="git-toggle" hidden>
            <input type="checkbox" id="git-auto" />
            <span>每次改动自动 git 提交</span>
          </label>
          <span id="git-hint" class="dim"></span>
          <span class="spacer"></span>
          <span id="status" class="status"></span>
        </div>
      </div>
    </div>

    <script nonce="__NONCE__" src="__SCRIPT__"></script>
  </body>
</html>
`

/** 设置面板（模型 / 技能 / 成本三个页签）。 */
const SETTINGS_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="__CSP__" />
    <link rel="stylesheet" href="__STYLE__" />
    <title>QZcode 设置</title>
  </head>
  <body>
    <header class="head">
      <h1>QZcode 设置</h1>
      <nav class="tabs">
        <button class="tab active" data-tab="models" type="button">模型</button>
        <button class="tab" data-tab="skills" type="button">技能</button>
        <button class="tab" data-tab="cost" type="button">成本</button>
      </nav>
      <span class="spacer"></span>
      <span class="dim" id="workspace-path" title="后端干活用的目录（跟着当前打开的文件夹）"></span>
      <span class="dim" id="config-path"></span>
      <button id="open-config" class="ghost" type="button">打开配置文件</button>
    </header>

    <main class="panes">
      <section id="tab-models">
        <div id="cards" class="cards">
          <p class="dim">正在加载…</p>
        </div>
      </section>

      <section id="tab-skills" hidden>
        <div class="import-row">
          <input
            id="import-value"
            type="text"
            placeholder="本地路径（文件，或含 SKILL.md 的目录）、https 链接，或直接粘贴 markdown"
            spellcheck="false"
          />
          <button id="import-skill" class="primary" type="button">导入技能</button>
        </div>
        <p id="skills-hint">
          导入的技能默认只给 B / C 用，可以在下面按角色勾选；内置技能按角色始终生效。
        </p>
        <div id="skills-table" class="skills-table"></div>
      </section>

      <section id="tab-cost" hidden>
        <div id="cost-summary" class="cost-summary"></div>
        <div id="cost-body" class="skills-table"></div>
      </section>
    </main>

    <footer class="foot">
      <span id="status" class="status"></span>
    </footer>

    <script nonce="__NONCE__" src="__SCRIPT__"></script>
  </body>
</html>
`

module.exports = { CHAT_PAGE, SETTINGS_PAGE }
