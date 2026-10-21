import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-reconnect.mjs'
let code = readFileSync(path, 'utf8')

// 模板字符串里 \/ 会被吃掉，正则变成非法；改用不含正则的写法
code = code.replace(
  `        window.__DBG__.push('ES#' + window.__ES_COUNT__ + ' ' + String(url).replace(/^.*\\/api/, '/api'));`,
  `        window.__DBG__.push('ES#' + window.__ES_COUNT__ + ' ' + String(url).split('?')[1]);`,
)
code = code.replace(
  `      window.__DBG__.push('fetch ' + String(url).replace(/^.*\\/api/, '/api'));`,
  `      window.__DBG__.push('fetch ' + String(url).slice(-40));`,
)

writeFileSync(path, code, 'utf8')
console.log('桩里去掉正则')
