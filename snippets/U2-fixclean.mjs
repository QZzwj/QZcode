import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/clean-extensions.ps1'
const lines = readFileSync(path, 'utf8').split('\n')

// 找到 `foreach ($name in $locked) { $map[$name] = $true }`，替换成带保命检查的写法
const index = lines.findIndex((line) => line.includes('foreach ($name in $locked)'))
if (index < 0) {
  console.log('⚠ 没找到 locked 循环')
  process.exit(0)
}

const indent = lines[index].match(/^\s*/)[0]
const replacement = [
  `${indent}# 保命检查：要保留的那个版本永远不能进 .obsolete（否则下次启动 VS Code 会删掉它）`,
  `${indent}if ($name -eq $keep.Name) { Write-Host "  ⚠ $name 是要保留的版本，不标记为待删除"; continue }`,
  lines[index],
]

lines.splice(index, 1, ...replacement)
writeFileSync(path, lines.join('\n'), 'utf8')
console.log('clean-extensions.ps1：.obsolete 不再标记保留版本')

// 复查
const check = readFileSync(path, 'utf8')
console.log('  有保命检查:', /\$name -eq \$keep\.Name/.test(check) ? '✔' : '✘')
