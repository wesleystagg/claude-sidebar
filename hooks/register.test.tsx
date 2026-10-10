import { test, expect, mock } from 'claude-code/testing'
import type { SessionContextBreakdown, SessionUsage } from 'claude-code'

const NOW = Date.parse('2026-10-07T12:00:00Z')

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 12_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 8_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 40_000, color: 'success', isDeferred: false, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 5_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'Free space', tokens: 107_000, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'subtle', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 60_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'auto',
  percentage: 30,
  gridRows: [],
  model: 'test-model',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 166_000,
  apiUsage: null,
}

let fiveHour = 23.5
const usage = (): SessionUsage => ({
  startedAt: 0,
  context: { window: 200_000, tokens: 60_000, percent: 30, breakdown: BREAKDOWN },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-07T14:10:00Z' },
    { kind: 'seven_day', percentUsed: 60, resetsAt: '2026-10-10T12:00:00Z' },
  ],
})

const PANE = {
  component: 'Pane',
  requestId: 'sidebar',
  props: {
    title: 'Sidebar',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 160, rows: 48, isFullscreen: true },
} as const

const RUN = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

test('/sidebar opens the pane and draws context segments and usage rows', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  let calls = 0
  on('session.usage', () => {
    calls += 1
    return { value: usage() }
  })
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.cwd', () => ({ value: '/Users/wesley/Projects/agency-os' }))
  on('session.repo', () => ({ value: { root: '/Users/wesley/Projects/agency-os', remote: null, internal: false, name: null } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not mocked', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('/.git/HEAD') ? 'ref: refs/heads/main\n' : '' }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 150_000, tokensAfter: 20_000 }))
  on('classic.UserPromptSubmit', () => ({}))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '' } }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 30_000, output_tokens: 2_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' },
    }
  })
  const opened: string[] = []
  const closed: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })

  const { text } = await $.command.run({ command: 'sidebar', args: '', ...RUN })
  expect(text).toMatch(/open/)
  expect(opened).toEqual(['sidebar'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'sidebar', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /30%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^fable-5-1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /none spawned yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /compact @ 83%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^agency-os$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~\/Projects\/agency-os/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /System prompt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Messages/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /deferred/ })).toBeUndefined()
    // the stacked bar spans the pane's full body width
    const bar = (await ui.findAll({ type: 'Text', text: /^[█▒░]+$/ })).slice(0, 5)
    expect(bar.reduce((sum, t) => sum + t.text.length, 0)).toBe(44)
    expect(await ui.find({ type: 'Text', text: /5h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /23\.5%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets in 2h 10m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets in 3d/ })).toBeDefined()
    await ui.unmount()
  }

  // A subagent spawned on another model shows as running, then done with the model that answered.
  const spawn = await $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'build the page',
    description: 'Build landing page',
    subagentType: 'coder',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-fable-5-1',
    background: false,
    fork: false,
  })
  expect(spawn.agentId).toBe('agent-1')
  const mid = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await mid.find({ type: 'Text', text: /1 running/ })).toBeDefined()
  expect(await mid.find({ type: 'Text', text: /^coder/ })).toBeDefined()
  expect(await mid.find({ type: 'Text', text: /opus-5-5 · Build landing page/ })).toBeDefined()
  expect(await mid.find({ type: 'Text', text: /⚠ frontier/ })).toBeDefined()
  await mid.unmount()

  // Two requests inside its loop: its window fills and the burn adds up. (The kit raises tool
  // calls on the main loop only, so the per-agent tool count is exercised in a session, not here.)
  for (const index of [0, 1]) {
    const stream = $.turn.step({ turnId: 't-1', index, model: 'claude-sonnet-5-5', messageCount: 4 + index * 2, agentId: 'agent-1' })
    for await (const _chunk of stream) {
      // drain
    }
    await stream.result
  }
  const busy = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  // 40k of a 200k window = 2 of 10 cells; 2 requests of 42k burned = 84k
  expect(await busy.find({ type: 'Text', text: /^ 40k$/ })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: /^██$/ })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: /^84k tok$/ })).toBeDefined()
  await busy.unmount()

  await clock.advance(90_000)
  await $.turn.complete({
    answer: 'done',
    durationMs: 90_000,
    isAborted: false,
    turnId: 't-1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' },
  })
  const after = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await after.find({ type: 'Text', text: /running/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /haiku-5-5 · Build landing page/ })).toBeDefined()
  expect(await after.find({ type: 'Text', text: /⚠ frontier/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /1m30s/ })).toBeDefined()
  await after.unmount()

  // A local fleet call through the MCP tool and through the cfn command line.
  await $.tool.call({ tool: 'mcp__fleet__node_ask', tool_use_id: 'tu-2', node: 'gb10', model: 'bigcoder', prompt: 'x' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-3', command: 'echo hi | cfn fleet ask -m coder' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-4', command: 'ls -la' })
  const local = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await local.find({ type: 'Text', text: /⌂ gb10/ })).toBeDefined()
  expect(await local.find({ type: 'Text', text: /^\s*bigcoder$/ })).toBeDefined()
  expect(await local.find({ type: 'Text', text: /⌂ fleet/ })).toBeDefined()
  expect(await local.find({ type: 'Text', text: /^\s*coder$/ })).toBeDefined()
  expect((await local.findAll({ type: 'Text', text: /^[●✓✗] $/ })).length).toBe(3)
  await local.unmount()

  // Effort rides on the main loop's requests, the permission mode on the prompt's classic hook.
  {
    const stream = $.turn.step({ turnId: 't-2', index: 0, model: 'claude-fable-5-1', effort: 'max', messageCount: 10 })
    for await (const _chunk of stream) {
      // drain
    }
    await stream.result
  }
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'plan' })
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'long transcript', toolUses: [] }] })
  const modes = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await modes.find({ type: 'Text', text: /effort max/ })).toBeDefined()
  expect(await modes.find({ type: 'Text', text: /^plan$/ })).toBeDefined()
  expect(await modes.find({ type: 'Text', text: /compacted 1× · last just now/ })).toBeDefined()
  // BY MODEL: three API requests so far all answered by sonnet (42k each), two local calls by tag.
  expect(await modes.find({ type: 'Text', text: /^sonnet-5-5/ })).toBeDefined()
  expect(await modes.find({ type: 'Text', text: /^\s*126k$/ })).toBeDefined()
  expect(await modes.find({ type: 'Text', text: /^⌂ bigcoder/ })).toBeDefined()
  expect(await modes.find({ type: 'Text', text: /^\s*1 call$/ })).toBeDefined()
  await modes.unmount()

  // Burn rate: the 5h window climbs 2 points a minute over four ticks, so a "full in" estimate appears.
  for (let i = 0; i < 4; i += 1) {
    fiveHour += 2
    await clock.advance(60_000)
  }
  const pace = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await pace.find({ type: 'Text', text: /31\.5%/ })).toBeDefined()
  expect(await pace.find({ type: 'Text', text: /full in ~\d+m/ })).toBeDefined()
  await pace.unmount()

  // Finished rows fade two minutes after they ended; the session's burn total stays in the header.
  await clock.advance(2 * 60_000)
  const faded = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect((await faded.findAll({ type: 'Text', text: /^[●✓✗] $/ })).length).toBe(0)
  expect(await faded.find({ type: 'Text', text: /none running/ })).toBeDefined()
  expect(await faded.find({ type: 'Text', text: /^84k tok$/ })).toBeDefined()
  await faded.unmount()

  // Idle: the once-a-minute tick re-takes the figures, so the countdown moves
  // (7.5 min passed above, 2 more here: 130 min - 9.5 min rounds to 2h 1m).
  const live = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  await clock.advance(2 * 60_000)
  expect(await live.find({ type: 'Text', text: /resets in 2h 1m/ })).toBeDefined()
  await clock.advance(2 * 60 * 60_000 + 8 * 60_000)
  expect(await live.find({ type: 'Text', text: /reset due/ })).toBeDefined()
  await live.unmount()

  const off = await $.command.run({ command: 'sidebar', args: '', ...RUN })
  expect(off.text).toMatch(/closed/)
  expect(closed).toEqual(['sidebar'])

  // Off: the tick is cancelled, so nothing is re-taken while idle.
  const before = calls
  await clock.advance(5 * 60_000)
  expect(calls).toBe(before)
})

const ROOT = '/Users/wesley/Projects/claude-sidebar'
const NUL = '\0'

/** A git answer by argv: the status, the tracked list, both numstats and the unpushed set of the FILES fixture. */
function gitAnswer(argv: readonly string[]): string {
  const line = argv.slice(1).join(' ')
  if (line.startsWith('status')) {
    return ['## main...origin/main [ahead 1]', ' M hooks/register.tsx', 'A  hooks/register.test.tsx', ' M README.md', '!! node_modules/', ''].join(NUL)
  }
  if (line === 'ls-files -z') {
    return ['README.md', 'docs/FEEDBACK.md', 'hooks/register.test.tsx', 'hooks/register.tsx', 'types/index.d.ts', ''].join(NUL)
  }
  if (line === 'diff --numstat -z') return ['41\t3\thooks/register.tsx', '6\t1\tREADME.md', ''].join(NUL)
  if (line === 'diff --numstat --cached -z') return ['88\t0\thooks/register.test.tsx', ''].join(NUL)
  if (line.startsWith('diff --name-only')) return ['types/index.d.ts', ''].join(NUL)
  return ''
}

/** The mocks every FILES test needs, with git answering from the fixture. */
function bootFiles(on: Parameters<Parameters<typeof test>[1]>[1], repo: boolean) {
  mock.store(on)
  on('session.usage', () => ({ value: usage() }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.cwd', () => ({ value: repo ? ROOT : '/Users/wesley/scratch' }))
  on('session.repo', () => ({ value: repo ? { root: ROOT, remote: null, internal: false, name: null } : null }))
  on('fs.read', () => ({ value: 'ref: refs/heads/main\n' }))
  on('fs.list', () => ({
    value: [
      { name: 'notes.txt', kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false },
      { name: 'src', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: gitAnswer(e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '' } }))
}

test('FILES draws the pruned tree with git letters, numstat and unpushed marks', async ($, on) => {
  mock.clock(on, { now: NOW + 3_600_000 })
  bootFiles(on, true)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^FILES$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^↑1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 changed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /register\.tsx/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^M \+41 −3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^A \+88$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^M \+6 −1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /index\.d\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^↑$/ })).toBeDefined()
  // docs holds only a clean file: one collapsed row with a count of 1, and its file stays out of sight
  expect(await ui.find({ type: 'Text', text: /^docs\s*$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▸ $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /FEEDBACK\.md/ })).toBeUndefined()
  // the ignored folder is a dim row
  const ignored = await ui.find({ type: 'Text', text: /node_modules/ })
  expect(ignored).toBeDefined()
  expect(ignored?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('FILES marks a written file while the tool runs and drops the mark after 45 s', async ($, on) => {
  const clock = mock.clock(on, { now: NOW + 7_200_000 })
  bootFiles(on, true)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  await $.tool.call({ tool: 'Write', tool_use_id: 'tu-w', file_path: `${ROOT}/hooks/register.tsx`, content: 'x' })
  const marked = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await marked.find({ type: 'Text', text: /^◆ $/ })).toBeDefined()
  await marked.unmount()

  await clock.advance(46_000)
  const later = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await later.find({ type: 'Text', text: /^◆ $/ })).toBeUndefined()
  expect(await later.find({ type: 'Text', text: /register\.tsx/ })).toBeDefined()
  await later.unmount()
})

test('FILES outside a repo lists the top level and says so', async ($, on) => {
  mock.clock(on, { now: NOW + 10_800_000 })
  bootFiles(on, false)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /not a git repo/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /notes\.txt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^src\s*$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /changed|clean/ })).toBeUndefined()
  await ui.unmount()
})
