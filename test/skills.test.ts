import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { EXAMPLE_CONFIG, ROLE_NAMES, normalizeConfig } from '../src/config.ts'
import { activeSkills, systemFor } from '../src/roles.ts'
import { importSkill, listSkills, parseSkill, renderSkills, skillsForRole } from '../src/skills.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

test('parseSkill：front matter 解析，缺 roles 默认全角色', () => {
  const skill = parseSkill(
    ['---', 'name: demo', 'title: 演示', 'roles: implementer, verifier', 'description: 说明', '---', '正文内容'].join('\n'),
    { name: 'file-name', source: 'builtin', path: '/x/demo.md' },
  )
  assert.equal(skill.name, 'demo')
  assert.equal(skill.title, '演示')
  assert.deepEqual(skill.roles, ['implementer', 'verifier'])
  assert.equal(skill.body, '正文内容')

  const bare = parseSkill('没有 front matter 的正文', { name: 'plain', source: 'user', path: '/x/plain.md' })
  assert.equal(bare.name, 'plain')
  assert.deepEqual(bare.roles, ROLE_NAMES.slice(), '没写 roles = 所有角色都能用')
})

test('内置技能按角色生效：B 拿到实现纪律，C 拿到核验纪律', () => {
  const dir = tempWorkspace('skills')
  try {
    const config = normalizeConfig({ ...EXAMPLE_CONFIG }, { mock: true, workspace: dir })
    const implementer = activeSkills('implementer', config).map((skill) => skill.name)
    const verifier = activeSkills('verifier', config).map((skill) => skill.name)
    const planner = activeSkills('planner', config).map((skill) => skill.name)

    assert.ok(implementer.includes('code-implementer'), 'B 要有实现纪律')
    assert.ok(verifier.includes('verified-delivery'), 'C 要有核验纪律')
    assert.ok(planner.includes('prompt-writer'), 'A 要有任务书写作')
    assert.ok(!implementer.includes('verified-delivery'), 'C 的技能不该给 B')

    // 系统提示词里真的写进去了
    const text = systemFor('implementer', config)
    assert.match(text, /技能：实现纪律/)
    assert.match(text, /最小改动/)
  } finally {
    removeDir(dir)
  }
})

test('skills.enabled=false 或按角色勾选可以关掉技能', () => {
  const dir = tempWorkspace('skills-off')
  try {
    const off = normalizeConfig({ ...EXAMPLE_CONFIG, skills: { enabled: false } }, { mock: true, workspace: dir })
    assert.equal(activeSkills('implementer', off).length, 0)

    // 勾选列表管不到内置技能：B 依然有自己的实现纪律
    const picked = normalizeConfig(
      { ...EXAMPLE_CONFIG, roles: { ...EXAMPLE_CONFIG.roles, implementer: { skills: ['verified-delivery'] } } },
      { mock: true, workspace: dir },
    )
    const names = activeSkills('implementer', picked).map((skill) => skill.name)
    assert.ok(names.includes('code-implementer'), '内置技能不该被勾选列表挤掉')
    assert.ok(!names.includes('verified-delivery'), '角色不适用就不会出现（即使被勾上）')
  } finally {
    removeDir(dir)
  }
})

test('导入技能：从文件读进来，只给 B/C，并在提示词里生效', async () => {
  const dir = tempWorkspace('skills-import')
  try {
    const userDir = join(dir, 'skills')
    mkdirSync(userDir, { recursive: true })

    // 源文件（模拟用户从 GitHub 下载的 SKILL.md）
    const source = join(dir, 'SKILL.md')
    writeFileSync(source, ['# 我的技能', '', '1. 先读再改', '2. 改完跑测试'].join('\n'), 'utf8')

    const imported = await importSkill({ userDir, source: 'path', value: source })
    assert.equal(imported.ok, true)
    assert.equal(imported.skill?.roles.includes('implementer'), true, '默认给 B')
    assert.equal(imported.skill?.roles.includes('verifier'), true, '默认给 C')
    assert.equal(imported.skill?.roles.includes('planner'), false, '默认不给 A')

    const config = normalizeConfig({ ...EXAMPLE_CONFIG, skills: { dir: userDir } }, { mock: true, workspace: dir })
    const verifierSkills = activeSkills('verifier', config).map((skill) => skill.name)
    assert.ok(verifierSkills.some((name) => name.startsWith('skill')), '导入的技能要出现在 C 的列表里')
    assert.match(renderSkills(activeSkills('implementer', config)), /先读再改/)
  } finally {
    removeDir(dir)
  }
})

test('导入：路径不存在要给出明确错误', async () => {
  const dir = tempWorkspace('skills-missing')
  try {
    const result = await importSkill({ userDir: join(dir, 'skills'), source: 'path', value: join(dir, 'nope.md') })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /找不到路径/)
    assert.equal(
      listSkills(join(dir, 'skills')).filter((skill) => skill.source === 'user').length,
      0,
      '导入失败不该在磁盘上留下东西',
    )
  } finally {
    removeDir(dir)
  }
})

test('目录形式的技能（SKILL.md + references/）：整树导入、roles 合并、参考资料只给路径', async () => {
  const dir = tempWorkspace('skills-dir-import')
  try {
    // 模拟一个 GitHub 仓库：SKILL.md 带 front matter（没有 roles）+ references/
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, 'references'), { recursive: true })
    writeFileSync(
      join(repo, 'SKILL.md'),
      ['---', 'name: gpt6-like', 'description: 演示技能', '---', '# 技能正文', '', '先定交付物。'].join('\n'),
      'utf8',
    )
    writeFileSync(join(repo, 'references', 'patterns.md'), '# 参考\n模块 A', 'utf8')

    const userDir = join(dir, 'skills')
    const imported = await importSkill({ userDir, source: 'path', value: repo, name: 'gpt6-like', roles: 'leader, planner' })
    assert.equal(imported.ok, true)
    assert.deepEqual(imported.skill?.roles, ['leader', 'planner'], 'roles 要合并进已有 front matter')
    assert.deepEqual(imported.skill?.references.map((ref) => ref.name), ['patterns'], '参考资料要跟着复制')

    // 正文里不该残留 front matter
    assert.doesNotMatch(imported.skill?.body ?? '', /^---/m, 'front matter 不能被当成正文')
    assert.match(imported.skill?.body ?? '', /先定交付物/)

    const config = normalizeConfig({ ...EXAMPLE_CONFIG, skills: { dir: userDir } }, { mock: true, workspace: dir })
    const text = systemFor('planner', config)
    assert.match(text, /技能：gpt6-like/)
    assert.match(text, /patterns\.md/, '参考资料路径要出现在提示词里')
    assert.ok(!text.includes('模块 A'), '参考资料内容不该被内联')

    // 只给 L/A：B 的系统提示词里没有它
    assert.doesNotMatch(systemFor('implementer', config), /技能：gpt6-like/)
  } finally {
    removeDir(dir)
  }
})
