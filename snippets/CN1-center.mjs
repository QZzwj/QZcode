import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/media/chat.css'
let code = readFileSync(path, 'utf8')
const done = []

// 1) 会话区改成纵向 flex：让空状态能用 margin:auto 真正居中（横竖都中）
{
  const from = `.thread {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 14px 20px;
}`
  const to = `.thread {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 14px 20px;
}

.thread > .msg { flex: none; }`
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('会话区改 flex')
  }
}

// 2) 空状态居中 + 内容也居中排
{
  const from = `.hint {
  padding: 10px 2px;
  color: var(--qz-muted);
  font-size: 13px;
}

.hint-title {
  margin-bottom: 10px;
  color: var(--qz-fg);
  font-size: 15px;
  font-weight: 600;
}`
  const to = `/* 没有对话时：整块摆在画面正中间，横向也居中 */
.hint {
  margin: auto;
  width: 100%;
  max-width: 460px;
  padding: 12px 8px;
  color: var(--qz-muted);
  font-size: 13px;
  text-align: center;
}

.hint-title {
  margin-bottom: 12px;
  color: var(--qz-fg);
  font-size: 16px;
  font-weight: 600;
}`
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('空状态居中')
  }
}

// 3) 两行流程和示例按钮跟着居中
code = code.replace(
  `.empty-flow,
.empty-chain {
  display: flex;
  align-items: center;
  flex-wrap: wrap;`,
  `.empty-flow,
.empty-chain {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;`,
)

code = code.replace(
  `.examples {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 8px;
}`,
  `.examples {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
}`,
)

code = code.replace(
  `.example {
  padding: 5px 10px;`,
  `.example {
  padding: 5px 12px;`,
)
code = code.replace(
  `  font-size: 12.5px;
  text-align: left;
  cursor: pointer;`,
  `  font-size: 12.5px;
  text-align: center;
  cursor: pointer;`,
)

writeFileSync(path, code, 'utf8')
console.log('chat.css:', done.join(' / ') || '(无改动)')
