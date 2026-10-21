import { readFileSync, writeFileSync } from 'node:fs'

// roles.ts：把上一轮上下文和 @文件 参考内容拼进 A 的 user 消息
{
  const path = 'src/roles.ts'
  let code = readFileSync(path, 'utf8')

  const from = `  if (input.leaderHint?.trim()) {
    sections.push(\`## L 的提示（调度模型的判断，仅供参考）\\n\\n\${input.leaderHint.trim()}\`)
  }
  sections.push('现在按系统提示要求，先给摘要，再给唯一的 \`\`\`json 代码块。')`

  const to = `  if (input.leaderHint?.trim()) {
    sections.push(\`## L 的提示（调度模型的判断，仅供参考）\\n\\n\${input.leaderHint.trim()}\`)
  }
  if (input.previousContext?.trim()) {
    // 上一轮干过什么：让"把它改成深色"这种话不用重新交代背景
    sections.push(\`## 上一轮的情况（不是本轮目标，只作背景）\\n\\n\${input.previousContext.trim()}\`)
  }
  if (input.reference?.trim()) {
    // 用户用 @文件 指过来的原文
    sections.push(input.reference.trim())
  }
  sections.push('现在按系统提示要求，先给摘要，再给唯一的 \`\`\`json 代码块。')`

  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    console.log('roles.ts：A 的输入带上上一轮上下文与 @文件')
  } else {
    console.log('⚠ planStep sections 锚点未匹配')
  }
}

// server.ts：解析 @文件 → 读内容 → 传给流水线
{
  const path = 'src/web/server.ts'
  let code = readFileSync(path, 'utf8')
  const done = []

  if (!code.includes("from '../reference.ts'")) {
    code = code.replace(
      `import { writeRunLog } from '../runlog.ts'`,
      `import { writeRunLog } from '../runlog.ts'\nimport { buildReferenceBlock, extractFileRefs } from '../reference.ts'`,
    )
    done.push('引入 reference')
  }

  // startRun 里算参考块（带 @ 才做，普通目标零开销）
  const from = `        const previousContext = options2.planOnly === true ? undefined : lastRunContext(toolRuntime.workspace)`
  const to = `        const previousContext = options2.planOnly === true ? undefined : lastRunContext(toolRuntime.workspace)
        // 目标里出现 @文件 就把原文附给 A（前端碰不到文件系统，只能后端读）
        const refs = [...extractFileRefs(goal), ...extraRefs]
        const reference = refs.length > 0 ? buildReferenceBlock(toolRuntime.workspace, refs) : { block: '', files: [] }
        if (refs.length > 0) {
          const used = reference.files.filter((file) => file.ok)
          push(run, {
            t: 'note',
            level: used.length > 0 ? 'info' : 'warn',
            message:
              used.length > 0
                ? \`已附上参考文件：\${used.map((file) => file.path).join('、')}\`
                : \`@ 引用的文件都没用上：\${reference.files.map((file) => \`\${file.raw}（\${file.reason}）\`).join('、')}\`,
          })
        }`
  if (code.includes(from) && !code.includes('buildReferenceBlock(toolRuntime.workspace')) {
    code = code.replace(from, to)
    done.push('解析 @ 文件')
  }

  // 传给流水线
  code = code.replace(
    `          previousContext,
        })`,
    `          previousContext,
          reference: reference.block || undefined,
        })`,
  )

  // startRun 签名加 extraRefs
  code = code.replace(
    `    options2: { planOnly?: boolean; presetPlan?: unknown } = {},`,
    `    options2: { planOnly?: boolean; presetPlan?: unknown; files?: string[] } = {},`,
  )
  code = code.replace(
    `        // 目标里出现 @文件 就把原文附给 A（前端碰不到文件系统，只能后端读）
        const refs = [...extractFileRefs(goal), ...extraRefs]`,
    `        // 目标里出现 @文件 就把原文附给 A（前端碰不到文件系统，只能后端读）
        const extraRefs = Array.isArray(options2.files) ? options2.files : []
        const refs = [...new Set([...extractFileRefs(goal), ...extraRefs])]`,
  )
  // 调用点带上 files
  code = code.replace(
    `          const run = startRun(goal, { planOnly, presetPlan })`,
    `          const run = startRun(goal, { planOnly, presetPlan, files: extraFiles })`,
  )

  writeFileSync(path, code, 'utf8')
  console.log('server.ts:', done.join(' / ') || '(无改动)')
}
