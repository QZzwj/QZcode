import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { runAgent } from '../src/agent.ts'
import { EXAMPLE_CONFIG, normalizeConfig } from '../src/config.ts'
import { environmentBrief, systemFor } from '../src/roles.ts'
import { Toolbox, createTools } from '../src/tools.ts'
import { removeDir, tempWorkspace } from './helpers.ts'

/** 脚本化的假模型：按顺序吐出预设的工具调用或文本。 */
function scriptedClient(steps: Record<string, unknown>[]) {
  let index = 0
  return {
    role: 'implementer' as const,
    model: 'fake',
    mock: true,
    async chat() {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      if (step.text !== undefined) {
        return { content: String(step.text), toolCalls: [], usage: { prompt: 1, completion: 1, total: 2 } }
      }
      return {
        content: '',
        toolCalls: [
          {
            id: `call-${index}`,
            type: 'function' as const,
            function: { name: String(step.tool), arguments: JSON.stringify(step.args ?? {}) },
          },
        ],
        usage: { prompt: 1, completion: 1, total: 2 },
      }
    },
  }
}

test('勘察刹车：连续只读调用后提醒模型动手（写文件就清零）', async () => {
  const dir = tempWorkspace('agent-probe')
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello', 'utf8')

    const script = [
      { tool: 'read', args: { path: 'a.txt' } },
      { tool: 'read', args: { path: 'a.txt' } },
      { tool: 'ls', args: {} },
      { tool: 'read', args: { path: 'a.txt' } },
      { tool: 'read', args: { path: 'a.txt' } },
      { tool: 'ls', args: {} },
      { tool: 'write', args: { path: 'out.txt', content: 'done' } },
      { text: '写完了' },
    ]

    const notes: string[] = []
    const result = await runAgent({
      client: scriptedClient(script) as never,
      system: 'test',
      messages: [{ role: 'user', content: '做点事' }],
      toolbox: new Toolbox(createTools()),
      runtime: { workspace: dir, exec: { enabled: false, timeoutMs: 1000 } },
      maxSteps: 20,
      hooks: { onNote: (message: string) => notes.push(message) },
    })

    assert.ok(notes.some((note) => note.includes('连续只读调用')), '要提醒模型别再勘察')
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'done', '提醒之后它真的动手了')
    assert.match(result.finalText, /写完了/)
  } finally {
    removeDir(dir)
  }
})

test('环境说明：明确告诉模型别再探测系统 / shell / Node / 目录', () => {
  const dir = tempWorkspace('env-brief')
  try {
    const brief = environmentBrief(undefined, dir)
    assert.match(brief, /不要再跑命令确认/)
    assert.match(brief, /Node 版本/)
    assert.match(brief, /最多 2 次只读调用/)
    assert.ok(brief.includes(dir), '工作区路径要直接写进去')

    const config = normalizeConfig({ ...EXAMPLE_CONFIG }, { mock: true, workspace: dir })
    const roles = ['leader', 'planner', 'implementer', 'verifier'] as const
    for (const role of roles) {
      assert.match(systemFor(role, config), /不要再跑命令确认/, `${role} 的系统提示词也要带`)
    }
  } finally {
    removeDir(dir)
  }
})

test('bash 失败：给出可能原因，并提示优先用 read / ls 工具', async () => {
  const dir = tempWorkspace('bash-hint')
  try {
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: true, timeoutMs: 5000 } }
    const result = await toolbox.call('bash', JSON.stringify({ command: 'ls no-such-dir-xyz 2>/dev/null' }), runtime)
    assert.equal(result.ok, false)
    assert.match(result.output, /退出码/)
    assert.match(result.output, /\[提示\]/)
    assert.match(result.output, /read \/ ls \/ grep/)
  } finally {
    removeDir(dir)
  }
})

test('被 max_tokens 截断时不许"默默什么都不干"，要报错说清原因', async () => {
  const dir = tempWorkspace('agent-truncated')
  try {
    const client = {
      role: 'implementer' as const,
      model: 'gpt-6.1-sol',
      mock: false,
      async chat() {
        // 典型的截断：没有内容、没有工具调用、finish_reason=length
        return { content: '', toolCalls: [], usage: { prompt: 10, completion: 4096, total: 4106 }, finishReason: 'length' }
      },
    }

    await assert.rejects(
      () =>
        runAgent({
          client: client as never,
          system: 'test',
          messages: [{ role: 'user', content: '写一个跳一跳小游戏' }],
          toolbox: new Toolbox(createTools()),
          runtime: { workspace: dir, exec: { enabled: false, timeoutMs: 1000 } },
          maxSteps: 3,
        }),
      (error: Error) => {
        assert.match(error.message, /没有产出任何内容/)
        assert.match(error.message, /length/)
        assert.match(error.message, /maxTokens|max_tokens/)
        return true
      },
    )
  } finally {
    removeDir(dir)
  }
})

test('工具参数被截断（半截 JSON）时给出"调大 maxTokens"的提示', async () => {
  const dir = tempWorkspace('tool-truncated')
  try {
    const toolbox = new Toolbox(createTools())
    const runtime = { workspace: dir, exec: { enabled: false, timeoutMs: 1000 } }
    // 模拟写整页 HTML 写到一半被切断
    const result = await toolbox.call('write', '{"path":"index.html","content":"<!doctype html>\n<html>', runtime)
    assert.equal(result.ok, false)
    assert.match(result.output, /参数不是合法 JSON/)
    assert.match(result.output, /被截断/)
    assert.match(result.output, /maxTokens/)
    assert.match(result.output, /分批写文件/)
  } finally {
    removeDir(dir)
  }
})
