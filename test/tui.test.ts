import assert from 'node:assert/strict'
import test from 'node:test'
import { runTui } from '../src/tui/app.ts'
import { Toolbox, createTools } from '../src/tools.ts'
import { fakeTerminal, mockConfig, removeDir, sleep, tempWorkspace } from './helpers.ts'

process.env.QZCODE_MOCK_DELAY = '0'

/** Always ends the UI so a failed assertion cannot leave the event loop spinning. */
async function finish(term: ReturnType<typeof fakeTerminal>, session: Promise<void>): Promise<void> {
  term.send('/quit')
  term.send('\r')
  term.send('\u0003')
  await Promise.race([session, sleep(3000)])
}

test('TUI lays out three panes, a log strip, and runs a task end to end', { timeout: 30000 }, async () => {
  const dir = tempWorkspace('tui')
  const term = fakeTerminal(120, 34)
  const config = mockConfig(dir)
  const toolbox = new Toolbox(createTools())
  const session = runTui({
    config,
    toolbox,
    toolRuntime: { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } },
    plugins: [],
    out: term.out,
    input: term.input,
  })
  try {
    await sleep(150)
    const first = term.text()
    assert.match(first, /QZcode/, 'title bar renders')
    assert.match(first, /A · 规划/)
    assert.match(first, /B · 实现/)
    assert.match(first, /C · 核验/)
    assert.match(first, /日志/, 'log strip renders')
    assert.match(first, /Enter/, 'hint line renders')
    assert.match(first, /│/, 'wide terminals use columns')

    term.send('写一个 notes/plan.md 并给出验证方式')
    term.send('\r')
    await sleep(2500)
    const during = term.text()
    assert.match(during, /目标：/, 'goal is echoed once a task starts')
    // A 面板末尾必然有 round 2 的内容（任务书 header / 回环复述 / 补上的验收项）
    assert.match(during, /【mock planner】|【mock reviewer】|收到 C 上一轮的|补上：/, 'A 面板要显示规划或复核的输出')
    assert.match(during, /← \w+ ok|→ \w+/, 'tool calls are traced in pane B')
    assert.match(during, /判定（第/, 'the verifier verdict is rendered')
    assert.match(during, /✔ 通过|✘ 未通过/, 'the log strip reports the outcome')
  } finally {
    await finish(term, session)
    removeDir(dir)
  }
})

test('TUI narrow terminals fall back to stacked panes', { timeout: 30000 }, async () => {
  const dir = tempWorkspace('tui-narrow')
  const term = fakeTerminal(72, 30)
  const config = mockConfig(dir)
  const toolbox = new Toolbox(createTools())
  const session = runTui({
    config,
    toolbox,
    toolRuntime: { workspace: dir, exec: { enabled: false, timeoutMs: 5000 } },
    plugins: [],
    out: term.out,
    input: term.input,
  })
  try {
    await sleep(150)
    const frame = term.text()
    assert.match(frame, /A · 规划/)
    assert.match(frame, /B · 实现/)
    assert.ok(!frame.includes('│'), 'stacked layout has no column separator')
  } finally {
    await finish(term, session)
    removeDir(dir)
  }
})
