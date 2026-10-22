import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/clean-extensions.ps1'
let code = readFileSync(path, 'utf8')
const done = []

// 1) 绝不把"要保留的那个版本"写进 .obsolete —— 之前就是这么把刚装的版本标记成待删除，
//    下次启动 VS Code 会把整个目录删掉，扩展直接消失。
const from = `    if ($locked.Count -gt 0) {
      $map = @{}
      foreach ($name in $locked) { $map[$name] = $true }`
const to = `    if ($locked.Count -gt 0) {
      $map = @{}
      foreach ($name in $locked) {
        # 保命检查：要保留的那个版本永远不能进 .obsolete
        if ($name -eq $keep.Name) { Write-Host "  ⚠ 跳过：$name 是要保留的版本，不能标记为待删除"; continue }
        $map[$name] = $true
      }`
if (code.includes(from)) {
  code = code.replace(from, to)
  done.push('.obsolete 不再标记保留版本')
}

// 2) 结尾再核一次登记数，0 条就报警（这才是"装了但没生效"的真因）
const tailFrom = `  Write-Host "  登记条数: $($entries.Count)（应该是 1）"`
const tailTo = `  Write-Host "  登记条数: $($entries.Count)（应该是 1）"
      if ($entries.Count -eq 0) {
        Write-Host "  ✗ 目录在、但 extensions.json 里没有登记：VS Code 不会加载它。"
        Write-Host "    修法：code --install-extension <最新 vsix> --force"
      }`
if (code.includes(tailFrom)) {
  code = code.replace(tailFrom, tailTo)
  done.push('结尾核登记数')
}

writeFileSync(path, code, 'utf8')
console.log(done.join(' / ') || '(无改动)')
