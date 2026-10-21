import { readFileSync, writeFileSync } from 'node:fs'

const path = 'vscode/extension.cjs'
let code = readFileSync(path, 'utf8')
const done = []

// 1) 后端的 stderr 落盘：以后崩了不用你复制，我自己能读
{
  const from = `      stderrTail = \`\${stderrTail}\${text}\`.slice(-3000)`
  const to = `      stderrTail = \`\${stderrTail}\${text}\`.slice(-3000)
      // 落盘一份：面板关掉 / 进程重启后 stderr 就没了，文件才是能查的
      try {
        if (runtime.globalDir) {
          const logFile = path.join(runtime.globalDir, 'backend.log')
          fs.mkdirSync(runtime.globalDir, { recursive: true })
          const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : null
          // 超过 512KB 就重开一份，别无限长
          if (stat && stat.size > 512 * 1024) fs.writeFileSync(logFile, '', 'utf8')
          fs.appendFileSync(logFile, \`\${new Date().toISOString()} \${text}\`, 'utf8')
        }
      } catch {
        // 日志写不成不能影响运行
      }`
  if (code.includes(from) && !code.includes('backend.log')) {
    code = code.replace(from, to)
    done.push('stderr 落盘 backend.log')
  }
}

// 2) 后端退出时，把 stderr 末尾也写进 activate.log
{
  const from = "    traceBoot(`后端退出 code=${code} signal=${signal ?? '-'}`)"
  const to = `    traceBoot(\`后端退出 code=\${code} signal=\${signal ?? '-'}\`)
    if (stderrTail.trim()) traceBoot(\`后端报错末尾：\${stderrTail.trim().split('\\n').slice(-6).join(' | ')}\`)`
  if (code.includes(from) && !code.includes('后端报错末尾')) {
    code = code.replace(from, to)
    done.push('退出时记 stderr 末尾')
  }
}

// 3) fs 用到了 appendFileSync / writeFileSync / statSync，确认导入齐全
{
  const importLine = code.split('\n').find((line) => line.includes("require('node:fs')"))
  if (importLine && !importLine.includes('appendFileSync')) {
    code = code.replace(
      importLine,
      "const fs = require('node:fs')",
    )
    done.push('改用 fs.* 前缀')
  }
}

writeFileSync(path, code, 'utf8')
console.log('extension.cjs:', done.join(' / ') || '(无改动)')
