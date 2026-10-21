import { readFileSync, writeFileSync } from 'node:fs'

// 1) 页面：输入框下面加「先看任务书」开关
{
  const path = 'vscode/pages.cjs'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('id="plan-first"')) {
    code = code.replace(
      `          <label class="toggle" id="git-toggle" hidden>`,
      `          <label class="toggle" id="plan-toggle">
            <input type="checkbox" id="plan-first" />
            <span>先看任务书</span>
          </label>
          <label class="toggle" id="git-toggle" hidden>`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('pages.cjs：加了「先看任务书」开关')
  }
}

// 2) chat.js：发送时带 planOnly；planned 结束给「按这个做」
{
  const path = 'vscode/media/chat.js'
  let code = readFileSync(path, 'utf8')
  const done = []

  // 发送体带 planOnly
  if (!code.includes('planOnly,')) {
    code = code.replace(
      `        body: JSON.stringify({ goal }),`,
      `        body: JSON.stringify({
          goal,
          planOnly: Boolean($('plan-first') && $('plan-first').checked),
        }),`,
    )
    done.push('发送带 planOnly')
  }

  // done 事件里：计划模式给确认按钮
  const doneFrom = `      const touched = event.touched ?? 0`
  const doneTo = `      // 计划模式：任务书出了但还没动手，等用户点头
      if (result.planned === true) {
        setStatus('任务书已出，等你确认', 'ok')
        const box = el('div', 'snapshot-actions')
        box.id = 'plan-actions'
        const go = el('button', 'primary-mini', '按这个做')
        go.type = 'button'
        go.addEventListener('click', () => {
          box.remove()
          vscode.postMessage({ type: 'continuePlan', runId: view.runId ?? '' })
        })
        box.append('要先看一眼任务书？确认后我再动手。 ', go)
        thread.append(box)
        scrollDown()
      }

      const touched = event.touched ?? 0`
  if (code.includes(doneFrom) && !code.includes('按这个做')) {
    code = code.replace(doneFrom, doneTo)
    done.push('计划模式确认按钮')
  }

  // run_end：planned 状态不要覆盖状态文字
  code = code.replace(
    `      if (event.status === 'cancelled') setStatus('已取消')`,
    `      if (event.status === 'cancelled') setStatus('已取消')
      if (event.status === 'planned') setStatus('任务书已出，等你确认', 'ok')`,
  )

  // 扩展推回来的 continue 结果：订阅新一轮
  if (!code.includes("message.type === 'continued'")) {
    code = code.replace(
      `  if (message.type === 'providers') {`,
      `  if (message.type === 'continued') {
    const payload = message.result || {}
    if (payload.ok && payload.runId) {
      const box = document.getElementById('plan-actions')
      if (box) box.remove()
      view.bubbles.clear()
      view.round = 0
      setBusy(true)
      subscribe(payload.runId)
    } else {
      setStatus(payload.error || '继续执行失败', 'err')
    }
    return
  }
  if (message.type === 'providers') {`,
    )
    done.push('处理 continued')
  }

  writeFileSync(path, code, 'utf8')
  console.log('chat.js:', done.join(' / ') || '(无改动)')
}

// 3) 样式：小号主按钮
{
  const path = 'vscode/media/chat.css'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('.primary-mini')) {
    code += `
/* 行内小号主按钮（"按这个做"这种确认动作） */
.primary-mini {
  padding: 3px 12px;
  border: 1px solid var(--qz-accent);
  border-radius: var(--qz-r-pill);
  background: var(--qz-accent);
  color: var(--qz-accent-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.primary-mini:hover { background: var(--qz-accent-hover); border-color: var(--qz-accent-hover); }
`
    writeFileSync(path, code, 'utf8')
    console.log('chat.css：加了 primary-mini')
  }
}
