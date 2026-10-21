/* QZcode 设置面板：模型 / 技能 / 成本 三个页签。跑在 webview 里，只用 DOM + postMessage。 */

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {} }
const $ = (id) => document.getElementById(id)

const cards = $('cards')
const statusLine = $('status')

const CUSTOM = '__custom__'
const MANUAL = '__manual__'

/** 角色 → 模型输入/下拉 */
const modelSelects = new Map()
/** 角色 → 已拉到的模型列表（重渲染后还原下拉用） */
const modelLists = new Map()
/** 角色 → 卡片状态（重渲染后还原反馈用） */
const cardStatuses = new Map()
/** 角色 → 技能勾选容器 */
const skillBoxes = new Map()

let state = null
/** 技能目录（/api/skills） */
let skillCatalog = []
/** 成本数据（/api/cost） */
let costData = null

const ROLE_HINT = {
  leader: '只做分流：闲聊直接答，活儿才往下走',
  planner: '写任务书：交付物、验收标准、给 B 的提示词',
  implementer: '唯一会改文件的角色（tools）',
  verifier: '只读 + 跑测试，逐条对验收标准',
}

const BADGE = {
  leader: ['L', 'badge-l'],
  planner: ['A', 'badge-a'],
  implementer: ['B', 'badge-b'],
  verifier: ['C', 'badge-c'],
}

// ------------------------------------------------------------------ 小工具

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function setStatus(text, kind) {
  if (!statusLine) return
  statusLine.textContent = text || ''
  statusLine.className = `status${kind ? ' ' + kind : ''}`
}

/**
 * 视觉模型设置块（只在 C 的卡片里出现）。
 * C 是纯文本模型时，截图交给这个多模态模型看，描述再转给 C。
 */
function visionBlock(vision) {
  const box = el('div', 'vision-box')
  box.id = 'vision-box'

  const head = el('label', 'toggle')
  const enabled = el('input')
  enabled.type = 'checkbox'
  enabled.id = 'vision-enabled'
  enabled.checked = vision.enabled === true
  head.append(enabled, el('span', null, '挂一个视觉模型（C 看不懂图，让它代看截图）'))
  box.append(head)

  const body = el('div', 'vision-body')
  body.hidden = vision.enabled !== true

  const model = el('input')
  model.type = 'text'
  model.id = 'vision-model'
  model.value = vision.model ?? ''
  model.placeholder = 'gpt-4o / qwen-vl-max / glm-4v …（必须能看图）'
  body.append(field('视觉模型', model, '截图会发给它看，返回的文字描述再交给 C 判断'))

  const baseUrl = el('input')
  baseUrl.type = 'text'
  baseUrl.id = 'vision-baseUrl'
  baseUrl.value = vision.baseUrl ?? ''
  baseUrl.placeholder = '留空 = 用 C 的接口地址'
  body.append(field('接口地址', baseUrl))

  const apiKey = el('input')
  apiKey.type = 'password'
  apiKey.id = 'vision-apiKey'
  apiKey.placeholder = '留空 = 用 C 的 key'
  body.append(field('API key', apiKey))

  const row = el('div', 'row-inline')
  const maxImages = el('input')
  maxImages.type = 'number'
  maxImages.min = '0'
  maxImages.id = 'vision-maxImages'
  maxImages.value = String(vision.maxImages ?? 8)
  row.append(maxImages)
  body.append(field('每次运行最多看几张图', row, '0 = 不限；防止截图刷爆账单'))

  const question = el('textarea')
  question.rows = 2
  question.id = 'vision-question'
  question.value = vision.question ?? ''
  body.append(field('每张图固定问的话', question))

  const actions = el('div', 'actions-grid')
  const save = el('button', 'primary', '保存视觉设置')
  save.type = 'button'
  save.id = 'vision-save'
  const status = el('span', 'vision-status')
  status.id = 'vision-status'
  actions.append(save, status)
  body.append(actions)

  enabled.addEventListener('change', () => {
    body.hidden = !enabled.checked
  })

  let saveTimer = null

  save.addEventListener('click', () => {
    vscode.postMessage({
      type: 'saveVision',
      enabled: enabled.checked,
      model: model.value.trim(),
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      maxImages: Number(maxImages.value || 0),
      question: question.value.trim(),
    })
    status.className = 'vision-status'
    status.textContent = '保存中…'

    // 兜底：后端/扩展一旦没回消息，8 秒后必须给个说法，不能一直转
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      status.className = 'vision-status err'
      status.textContent = '保存超时：后端没回应，再点一次保存'
    }, 8000)
  })

  // 收到结果就清掉超时
  window.__clearVisionTimer__ = () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  box.append(body)
  return box
}

function cardOf(role) {
  if (!cards) return null
  for (const card of cards.children) {
    if (card.dataset && card.dataset.role === role) return card
  }
  return null
}

function findByRoleCard(role, className) {
  const card = cardOf(role)
  if (!card) return null
  for (const child of card.children) {
    if (child.className && String(child.className).split(' ').includes(className)) return child
  }
  return null
}

/** 卡片里的状态行：写进 map，重渲染后还原（不然保存一次反馈就没了）。 */
function setRoleStatus(role, text, kind) {
  cardStatuses.set(role, { text, kind })
  const node = findByRoleCard(role, 'card-status')
  if (!node) return
  node.textContent = text || ''
  node.className = `card-status${kind ? ' ' + kind : ''}`
  node.hidden = !text
}

function field(labelText, input, hint) {
  const wrapper = el('label', 'field')
  wrapper.append(el('span', 'field-title', labelText))
  wrapper.append(input)
  if (hint) wrapper.append(el('span', 'field-hint', hint))
  return wrapper
}

function parseHeaders(text) {
  const headers = {}
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf(':')
    if (index <= 0) continue
    headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return headers
}

function formatHeaders(headers) {
  return Object.entries(headers || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

function contextLabel(model) {
  const parts = [model.id]
  if (typeof model.contextLength === 'number' && model.contextLength > 0) {
    parts.push(`${Math.round(model.contextLength / 1000)}k 上下文`)
  }
  if (model.credits) parts.push(String(model.credits))
  return parts.join(' · ')
}

function fillModelSelect(select, list, current) {
  if (!select) return
  select.replaceChildren()
  const ids = list.map((model) => model.id)
  if (current && !ids.includes(current)) {
    const option = el('option', null, current)
    option.value = current
    select.append(option)
  }
  for (const model of list) {
    const option = el('option', null, contextLabel(model))
    option.value = model.id
    select.append(option)
  }
  if (current) select.value = current
}

// ------------------------------------------------------------------ 技能

function renderSkills(roleName, container) {
  if (!container) return
  container.replaceChildren()
  const role = (state?.roles ?? []).find((item) => item.role === roleName)
  const picked = new Set(role?.skills ?? [])
  const applicable = skillCatalog.filter((skill) => (skill.roles ?? []).includes(roleName))

  if (applicable.length === 0) {
    container.append(el('div', 'dim', '这个角色暂时没有可用技能'))
    return
  }

  for (const skill of applicable) {
    const row = el('label', 'skill-row-inline')
    const box = el('input')
    box.type = 'checkbox'
    if (skill.source === 'builtin') {
      box.checked = true
      box.disabled = true
      box.title = '内置技能：按角色始终生效'
    } else {
      box.checked = picked.size === 0 ? true : picked.has(skill.name)
      box.title = '勾选 = 这个角色启用该技能'
    }
    box.addEventListener('change', () => {
      const next = new Set((state?.roles ?? []).find((item) => item.role === roleName)?.skills ?? [])
      if (box.checked) next.add(skill.name)
      else next.delete(skill.name)
      vscode.postMessage({ type: 'save', patch: { role: roleName, skills: [...next] } })
    })
    const text = el(
      'span',
      'skill-name',
      (skill.title || skill.name) + (skill.source === 'user' ? '（导入，可勾选）' : '（内置，始终生效）'),
    )
    if (skill.description) text.title = skill.description
    row.append(box, text)
    container.append(row)
  }
}

/** 技能页：一张表，行 = 技能，列 = 角色 + 操作。 */
function renderSkillTable() {
  const table = $('skills-table')
  if (!table) return
  table.replaceChildren()
  if (skillCatalog.length === 0) {
    table.append(el('div', 'dim', '还没有技能：上面导入一个，或检查后端是否起来'))
    return
  }

  const head = el('div', 'skill-row skill-head')
  head.append(el('span', 'skill-name', '技能'))
  for (const role of state?.roles ?? []) head.append(el('span', 'skill-role', role.role))
  head.append(el('span', 'skill-actions', ''))
  table.append(head)

  for (const skill of skillCatalog) {
    const row = el('div', 'skill-row')
    const name = el('span', 'skill-name')
    name.textContent = (skill.title || skill.name) + (skill.source === 'user' ? '' : ' ·内置')
    if (skill.description) name.title = skill.description
    row.append(name)

    for (const role of state?.roles ?? []) {
      const cell = el('span', 'skill-role')
      const box = el('input')
      box.type = 'checkbox'
      const applicable = (skill.roles ?? []).includes(role.role)
      const builtin = skill.source !== 'user'
      box.checked = builtin ? applicable : role.skills?.length ? role.skills.includes(skill.name) : applicable
      box.disabled = builtin || !applicable
      if (builtin) box.title = '内置技能：按角色始终生效'
      else if (!applicable) box.title = '这个技能没有声明适用该角色'
      else box.title = '勾选 = 这个角色启用该技能'
      box.addEventListener('change', () => {
        const roleState = (state?.roles ?? []).find((item) => item.role === role.role)
        const next = new Set(roleState?.skills ?? [])
        if (box.checked) next.add(skill.name)
        else next.delete(skill.name)
        const list = [...next].filter((item) =>
          skillCatalog.some((candidate) => candidate.name === item && (candidate.roles ?? []).includes(role.role)),
        )
        vscode.postMessage({ type: 'save', patch: { role: role.role, skills: list } })
      })
      cell.append(box)
      row.append(cell)
    }

    const actions = el('span', 'skill-actions')
    if (skill.source === 'user') {
      const remove = el('button', 'link', '删除')
      remove.addEventListener('click', () => {
        vscode.postMessage({ type: 'removeSkill', name: skill.name })
      })
      actions.append(remove)
    }
    row.append(actions)
    table.append(row)
  }
}

// ------------------------------------------------------------------ 成本

function money(value) {
  const symbol = costData?.currency === 'CNY' ? '\u00A5' : costData?.currency === 'USD' ? '\u0024' : ''
  const amount = Number(value ?? 0)
  return symbol + amount.toFixed(Math.abs(amount) >= 1 ? 2 : 4)
}

const STEP_LABELS = {
  leader: 'L · 调度',
  planner: 'A · 规划',
  implementer: 'B · 实现',
  verifier: 'C · 核验',
}

/** 392.7s 这种读起来太长，换成 6m33s / 12.4s */
function formatDuration(ms) {
  if (!ms || ms < 1000) return Math.round(ms || 0) + 'ms'
  const seconds = ms / 1000
  if (seconds < 60) return seconds.toFixed(1) + 's'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return minutes + 'm' + String(rest).padStart(2, '0') + 's'
}

/** 读成本：先显示"读取中"，超时给重试，绝不留给用户一块空白。 */
let costTimer = null

function loadCost() {
  const box = $('cost-summary')
  if (box) {
    box.replaceChildren(el('div', 'dim', '正在读取成本…'))
  }
  const body = $('cost-body')
  if (body) body.replaceChildren()

  vscode.postMessage({ type: 'reloadCost' })

  if (costTimer) clearTimeout(costTimer)
  costTimer = setTimeout(() => {
    const target = $('cost-summary')
    if (!target) return
    target.replaceChildren()
    const line = el('div', 'dim', '读取超时：后端没有回应。')
    const retry = el('button', 'link', '重试')
    retry.type = 'button'
    retry.addEventListener('click', () => loadCost())
    const restart = el('button', 'link', '重启后端')
    restart.type = 'button'
    restart.addEventListener('click', () => vscode.postMessage({ type: 'restartServer' }))
    target.append(line, retry, ' ', restart)
  }, 5000)
}

function renderCost() {
  const summaryBox = $('cost-summary')
  const bodyBox = $('cost-body')
  if (!summaryBox || !bodyBox) return
  summaryBox.replaceChildren()
  bodyBox.replaceChildren()

  if (!costData) {
    summaryBox.append(el('div', 'dim', '还没有记账数据：跑一次任务就开始累计（账本跟着配置文件走，换工作区不清零）'))
    return
  }

  const card = el('div', 'cost-card')
  const head = el('div', 'cost-head')
  head.append(el('span', 'cost-today', '今日 ' + money(costData.today)))
  head.append(el('span', 'dim', '累计 ' + money(costData.total) + ' · ' + costData.runs + ' 次运行'))
  card.append(head)

  // 吞吐：平均与单次峰值
  // 按步骤（L/A/B/C）拆开：每一步多快、花了多久，而不是整轮一个数
  const steps = Array.isArray(costData.steps) ? costData.steps : []
  if (steps.length > 0) {
    const table = el('div', 'step-table')
    const head = el('div', 'step-row step-head')
    head.append(el('span', 'step-name', '步骤'))
    head.append(el('span', 'step-num', '最快'))
    head.append(el('span', 'step-num', '平均'))
    head.append(el('span', 'step-num', '用时'))
    head.append(el('span', 'step-num', '调用'))
    table.append(head)

    for (const step of steps) {
      const row = el('div', 'step-row')
      const label = STEP_LABELS[step.role] ?? step.role
      const name = el('span', 'step-name', label)
      name.title = '输出 ' + Number(step.completion ?? 0) + ' tok · 输入 ' + Number(step.prompt ?? 0) + ' tok'
      row.append(name)
      row.append(el('span', 'step-num step-best', (Number(step.maxTokPerSec ?? 0)).toFixed(1)))
      row.append(el('span', 'step-num', (Number(step.tokPerSec ?? 0)).toFixed(1)))
      row.append(el('span', 'step-num', formatDuration(Number(step.ms ?? 0))))
      row.append(el('span', 'step-num dim', String(Number(step.calls ?? 0))))
      table.append(row)
    }
    card.append(table)
    card.append(el('div', 'dim step-note', '单位 tok/s：最快＝这一步里单次调用最高输出速度；平均＝这一步输出 token ÷ 这一步模型耗时（工具时间不算）'))
  } else {
    card.append(el('div', 'dim', '还没有分步骤数据：跑一次真实任务后，这里会显示 L/A/B/C 各自的速度和耗时'))
  }

  if (costData.budget > 0) {
    const bar = el('div', 'cost-bar')
    const fill = el('div', 'cost-fill')
    const ratio = Math.min(1, costData.today / costData.budget)
    fill.style.width = Math.round(ratio * 100) + '%'
    if (costData.overBudget) fill.classList.add('over')
    bar.append(fill)
    const rest = costData.remaining !== null ? '，剩余 ' + money(costData.remaining) : ''
    card.append(bar, el('div', 'dim', '预算 ' + money(costData.budget) + rest))
  }
  summaryBox.append(card)

  const roles = Object.entries(costData.byRole ?? {}).sort((a, b) => b[1] - a[1])
  if (roles.length > 0) {
    bodyBox.append(el('div', 'skill-row skill-head', '按角色累计'))
    for (const [role, amount] of roles) {
      const row = el('div', 'skill-row')
      row.append(el('span', 'skill-name', role))
      row.append(el('span', 'skill-role', money(amount)))
      bodyBox.append(row)
    }
  }

  const recent = costData.recent ?? []
  if (recent.length > 0) {
    bodyBox.append(el('div', 'skill-row skill-head', '最近运行'))
    for (const entry of recent) {
      const row = el('div', 'skill-row')
      const goal = el('span', 'skill-name', String(entry.goal || '').slice(0, 40))
      goal.title = entry.goal
      row.append(goal)
      row.append(el('span', 'skill-role', money(entry.total)))
      row.append(el('span', 'skill-actions dim', entry.tokens + ' tok'))
      bodyBox.append(row)
    }
  }
}

// ------------------------------------------------------------------ 角色卡片

function buildCard(role) {
  const [letter, cls] = BADGE[role.role] ?? ['?', '']
  const card = el('div', 'card')
  if (!card.dataset) card.dataset = {}
  card.dataset.role = role.role

  const head = el('div', 'card-head')
  const titles = el('div')
  titles.append(el('div', 'card-title', role.title))
  titles.append(el('div', 'card-role', `${role.role} · ${ROLE_HINT[role.role] ?? ''}`))
  head.append(el('div', `badge ${cls}`, letter), titles)
  card.append(head)

  // 供应商：一个平铺列表。这些只是可选项，不代表已经填过。
  const provider = el('select')
  const catalog = state?.catalog ?? []

  // 当前在用的是清单以外的供应商（比如自建网关）：先放一条，别让选中的值丢掉
  const inCatalog = catalog.some((item) => item.id === role.provider)
  if (!role.custom && !inCatalog && role.provider) {
    const option = el('option', null, role.provider)
    option.value = role.provider
    provider.append(option)
  }

  for (const item of catalog) {
    const option = el('option', null, item.label ?? item.id)
    option.value = item.id
    option.dataset.baseUrl = item.baseUrl ?? ''
    option.dataset.model = item.model ?? ''
    option.dataset.site = item.site ?? ''
    if (item.needsRoute) option.dataset.needsRoute = '1'
    provider.append(option)
  }

  const customOption = el('option', null, '自定义（手动填写全部字段）')
  customOption.value = CUSTOM
  provider.append(customOption)

  provider.value = role.custom ? CUSTOM : role.provider
  card.append(field('供应商', provider, '选中后会把接口地址和模型填上，key 还要自己填'))

  // 模型 + 获取模型
  const modelRow = el('div', 'row-inline')
  const modelInput = el('input')
  modelInput.type = 'text'
  modelInput.value = role.model ?? ''
  modelInput.placeholder = '模型名，例如 cn:deepseek-v4.1-flash'
  const fetchButton = el('button', 'ghost', '获取模型')
  modelRow.append(modelInput, fetchButton)
  card.append(field('模型', modelRow, '点「获取模型」从端点拉清单，或者直接填'))

  // 地址
  const baseUrl = el('input')
  baseUrl.type = 'text'
  baseUrl.value = role.baseUrl ?? ''
  baseUrl.placeholder = 'https://…/v1'
  card.append(field('接口地址', baseUrl))

  // 选了清单里的平台：把内置地址/模型填进来（没有内置地址就提示自己填）
  const providerHint = el('span', 'field-hint')
  card.append(providerHint)
  provider.addEventListener('change', () => {
    const picked = provider.selectedOptions && provider.selectedOptions[0]
    if (!picked) return
    const url = picked.dataset ? picked.dataset.baseUrl : ''
    const model = picked.dataset ? picked.dataset.model : ''
    const site = picked.dataset ? picked.dataset.site : ''
    if (url) baseUrl.value = url
    if (model) modelInput.value = model
    if (picked.value === CUSTOM) {
      providerHint.textContent = ''
      return
    }
    if (picked.dataset && picked.dataset.needsRoute === '1') {
      providerHint.textContent = `这个平台需要先配路由/网关才能用，地址请按 ${site} 的文档填`
      return
    }
    providerHint.textContent = url
      ? ''
      : `这个平台的兼容地址还没内置，请按 ${site} 的文档填接口地址`
  })

  // key
  const apiKey = el('input')
  apiKey.type = 'password'
  apiKey.value = ''
  apiKey.placeholder = role.hasKey ? `已保存 ${role.keyHint ?? ''}（留空 = 不改）` : '填这家供应商的 key'
  card.append(
    field(
      'API key',
      apiKey,
      role.hasKey
        ? role.hasKeyForProvider
          ? `${role.provider} 的 key 已就绪`
          : `当前填的是别家的 key，${role.provider} 还没有`
        : '还没有 key',
    ),
  )

  // 温度 / 最大输出
  const numbers = el('div', 'row-inline')
  const temperature = el('input')
  temperature.type = 'number'
  temperature.step = '0.1'
  temperature.min = '0'
  temperature.max = '2'
  temperature.value = String(role.temperature ?? 0.3)
  const maxTokens = el('input')
  maxTokens.type = 'number'
  maxTokens.min = '256'
  maxTokens.step = '256'
  maxTokens.value = String(role.maxTokens ?? 4096)
  numbers.append(temperature, maxTokens)
  card.append(field('温度 / 最大输出 tokens', numbers))

  // C 核验专属：要不要额外挂一个视觉模型（双模型）
  if (role.role === 'verifier' && state.vision) {
    card.append(visionBlock(state.vision))
  }

  // 高级
  const advanced = el('details', 'advanced')
  advanced.append(el('summary', null, '高级（请求头 / 超时 / 重试）'))
  const headers = el('textarea')
  headers.rows = 2
  headers.value = formatHeaders(role.headers)
  headers.placeholder = 'X-Org-Id: 123（每行一个）'
  advanced.append(field('额外请求头', headers))
  const limits = el('div', 'row-inline')
  const timeoutMs = el('input')
  timeoutMs.type = 'number'
  timeoutMs.min = '1000'
  timeoutMs.step = '1000'
  timeoutMs.value = String(role.timeoutMs ?? 180000)
  const retries = el('input')
  retries.type = 'number'
  retries.min = '0'
  retries.max = '5'
  retries.value = String(role.retries ?? 2)
  limits.append(timeoutMs, retries)
  advanced.append(field('超时(ms) / 重试次数', limits))
  card.append(advanced)

  // 技能
  const skillBox = el('div', 'skill-box')
  const skillList = el('div', 'skill-list')
  skillBox.append(el('div', 'field-title', '技能（勾了就追加到该系统提示词）'), skillList)
  renderSkills(role.role, skillList)
  skillBoxes.set(role.role, skillList)
  card.append(skillBox)

  // 自己的状态行
  const status = el('div', 'card-status')
  const cached = cardStatuses.get(role.role)
  status.textContent = cached?.text ?? ''
  status.className = `card-status${cached?.kind ? ' ' + cached.kind : ''}`
  status.hidden = !cached?.text
  card.append(status)

  const currentModel = () => (modelSelects.get(role.role)?.input?.value ?? modelInput.value).trim()

  // 动作
  const actions = el('div', 'actions-grid')
  const save = el('button', 'primary', '保存')
  save.addEventListener('click', () => {
    const patch = {
      role: role.role,
      provider: provider.value === CUSTOM || provider.value === MANUAL ? role.provider : provider.value,
      model: currentModel(),
      baseUrl: baseUrl.value.trim(),
      temperature: Number(temperature.value),
      maxTokens: Number(maxTokens.value),
      headers: parseHeaders(headers.value),
      timeoutMs: Number(timeoutMs.value),
      retries: Number(retries.value),
      custom: provider.value === CUSTOM,
    }
    const key = apiKey.value.trim()
    if (key) patch.apiKey = key
    vscode.postMessage({ type: 'save', patch })
  })
  const copy = el('button', 'ghost', `全部都用这套（${Math.max(0, (state?.roles ?? []).length - 1)}）`)
  copy.addEventListener('click', () => {
    vscode.postMessage({
      type: 'copy',
      patch: {
        from: role.role,
        provider: provider.value === CUSTOM || provider.value === MANUAL ? role.provider : provider.value,
        model: currentModel(),
        baseUrl: baseUrl.value.trim(),
      },
    })
  })
  const test = el('button', 'ghost', '测试连接')
  test.addEventListener('click', () => {
    vscode.postMessage({
      type: 'testRole',
      role: role.role,
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      model: currentModel(),
      headers: parseHeaders(headers.value),
    })
  })
  actions.append(save, copy, test)
  card.append(actions)

  provider.addEventListener('change', () => {
    const known = (state?.providers ?? []).find((item) => item.id === provider.value)
    if (known) {
      if (known.baseUrl) baseUrl.value = known.baseUrl
      apiKey.placeholder = known.hasKey
        ? `${provider.value} 的 key 已保存（留空 = 不改）`
        : `${provider.value} 还没有 key，填一个`
      if (known.model) modelInput.value = known.model
    }
  })

  fetchButton.addEventListener('click', () => {
    setRoleStatus(role.role, '正在拉取模型列表…')
    vscode.postMessage({
      type: 'models',
      role: role.role,
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      headers: parseHeaders(headers.value),
    })
  })

  modelSelects.set(role.role, { input: modelInput, row: modelRow, fetch: fetchButton })

  // 之前拉过列表：重渲染后直接把下拉还原
  const cachedList = modelLists.get(role.role)
  if (cachedList && cachedList.length > 0) {
    const select = el('select')
    fillModelSelect(select, cachedList, role.model)
    modelRow.replaceChildren(select, fetchButton)
    modelSelects.set(role.role, { input: select, row: modelRow, fetch: fetchButton })
  }

  return card
}

function render() {
  if (!cards || !state) return
  const workspaceNode = $('workspace-path')
  if (workspaceNode) workspaceNode.textContent = state.workspace ? `工作区：${state.workspace}` : '工作区：未打开文件夹'
  const pathNode = $('config-path')
  if (pathNode) pathNode.textContent = state.configPath || '（还没有配置文件，保存时会创建）'
  cards.replaceChildren()
  for (const role of state.roles) cards.append(buildCard(role))
}

// ------------------------------------------------------------------ 页签

const tabButtons = document.body.querySelectorAll('.tab')
const panes = { models: $('tab-models'), skills: $('tab-skills'), cost: $('tab-cost') }

function switchTab(name) {
  for (const button of tabButtons) button.classList.toggle('active', button.dataset.tab === name)
  for (const [key, node] of Object.entries(panes)) {
    if (node) node.hidden = key !== name
  }
  if (name === 'skills') vscode.postMessage({ type: 'reloadSkills' })
  if (name === 'cost') loadCost()
}

for (const button of tabButtons) {
  button.addEventListener('click', () => switchTab(button.dataset.tab))
}

// 导入技能：一个输入框搞定路径 / 链接 / 粘贴
const importInput = $('import-value')
const importButton = $('import-skill')
if (importButton && importInput) {
  importButton.addEventListener('click', () => {
    const value = importInput.value.trim()
    if (!value) {
      setStatus('先填路径、链接或粘贴内容', 'err')
      return
    }
    const source = /^https?:\/\//i.test(value) ? 'url' : /[\\/]/.test(value) || /\.md$/i.test(value) ? 'path' : 'text'
    setStatus('正在导入技能…')
    vscode.postMessage({ type: 'importSkill', source, value })
  })
}

const openConfig = $('open-config')
if (openConfig) openConfig.addEventListener('click', () => vscode.postMessage({ type: 'openConfig' }))

// ------------------------------------------------------------------ 消息

window.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return

  if (message.type === 'visionSaved') {
    if (window.__clearVisionTimer__) window.__clearVisionTimer__()
    if (message.result && message.result.vision) state.vision = message.result.vision
    const status = document.getElementById('vision-status')
    if (status) {
      const ok = message.result && message.result.ok
      status.className = 'vision-status ' + (ok ? 'ok' : 'err')
      status.textContent = ok
        ? message.result.ready
          ? '已保存：下一次核验会调用视觉模型'
          : '已保存，但没填视觉模型名，等于没开'
        : '保存失败'
    }
    return
  }
  if (message.type === 'state') {
    state = message.state
    render()
    renderSkillTable()
    if (message.error) setStatus(message.error, 'err')
    return
  }

  if (message.type === 'saved') {
    state = message.state
    render()
    renderSkillTable()
    const warnings = message.warnings ?? []
    const total = (message.state?.roles ?? []).length
    const others = Math.max(0, total - 1)
    const text = message.persistError
      ? `已生效，但${message.persistError}`
      : message.copied
        ? `已复制到其余 ${others} 个角色`
        : warnings.length > 0
          ? `已保存 · ${warnings[0]}`
          : '已保存，下一轮生效'
    setRoleStatus(message.role, text, message.persistError ? 'err' : 'ok')
    return
  }

  if (message.type === 'models') {
    const result = message.result ?? {}
    if (!result.ok) {
      setRoleStatus(message.role, '拉取模型列表失败：' + (result.error ?? '未知原因'), 'err')
      return
    }
    const list = result.models ?? []
    modelLists.set(message.role, list)
    const entry = modelSelects.get(message.role)
    if (!entry) {
      setRoleStatus(message.role, '拿到 ' + list.length + ' 个模型', 'ok')
      return
    }
    const select = el('select')
    fillModelSelect(select, list, entry.input?.value ?? '')
    entry.row.replaceChildren(select, entry.fetch)
    modelSelects.set(message.role, { input: select, row: entry.row, fetch: entry.fetch })
    setRoleStatus(message.role, '已获取 ' + list.length + ' 个模型，下拉里选一个再保存', 'ok')
    return
  }

  if (message.type === 'tested') {
    const result = message.result ?? {}
    if (result.ok) {
      const count = result.models?.length ? `（端点有 ${result.models.length} 个模型）` : ''
      setRoleStatus(message.role, `连接正常 · ${result.ms}ms · ${result.model}${count}`, 'ok')
    } else {
      setRoleStatus(message.role, `连接失败 · ${result.ms}ms · ${result.error ?? '未知原因'}`, 'err')
    }
    return
  }

  if (message.type === 'cost') {
    if (costTimer) {
      clearTimeout(costTimer)
      costTimer = null
    }
    const box = $('cost-summary')
    if (message.error) {
      if (box) {
        box.replaceChildren()
        const line = el('div', 'dim', '成本读不出来：' + message.error)
        const retry = el('button', 'link', '重试')
        retry.type = 'button'
        retry.addEventListener('click', () => loadCost())
        box.append(line, retry)
      }
      return
    }
    costData = message.data ?? null
    renderCost()
    return
  }

  if (message.type === 'skills') {
    skillCatalog = message.catalog ?? []
    for (const [roleName, box] of skillBoxes) renderSkills(roleName, box)
    renderSkillTable()
    return
  }

  if (message.type === 'removed') {
    if (message.result?.ok) {
      setStatus('已删除技能：' + message.result.name, 'ok')
      vscode.postMessage({ type: 'reloadSkills' })
    } else {
      setStatus('删除失败：' + (message.result?.error ?? '未知原因'), 'err')
    }
    return
  }

  if (message.type === 'imported') {
    if (message.result?.ok) {
      const skill = message.result.skill ?? {}
      setStatus('已导入技能：' + (skill.title || skill.name) + '（勾选后生效）', 'ok')
      if (importInput) importInput.value = ''
      vscode.postMessage({ type: 'reloadSkills' })
    } else {
      setStatus('导入失败：' + (message.result?.error ?? '未知原因'), 'err')
    }
    return
  }

  if (message.type === 'error') setStatus(message.message, 'err')
})

vscode.postMessage({ type: 'ready' })
