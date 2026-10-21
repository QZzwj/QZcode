import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/ui-check-reconnect.mjs'
let code = readFileSync(path, 'utf8')

// 在桩里记一笔：EventSource 建了几次（带 since）、fetch 打了哪些地址
code = code.replace(
  `    window.__ES_COUNT__ = 0;
    class FakeEventSource {
      constructor() {
        window.__ES_COUNT__ += 1;`,
  `    window.__ES_COUNT__ = 0;
    window.__DBG__ = [];
    class FakeEventSource {
      constructor(url) {
        window.__ES_COUNT__ += 1;
        window.__DBG__.push('ES#' + window.__ES_COUNT__ + ' ' + String(url).replace(/^.*\\/api/, '/api'));`,
)

code = code.replace(
  `    window.fetch = async (url) => {
      if (String(url).includes('/api/run')) {`,
  `    window.fetch = async (url) => {
      window.__DBG__.push('fetch ' + String(url).replace(/^.*\\/api/, '/api'));
      if (String(url).includes('/api/run')) {`,
)

code = code.replace(
  `    eventSources: window.__ES_COUNT__,`,
  `    eventSources: window.__ES_COUNT__,
    dbg: window.__DBG__,`,
)

code = code.replace(
  `if (a.errors.length) console.log('  页面异常:', a.errors)`,
  `if (a.errors.length) console.log('  页面异常:', a.errors)
console.log('  A 轨迹:', JSON.stringify(a.dbg))
console.log('  A 状态原文:', JSON.stringify(a.status))`,
)

writeFileSync(path, code, 'utf8')
console.log('checker：加了轨迹记录')
