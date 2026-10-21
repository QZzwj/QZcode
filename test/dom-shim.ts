/*
 * 一个够用的假 DOM：让 src/web/assets/app.js 能在 node 里跑起来。
 * 目的不是模拟浏览器，而是把客户端的事件 → DOM 更新路径真跑一遍，
 * 这样 app.js 里的拼写错误、undefined 调用、结构错位在 CI 里就能暴露。
 */

type Listener = (event: Record<string, unknown>) => void

export class FakeNode {
  tagName: string
  children: FakeNode[] = []
  parent: FakeNode | null = null
  attributes: Record<string, string> = {}
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  listeners: Record<string, Listener[]> = {}
  className = ''
  id = ''
  value = ''
  checked = false
  hidden = false
  disabled = false
  private _text: string | null = null
  private _html = ''

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase()
  }

  get classList() {
    const node = this
    return {
      add(name: string) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean))
        set.add(name)
        node.className = [...set].join(' ')
      },
      remove(name: string) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean))
        set.delete(name)
        node.className = [...set].join(' ')
      },
      contains(name: string) {
        return node.className.split(/\s+/).includes(name)
      },
      toggle(name: string, force?: boolean) {
        const has = node.className.split(/\s+/).includes(name)
        const want = force === undefined ? !has : force
        if (want) this.add(name)
        else this.remove(name)
      },
    }
  }

  get textContent(): string {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join('')
    if (this._text !== null) return this._text
    // innerHTML-only nodes (e.g. the composer hints) still expose their text.
    return this._html.replace(/<[^>]*>/g, '')
  }

  set textContent(value: string) {
    this.children = []
    this._text = String(value ?? '')
  }

  get innerHTML(): string {
    return this._html
  }

  set innerHTML(value: string) {
    this._html = String(value ?? '')
    this.children = []
    this._text = null
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes.flat()) {
      if (node === null || node === undefined || node === false) continue
      const child = typeof node === 'string' ? createText(node) : (node as FakeNode)
      child.parent = this
      this.children.push(child)
    }
    this._text = null
  }

  appendChild(node: FakeNode): FakeNode {
    this.append(node)
    return node
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children = []
    this._text = null
    this.innerHTML = ''
    if (nodes.length > 0) this.append(...nodes)
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
    if (name === 'class') this.className = value
    if (name === 'id') this.id = value
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  removeAttribute(name: string): void {
    delete this.attributes[name]
  }

  remove(): void {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }

  addEventListener(event: string, listener: Listener): void {
    ;(this.listeners[event] ??= []).push(listener)
  }

  dispatch(event: string, payload: Record<string, unknown> = {}): void {
    for (const listener of this.listeners[event] ?? []) listener({ target: this, ...payload })
  }

  focus(): void {}

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeNode[] {
    const out: FakeNode[] = []
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  get scrollHeight(): number {
    return Math.max(1, this.textContent.length)
  }

  get scrollTop(): number {
    return 0
  }

  set scrollTop(_value: number) {}

  get clientHeight(): number {
    return 600
  }
}

function matches(node: FakeNode, selector: string): boolean {
  const trimmed = selector.trim()
  if (trimmed.startsWith('.')) return node.className.split(/\s+/).includes(trimmed.slice(1))
  if (trimmed.startsWith('#')) return node.id === trimmed.slice(1)
  if (trimmed.includes(' ')) return false
  return node.tagName === trimmed.toLowerCase()
}

function createText(value: string): FakeNode {
  const node = new FakeNode('#text')
  node.textContent = value
  return node
}

export interface FakeDocument {
  createElement(tag: string): FakeNode
  createTextNode(text: string): FakeNode
  getElementById(id: string): FakeNode | null
  body: FakeNode
  all: Map<string, FakeNode>
}

/** Builds a document containing every id that index.html provides. */
export function createDocument(ids: string[]): FakeDocument {
  const all = new Map<string, FakeNode>()
  const body = new FakeNode('body')
  const transcript = new FakeNode('section')
  transcript.id = 'transcript'
  body.append(transcript)
  all.set('transcript', transcript)

  for (const id of ids) {
    if (all.has(id)) continue
    const el = new FakeNode('div')
    el.id = id
    // rail cards expose a .rail-body child, like the real markup
    if (id.startsWith('rail-')) {
      const title = new FakeNode('div')
      title.className = 'rail-title'
      const railBody = new FakeNode('div')
      railBody.className = 'rail-body muted'
      el.append(title, railBody)
    }
    if (id === 'input') el.value = ''
    body.append(el)
    all.set(id, el)
  }

  return {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => createText(text),
    getElementById: (id: string) => all.get(id) ?? null,
    body,
    all,
  }
}

/** Collects every node with a given class below root. */
export function findByClass(root: FakeNode, className: string): FakeNode[] {
  return root.querySelectorAll(`.${className}`)
}

export function textOf(root: FakeNode | null | undefined): string {
  if (!root) return ''
  return root.textContent.replace(/\s+/g, ' ').trim()
}
