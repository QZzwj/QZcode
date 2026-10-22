import { readFileSync, writeFileSync } from 'node:fs'

const done = []

// 1) 详情页：设置面板是四张卡片，不是三张
{
  const path = 'vscode/README.md'
  let code = readFileSync(path, 'utf8')
  const from = '2. 三个模型卡片（A 写任务书 / B 实现 / C 核验）各选一个供应商、填 API key'
  const to = '2. 四张角色卡片（L 分流 / A 写任务书 / B 实现 / C 核验）各选一个供应商、填 API key；嫌麻烦可以只配一个，然后点「三个都用这套」复制给其它角色'
  if (code.includes(from)) {
    code = code.replace(from, to)
    done.push('设置卡片数量')
  } else {
    console.log('⚠ 卡片那句没匹配')
  }
  writeFileSync(path, code, 'utf8')
}

// 2) 角色标题里也别写"管全程"（L 只做分流）
{
  const path = 'src/config.ts'
  let code = readFileSync(path, 'utf8')
  const from = "leader: 'L · 调度（管全程 · 省 token）',"
  const to = "leader: 'L · 分流（判断这轮怎么走 · 省 token）',"
  if (code.includes(from)) {
    code = code.replace(from, to)
    writeFileSync(path, code, 'utf8')
    done.push('L 的角色标题')
  }
}

// 3) CHANGELOG 补 3.6.1
{
  const path = 'vscode/CHANGELOG.md'
  let code = readFileSync(path, 'utf8')
  if (!code.includes('**3.6.1**')) {
    code = code.replace(
      '## 3.6.x\n',
      `## 3.6.x

- **3.6.1** 文档求真：删掉/改正与实际不符的说法（"L 管全程"→ L 只做分流、复核是 A；"15 项体检"→ 实测 9 项；"装好即用"→ 需要填一次 key；"自带两个插件例子"→ 例子只在仓库里）。另外**计划模式现在真的会跳过 L**（之前只跳过 A，与文档不一致）。\n`,
    )
    writeFileSync(path, code, 'utf8')
    done.push('CHANGELOG 3.6.1')
  }
}

console.log(done.join(' / ') || '(无改动)')
