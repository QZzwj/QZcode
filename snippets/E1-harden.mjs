import { readFileSync, writeFileSync } from 'node:fs'

// 1) killTree：spawn 失败不能把进程搞崩（Windows 上 taskkill 缺失/受限时会报 ENOENT）
{
  const path = 'src/tools.ts'
  let code = readFileSync(path, 'utf8')
  const from = `    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    }`
  const to = `    if (process.platform === 'win32' && child.pid) {
      // spawn 找不到可执行文件时会发 'error' 事件；不接住它 = 整个后端进程崩掉
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.on('error', () => {
        try {
          child.kill()
        } catch {
          // 已经没了
        }
      })
      return
    }`
  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('tools.ts：killTree 接住 spawn 错误')
  } else {
    console.log('⚠ killTree 锚点未匹配')
  }
}

// 2) server：任何未预期异常都把"路径 + 堆栈首行"写进侧栏，并对 ENOENT 给出人话提示
{
  const path = 'src/web/server.ts'
  let code = readFileSync(path, 'utf8')

  const from = `        const aborted = (error as Error).name === 'AbortError'`
  const to = `        // 把原始错误完整留在输出面板，侧栏只给一句能行动的提示
        const raw = error as Error
        logger.error(\`[run] \${raw.name ?? 'Error'}: \${raw.message}\`)
        if (raw.stack) logger.error(raw.stack)
        if (/ENOENT/.test(raw.message)) {
          const target = raw.message.match(/'([^']+)'/)?.[1] ?? '(未知路径)'
          push(run, {
            t: 'note',
            level: 'error',
            message: \`文件路径不存在：\${target}（检查工作区是否还在、是否有写权限）\`,
          })
        }

        const aborted = (error as Error).name === 'AbortError'`
  if (code.includes(from) && !code.includes('文件路径不存在：')) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('server.ts：异常写日志 + ENOENT 人话提示')
  } else if (code.includes('文件路径不存在：')) {
    console.log('已经有了')
  } else {
    console.log('⚠ aborted 锚点未匹配')
  }
}

// 3) 后端致命错误也落盘（前端拿不到 stderr 时，activate.log 里能查到）
{
  const path = 'vscode/extension.cjs'
  let code = readFileSync(path, 'utf8')
  const from = `        run.error = String((error as Error)?.message ?? error)`
  const to = `        run.error = String((error as Error)?.message ?? error)`
  void from
  if (!code.includes('traceBoot(`后端退出')) {
    code = code.replace(
      `    output().appendLine(\`[exit] 后端退出 code=\${code} signal=\${signal ?? '-'}\`)`,
      `    output().appendLine(\`[exit] 后端退出 code=\${code} signal=\${signal ?? '-'}\`)
    traceBoot(\`后端退出 code=\${code} signal=\${signal ?? '-'}\`)`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('extension.cjs：后端退出一并记进 activate.log')
  }
}
