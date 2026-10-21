import { readFileSync, writeFileSync } from 'node:fs'

// 1) SnapshotStore 暴露只读 entries
{
  const path = 'src/snapshot.ts'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('get entries()')) {
    const anchor = '  /** 在文件被修改之前调用：把原件存一份（同一个文件只存第一次）。 */'
    if (!code.includes(anchor)) throw new Error('capture 注释锚点没找到')
    code = code.replace(
      anchor,
      `  /** 已经快照过的条目（只读；测试和"按文件回滚"的清单都用它）。 */
  get entries(): SnapshotIndex['entries'] {
    return this.index.entries
  }

${anchor}`,
    )
    writeFileSync(path, code, 'utf8')
    console.log('snapshot.ts：加了 entries 访问器')
  }
}

// 2) 测试改成用 entries 组装 index
{
  const path = 'test/features.test.ts'
  let code = readFileSync(path, 'utf8')
  code = code.replaceAll(
    'store.snapshot()',
    "{ runId: 'run1', workspace: dir, createdAt: Date.now(), entries: store.entries }",
  )
  writeFileSync(path, code, 'utf8')
  console.log('features.test：改用 store.entries')
}
