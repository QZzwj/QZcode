#requires -Version 5
<#
  清理多余的 QZcode 扩展版本，只留最新一个（含 .obsolete / 缓存 / 旧 vsix）。

  用法：
    pwsh -File scripts\clean-extensions.ps1              # 只清（VS Code 关掉后跑最彻底）
    pwsh -File scripts\clean-extensions.ps1 -DryRun      # 只报告，不动手
    npm run clean:ext                                    # 等价入口

  说明：正在运行的 VS Code 会锁住它加载过的版本目录；那种情况本脚本会提示你
  先把 VS Code 完全退出再跑一次。
#>
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.vscode\extensions'
if (-not (Test-Path $root)) { Write-Host "没有找到扩展目录: $root"; exit 0 }

# 1) 找出所有 qzcode 版本目录，按版本号排序
$dirs = Get-ChildItem $root -Directory | Where-Object { $_.Name -match '^qzcode\.qzcode-(\d+\.\d+\.\d+)$' } |
  Sort-Object { [version]($_.Name -replace '^qzcode\.qzcode-', '') }
if ($dirs.Count -eq 0) { Write-Host "没有安装 QZcode 扩展"; exit 0 }

$keep = $dirs[-1]
Write-Host "保留: $($keep.Name)"
$removed = 0
$locked = @()

foreach ($dir in $dirs | Where-Object { $_.Name -ne $keep.Name }) {
  if ($DryRun) { Write-Host "  [dry] 将删除 $($dir.Name)"; continue }
  try {
    Remove-Item $dir.FullName -Recurse -Force -ErrorAction Stop
    Write-Host "  ✓ 已删除 $($dir.Name)"
    $removed++
  } catch {
    Write-Host "  ✗ 被占用 $($dir.Name)（先完全退出 VS Code 再跑一次）"
    $locked += $dir.Name
  }
}

# 2) .obsolete 只留真实存在的被锁版本（其它清掉，免得 VS Code 反复尝试删除不存在的东西）
$obsolete = Join-Path $root '.obsolete'
if (-not $DryRun) {
  if ($locked.Count -gt 0) {
    $map = @{}
    # 保命检查：要保留的那个版本永远不能进 .obsolete（否则下次启动 VS Code 会删掉它）
    if ($name -eq $keep.Name) { Write-Host "  ⚠ $name 是要保留的版本，不标记为待删除"; continue }
    foreach ($name in $locked) { $map[$name] = $true }
    Set-Content -Path $obsolete -Value ($map | ConvertTo-Json -Compress) -Encoding utf8
    Write-Host "  .obsolete 已更新: $($locked -join ', ')"
  } elseif (Test-Path $obsolete) {
    $raw = Get-Content $obsolete -Raw
    if ($raw -match 'qzcode') {
      # 只删与 qzcode 有关的键，别人的保持原样
      $map = @{}
      ($raw | ConvertFrom-Json).PSObject.Properties | Where-Object { $_.Name -notmatch '^qzcode\.' } | ForEach-Object { $map[$_.Name] = $true }
      if ($map.Count -gt 0) { Set-Content -Path $obsolete -Value ($map | ConvertTo-Json -Compress) -Encoding utf8 }
      else { Remove-Item $obsolete -Force }
      Write-Host "  .obsolete 里的 qzcode 记录已清理"
    }
  }
}

# 3) 扩展 vsix 缓存与下载缓存
foreach ($cache in @("$env:APPDATA\Code\CachedExtensionVSIXs", "$env:APPDATA\Code\CachedProfilesData")) {
  if (Test-Path $cache) {
    if ($DryRun) { Write-Host "  [dry] 将清理 $cache" }
    else { Remove-Item $cache -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "  ✓ 清理 $cache" }
  }
}

# 4) 仓库里遗留的旧 vsix（只留最新）
$repo = Split-Path $PSScriptRoot -Parent
$vsix = Get-ChildItem $repo -Filter 'qzcode-*.vsix' -ErrorAction SilentlyContinue | Sort-Object Name
if ($vsix.Count -gt 1) {
  foreach ($file in $vsix | Select-Object -SkipLast 1) {
    if ($DryRun) { Write-Host "  [dry] 将删除 $($file.Name)" }
    else { Remove-Item $file.FullName -Force; Write-Host "  ✓ 已删除旧包 $($file.Name)" }
  }
}

Write-Host ""
Write-Host "现在的状态："
Get-ChildItem $root -Directory | Where-Object { $_.Name -like 'qzcode*' } | ForEach-Object { Write-Host "  $($_.Name)" }
$registry = Join-Path $root 'extensions.json'
if (Test-Path $registry) {
  try {
    $json = Get-Content $registry -Raw | ConvertFrom-Json
    $entries = @($json | Where-Object { $_.identifier.id -eq 'qzcode.qzcode' })
    Write-Host "  登记条数: $($entries.Count)（应该是 1）"
      if ($entries.Count -eq 0) {
        Write-Host "  ✗ 目录在、但 extensions.json 里没有登记：VS Code 不会加载它。"
        Write-Host "    修法：code --install-extension <最新 vsix> --force"
      }
    foreach ($entry in $entries) { Write-Host "    $($entry.identifier.id)@$($entry.version)" }
  } catch {
    Write-Host "  （extensions.json 读不动，跳过）"
  }
}
if ($locked.Count -gt 0) { Write-Host "`n还有被占用的版本，完全退出 VS Code 后再跑一次本脚本。" }
