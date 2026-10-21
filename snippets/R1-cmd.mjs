import { readFileSync, writeFileSync } from 'node:fs'

// README 里承诺了「QZcode: 打开运行记录」这个命令 —— 补进清单（否则命令面板里没标题）
{
  const path = 'vscode/package.json'
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  const commands = pkg.contributes.commands
  if (!commands.some((item) => item.command === 'qzcode.openRunLog')) {
    const index = commands.findIndex((item) => item.command === 'qzcode.showDiff')
    commands.splice(index + 1, 0, {
      command: 'qzcode.openRunLog',
      title: '打开运行记录',
      category: 'QZcode',
    })
    // 激活事件一并补上（显式 activationEvents 时不会自动补 onCommand）
    if (!pkg.activationEvents.includes('onCommand:qzcode.openRunLog')) {
      pkg.activationEvents.push('onCommand:qzcode.openRunLog')
    }
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    console.log('manifest：加了 qzcode.openRunLog（命令 + 激活事件）')
  } else {
    console.log('已经有 openRunLog 了')
  }
}
