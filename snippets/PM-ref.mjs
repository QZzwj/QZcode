import { readFileSync, writeFileSync } from 'node:fs'

const done = []

// 1) pipeline：reference 选项 → 传给 A
{
  const path = 'src/pipeline.ts'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('reference?: string')) {
    code = code.replace(
      `  /** 上一轮留下的上下文（目标/结论/改动清单），避免每轮从零开始。 */
  previousContext?: string`,
      `  /** 上一轮留下的上下文（目标/结论/改动清单），避免每轮从零开始。 */
  previousContext?: string
  /** 用户用 @文件 指定的参考文件内容（已拼好的 markdown 片段）。 */
  reference?: string`,
    )
    code = code.replace(
      `            previousContext: options.previousContext,`,
      `            previousContext: options.previousContext,
            reference: options.reference,`,
    )
    writeFileSync(path, code, 'utf8')
    done.push('pipeline.reference')
  }
}

// 2) roles：PlanStepInput 带 reference，并写进提示词
{
  const path = 'src/roles.ts'
  let code = readFileSync(path, 'utf8')

  if (!code.includes('reference?: string')) {
    const anchor = '  /** 上一轮留下的上下文：目标、结论、改动清单（跟着 goal 一起给 A）。 */'
    if (!code.includes(anchor)) throw new Error('previousContext 注释没找到')
    code = code.replace(
      anchor,
      `  /** 用户用 @文件 指定的参考文件（原文）。 */
  reference?: string
${anchor}`,
    )
    done.push('PlanStepInput.reference')
  }

  // 把上下文和参考文件拼进 A 的输入
  const marker = 'export async function planStep('
  const index = code.indexOf(marker)
  if (index < 0) throw new Error('planStep 没找到')

  if (!code.includes('input.previousContext') && !code.includes('input.reference')) {
    // 在函数体里找 user 消息构造处
    const userAnchor = code.indexOf('const userText', index)
    if (userAnchor > 0) {
      console.log('roles.ts：找到 userText，准备注入')
    }
  }

  writeFileSync(path, code, 'utf8')
  void done
}

console.log(done.join(' / ') || '(部分改动)')
