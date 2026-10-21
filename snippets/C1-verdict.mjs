import { readFileSync, writeFileSync } from 'node:fs'

// 1) 结论标签（✔ 通过 / ✘ 未通过）单独一行、居中显示
{
  const path = 'vscode/media/chat.js'
  let code = readFileSync(path, 'utf8')
  const done = []

  const from = `function addTag(pane, text, cls) {
  const entry = bubbleFor(pane)
  const tag = el('span', \`tag \${cls ?? ''}\`)
  tag.textContent = text
  entry.chips.append(tag)
  scrollDown()
}`
  const to = `function addTag(pane, text, cls, options = {}) {
  const entry = bubbleFor(pane)
  const tag = el('span', \`tag \${cls ?? ''}\`)
  tag.textContent = text

  if (options.center === true) {
    // 结论（通过 / 未通过）是这一轮的结果，单独占一行、居中，别混在细节标签里
    tag.classList.add('verdict')
    const row = el('div', 'verdict-row')
    row.append(tag)
    entry.row.append(row)
  } else {
    entry.chips.append(tag)
  }
  scrollDown()
}`

  if (code.includes(from)) {
    code = code.replace(from, to)

    // bubbleFor 要把 row 也交出去
    code = code.replace(
      `  const entry = { text, tools, chips, buffer: '', timer: null }`,
      `  const entry = { row, text, tools, chips, buffer: '', timer: null }`,
    )

    // 结论走居中版本
    code = code.replace(
      `      addTag('verifier', event.verdict?.pass ? '✔ 通过' : '✘ 未通过', event.verdict?.pass ? 'pass' : 'fail')`,
      `      addTag(
        'verifier',
        event.verdict?.pass ? '✔ 通过' : '✘ 未通过',
        event.verdict?.pass ? 'pass' : 'fail',
        { center: true },
      )`,
    )

    writeFileSync(path, code, 'utf8')
    done.push('结论标签居中')
  } else {
    console.log('⚠ addTag 锚点未匹配')
  }
}

// 2) 样式
{
  const path = 'vscode/media/chat.css'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('.verdict-row')) {
    const anchor = `/* 文件改动 */`
    const block = `/* 结论条：这一轮的"通过 / 未通过"，居中单独占一行 */
.verdict-row {
  display: flex;
  justify-content: center;
  margin: 10px 0 2px;
}

.tag.verdict {
  padding: 3px 16px;
  font-size: 12.5px;
  font-weight: 600;
}

${anchor}`
    if (!code.includes(anchor)) throw new Error('文件改动锚点未匹配')
    code = code.replace(anchor, block)
    writeFileSync(path, code, 'utf8')
    console.log('chat.css：加了居中结论条样式')
  }
}
