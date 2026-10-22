import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

/**
 * 清理：删掉真正用不到的东西。
 * 每一步都打印，删完会跑测试/打包验证，所以不是"删了就跑"。
 */

const removed = []
const skipped = []

function gitRm(path, { keepLocal = false } = {}) {
  if (!existsSync(path)) {
    skipped.push(path + '（本来就没有）')
    return
  }
  try {
    execFileSync('git', ['rm', '-r', '--cached', '-q', '--', path], { stdio: 'pipe' })
  } catch {
    // 未跟踪的文件 git rm 会失败，正常
  }
  if (!keepLocal) {
    rmSync(path, { recursive: true, force: true })
  }
  removed.push(path)
}

// ---------------------------------------------------------------- 1) 密钥文件：必须从仓库里拿掉
// 根目录 qzcode.json 里有真实的 apiKey，而且已经推到公开仓库了 → 不再跟踪，本地留一份给 npm run demo 用
gitRm('qzcode.json', { keepLocal: true })

// ---------------------------------------------------------------- 2) 过时文档与只被它引用的图
gitRm('README.en.md') // 0.3 时代英文 README，写的是三模型 + 工作台
gitRm('assets') // hero.en.svg / hero.zh.svg，只被上面那个 README 和 manual.zh.md 引用
gitRm('docs/manual.zh.md') // 20 KB 的 0.3 时代手册（三模型 / 工作台）
gitRm('docs/pi-alignment.md') // 历史设计对照，已不适用

// ---------------------------------------------------------------- 3) 仓库里跑出来的临时产物
gitRm('notes') // mock 跑出来的 notes/plan.md
gitRm('.qzcode') // 跑 mock 留下的运行记录

// ---------------------------------------------------------------- 4) 一次性脚本（功能已被测试或 probe-installed 覆盖）
for (const file of [
  'scripts/boot-timing.mjs', // 启动耗时调优，已结束
  'scripts/fix-release-asset.mjs', // 只为修 3.6.0 那次附件名
  'scripts/logo.mjs', // 生成 logo 的一次性脚本，产物已经在 media/icon.png
  'scripts/probe-cost-null.mjs',
  'scripts/probe-cost-page.mjs',
  'scripts/probe-cost.mjs',
  'scripts/probe-settings-real.mjs',
  'scripts/probe-electron-node.mjs', // probe-installed 已覆盖同样的事
  'scripts/smoke-activate.mjs', // 被 ui-check-* 取代
  'scripts/smoke-view.mjs',
  'scripts/ui-measure.mjs',
  'scripts/install-skillhub-skills.sh', // 一次性装技能的 shell
]) {
  gitRm(file)
}

// ---------------------------------------------------------------- 5) 旧发布说明（GitHub Release 里都有，留最新的）
for (const file of ['release-notes-3.5.8.md', 'release-notes-3.6.0.md', 'release-notes-3.6.1.md']) {
  gitRm(file)
}

// ---------------------------------------------------------------- 6) 未跟踪的缓存/上游快照（gitignore 里，纯占磁盘）
for (const dir of ['.npm-cache', '.reference', '.tmp-global']) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    removed.push(dir + '（未跟踪的缓存/快照）')
  }
}

console.log('已删除:')
for (const item of removed) console.log('  - ' + item)
if (skipped.length) {
  console.log('跳过:')
  for (const item of skipped) console.log('  - ' + item)
}
