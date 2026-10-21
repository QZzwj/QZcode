import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-reconnect.mjs'
let code = readFileSync(path, 'utf8')

// 打开异常/日志捕获，先看清楚断线恢复那条路上到底发生了什么
code = code.replace(
  `  await send('Runtime.enable')
  await sleep(300)`,
  `  await send('Runtime.enable')
  const failures2 = []
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data)
    if (data.method === 'Runtime.exceptionThrown') {
      failures2.push('EXC: ' + (data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text))
    }
    if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      failures2.push('ERR: ' + data.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })
  await sleep(300)`,
)

code = code.replace(
  `  socket.close()
  browser.kill()
  return state`,
  `  state.errors = failures2.slice(0, 5)
  socket.close()
  browser.kill()
  return state`,
)

code = code.replace(
  `check('补发的事件里带上了通过标记', a.doneTags.some((tag) => /通过/.test(tag)), JSON.stringify(a.doneTags))`,
  `check('补发的事件里带上了通过标记', a.doneTags.some((tag) => /通过/.test(tag)), JSON.stringify(a.doneTags))
if (a.errors.length) console.log('  页面异常:', a.errors)`,
)

writeFileSync(path, code, 'utf8')
console.log('checker：加上异常捕获')
