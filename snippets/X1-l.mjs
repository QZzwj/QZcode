import { readFileSync, writeFileSync } from 'node:fs'

const done = []

// 1) 详情页：用"L 管全程"这个说法，但括号里说清它实际管什么（既好懂又站得住）
{
  const path = 'vscode/README.md'
  let code = readFileSync(path, 'utf8')
  const from = 'L   判断这一轮怎么走（走完整流水线 / 直接回答 / 追问）'
  const to = 'L   管全程：决定这一轮怎么走（走完整流水线 / 直接回答 / 追问），活儿往下派'
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('详情页流程图')
  } else {
    console.log('⚠ 流程图那句没匹配')
  }

  // 开头那句也点一下 L 的定位，别让人以为它是"老板但不干活"
  const introFrom = '在编辑器里跑一条**四角色接力**的流水线，把一句话目标做成真正的改动：'
  const introTo = '在编辑器里跑一条**四角色接力**的流水线，把一句话目标做成真正的改动。L 管全程（决定怎么走、派活），A 出任务书并复核，B 动手，C 独立核验：'
  if (code.includes(introFrom)) {
    code = code.replace(introFrom, introTo)
    done.push('详情页开头')
  }
  writeFileSync(path, code, 'utf8')
}

// 2) 设置面板里的角色标题也统一口径
{
  const path = 'src/config.ts'
  let code = readFileSync(path, 'utf8')
  const from = "leader: 'L · 分流（判断这轮怎么走 · 省 token）',"
  const to = "leader: 'L · 管全程（决定这轮怎么走 · 省 token）',"
  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    done.push('L 的角色标题')
  }
}

// 3) 仓库 README 同步
{
  const path = 'README.md'
  let code = readFileSync(path, 'utf8')
  code = code.replace(
    'L 分流 → A 写任务书 → B 实现 → A 复核 → C 核验 → （不通过退回 A 重写，最多 3 轮）',
    'L 管全程（决定怎么走、派活）→ A 写任务书 → B 实现 → A 复核 → C 核验 → （不通过退回 A 重写，最多 3 轮）',
  )
  writeFileSync(path, code, 'utf8')
  done.push('仓库 README')
}

// 4) CHANGELOG
{
  const path = 'vscode/CHANGELOG.md'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('**3.6.2**')) {
    code = code.replace(
      '## 3.6.x\n',
      '## 3.6.x\n\n- **3.6.2** 口径统一：对外继续用「L 管全程」，但详情页括号里写清它实际决定的是"这一轮怎么走"（分流 / 直接回答 / 追问），不夸大。\n',
    )
    writeFileSync(path, code, 'utf8')
    done.push('CHANGELOG 3.6.2')
  }
}

console.log(done.join(' / ') || '(无改动)')
