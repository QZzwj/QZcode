import { readFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------- ⑤ 按文件回滚
{
  const path = 'src/snapshot.ts'
  let code = readFileSync(path, 'utf8')
  const from = `export function restoreFromIndex(
  workspace: string,
  index: SnapshotIndex,
  ): { restored: string[]; deleted: string[]; failed: { path: string; error: string }[] } {`
  const to = `export function restoreFromIndex(
  workspace: string,
  index: SnapshotIndex,
  /** 只回滚这些路径（相对工作区）；不传 = 全部回滚。 */
  only?: string[],
  ): { restored: string[]; deleted: string[]; failed: { path: string; error: string }[] } {`
  if (code.includes(from) && !code.includes('只回滚这些路径')) {
    code = code.replace(from, to)
    // 在内部过滤
    const inner = code.slice(code.indexOf('only?: string[]'))
    const loopAnchor = inner.indexOf('for (const entry of index.entries)')
    if (loopAnchor < 0) throw new Error('entries 循环没找到')
    const insertAt = code.indexOf('only?: string[]') + loopAnchor
    code =
      code.slice(0, insertAt) +
      `const wanted = only && only.length > 0 ? new Set(only.map((item) => item.split('\\\\').join('/'))) : null\n  ` +
      code.slice(insertAt).replace(
        'for (const entry of index.entries)',
        `for (const entry of index.entries) {\n    if (wanted && !wanted.has(entry.path)) continue`,
      )
    // 上面那句会留下重复的 {，修正：把原来的 "for (...) {" 之后的多余括号处理掉
    code = code.replace(
      `for (const entry of index.entries) {
    if (wanted && !wanted.has(entry.path)) continue {`,
      `for (const entry of index.entries) {
    if (wanted && !wanted.has(entry.path)) continue`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('snapshot.ts：restoreFromIndex 支持按路径回滚')
  } else {
    console.log('⚠ restoreFromIndex 锚点未匹配')
  }
}

// ---------------------------------------------------------------- ④⑤ 后端：rollback 接受 paths
{
  const path = 'src/web/server.ts'
  let code = readFileSync(path, 'utf8')
  const from = `    const result = restoreFromIndex(toolRuntime.workspace, index)`
  const to = `    const only = Array.isArray(body.paths)
      ? (body.paths as unknown[]).filter((item): item is string => typeof item === 'string')
      : []
    const result = restoreFromIndex(toolRuntime.workspace, index, only)`
  if (code.includes(from) && !code.includes('const only = Array.isArray(body.paths)')) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('server.ts：rollback 支持 paths')
  }
}
