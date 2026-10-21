import { readFileSync, writeFileSync } from 'node:fs'

// 1) 侧栏：done / 取消 之后的三个入口（查看改动 / 按文件回滚 / 看记录）
{
  const path = 'vscode/media/chat.js'
  let code = readFileSync(path, 'utf8')
  const done = []

  const from = `      const touched = event.touched ?? 0
      if (touched > 0) {
        const box = el('div', 'hint snapshot-actions')
        box.append(\`本次运行改动了 \${touched} 个文件：\`)
        const diff = el('button', 'link', '查看改动')
        diff.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }))
        const rollback = el('button', 'link', '回滚')
        rollback.addEventListener('click', () => vscode.postMessage({ type: 'rollback' }))
        box.append(diff, ' 或 ', rollback)
        thread.append(box)
        scrollDown()
      }`

  const to = `      const touched = event.touched ?? 0
      const runId = view.runId ?? ''
      if (touched > 0) {
        const box = el('div', 'hint snapshot-actions')
        box.append(\`本次运行改动了 \${touched} 个文件：\`)
        const diff = el('button', 'link', '查看改动')
        diff.addEventListener('click', () => vscode.postMessage({ type: 'showDiff' }))
        const rollback = el('button', 'link', '全部回滚')
        rollback.addEventListener('click', () => vscode.postMessage({ type: 'rollback' }))
        const one = el('button', 'link', '回滚某个文件')
        one.addEventListener('click', () => vscode.postMessage({ type: 'rollbackFile', runId }))
        box.append(diff, ' · ', one, ' · ', rollback)
        thread.append(box)
      }
      {
        const box = el('div', 'hint snapshot-actions')
        const log = el('button', 'link', '查看本轮记录')
        log.addEventListener('click', () => vscode.postMessage({ type: 'openRunLog' }))
        box.append(log)
        thread.append(box)
        scrollDown()
      }`

  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('done 后三个入口')
  } else {
    console.log('⚠ done 入口锚点未匹配')
  }

  // 取消后也能回滚：记住 lastRunId，取消时给一个回滚口子
  if (!code.includes('lastRunId')) {
    code = code.replace(
      `  /** 重连次数，用来退避和给用户看进度 */`,
      `  /** 最近一次运行的 id（取消后仍能据此回滚） */
  lastRunId: '',
  /** 重连次数，用来退避和给用户看进度 */`,
    )
    code = code.replace(
      `  view.runId = runId
  if (since === 0) {`,
      `  view.runId = runId
  view.lastRunId = runId
  if (since === 0) {`,
    )
    code = code.replace(
      `      if (event.status === 'cancelled') setStatus('已取消')`,
      `      if (event.status === 'cancelled') {
        setStatus('已取消', 'err')
        // 停下来之后仍然可以回滚这次已经改过的文件
        const box = el('div', 'hint snapshot-actions')
        box.append('本次运行已经停下来了，改动还在。')
        const rollback = el('button', 'link', '回滚这次改动')
        rollback.addEventListener('click', () =>
          vscode.postMessage({ type: 'rollback', runId: view.lastRunId }),
        )
        box.append(' ', rollback)
        thread.append(box)
        scrollDown()
      }`,
    )
    done.push('取消后可回滚')
  }

  writeFileSync(path, code, 'utf8')
  console.log('chat.js:', done.join(' / ') || '(无改动)')
}

// 2) 回滚时把 runId 传下去
{
  const path = 'vscode/extension.cjs'
  let code = readFileSync(path, 'utf8')
  const from = `      else if (message.type === 'rollback') await rollbackRun()`
  if (code.includes(from)) {
    code = code.replace(from, `      else if (message.type === 'rollback') await rollbackRun(message.runId)`)
    writeFileSync(path, code, 'utf8')
    console.log('extension.cjs：rollback 带上 runId')
  }
}
