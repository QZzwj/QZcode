import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/media/chat.css'
let code = readFileSync(path, 'utf8')

if (!code.includes('.thinking')) {
  const anchor = `/* 工具行：像 Codex 那样一行一条，前面一个小圆点 */`
  const block = `/* "正在思考中"：消息发出后、模型吐第一个字之前的占位 */
.thinking .head {
  margin-bottom: 0;
}

.thinking .badge {
  color: var(--qz-accent);
  background: color-mix(in srgb, var(--qz-accent) 16%, transparent);
}

.thinking .title {
  color: var(--qz-muted);
  font-weight: 500;
}

.dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 2px;
}

.dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--qz-muted);
  animation: qz-dot 1.1s ease-in-out infinite;
}

.dots i:nth-child(2) { animation-delay: 0.16s; }
.dots i:nth-child(3) { animation-delay: 0.32s; }

@keyframes qz-dot {
  0%, 60%, 100% { opacity: 0.28; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}

${anchor}`
  if (!code.includes(anchor)) throw new Error('工具行锚点未匹配')
  code = code.replace(anchor, block)
  writeFileSync(path, code, 'utf8')
  console.log('chat.css：加了"正在思考中"样式与点动画')
}
