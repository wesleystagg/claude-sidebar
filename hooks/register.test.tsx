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
    bodyColumns: 60,
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
    expect(bar.reduce((sum, t) => sum + t.text.length, 0)).toBe(60)
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
const CLEAN_MTIME = Date.parse('2026-03-04T09:05:00Z')

/** A git answer by argv: the status, the tracked list, both numstats and the unpushed set of the FILES fixture. */
function gitAnswer(argv: readonly string[]): string {
  const line = argv.slice(1).join(' ')
  if (line.startsWith('status')) {
    return [
      '## main...origin/main [ahead 1]',
      ' M hooks/register.tsx',
      'A  hooks/register.test.tsx',
      ' M README.md',
      ' D types/old.d.ts',
      '!! node_modules/',
      '',
    ].join(NUL)
  }
  if (line === 'ls-files -z') {
    return ['README.md', 'docs/FEEDBACK.md', 'hooks/register.test.tsx', 'hooks/register.tsx', 'types/index.d.ts', 'types/old.d.ts', ''].join(NUL)
  }
  if (line === 'diff --numstat -z') return ['41\t3\thooks/register.tsx', '6\t1\tREADME.md', ''].join(NUL)
  if (line === 'diff --numstat --cached -z') return ['88\t0\thooks/register.test.tsx', ''].join(NUL)
  if (line.startsWith('diff --name-only')) return ['types/index.d.ts', ''].join(NUL)
  return ''
}

const file = (name: string, mtimeMs = 0) => ({ name, kind: 'file' as const, size: 10, mtimeMs, isLink: false })
const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })

/** The repo's folders on disk: the root, plus the two expanded folders, with dot entries. */
function listRepo(path: string) {
  if (path === ROOT) return [file('README.md', CLEAN_MTIME), dir('.git'), dir('docs'), dir('hooks'), dir('node_modules'), dir('types')]
  if (path === `${ROOT}/hooks`) return [file('register.test.tsx', CLEAN_MTIME), file('register.tsx', CLEAN_MTIME)]
  if (path === `${ROOT}/types`) return [file('index.d.ts', CLEAN_MTIME)]
  return []
}

/** The mocks every FILES test needs, with git answering from the fixture; `fonts` puts a Nerd Font in the user's font folder. */
function bootFiles(on: Parameters<Parameters<typeof test>[1]>[1], repo: boolean, fonts = false) {
  mock.store(on)
  on('session.usage', () => ({ value: usage() }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.cwd', () => ({ value: repo ? ROOT : '/Users/wesley/scratch' }))
  on('session.repo', () => ({ value: repo ? { root: ROOT, remote: null, internal: false, name: null } : null }))
  on('env.get', () => ({ value: '/Users/wesley' }))
  on('fs.read', () => ({ value: 'ref: refs/heads/main\n' }))
  on('fs.list', (_, e) => {
    if (e.path === '/Users/wesley/Library/Fonts') return { value: fonts ? [file('JetBrainsMono Nerd Font Regular.ttf')] : [file('Helvetica.ttf')] }
    if (e.path.toLowerCase().endsWith('fonts')) throw new Error('ENOENT')
    if (e.path === '/Users/wesley/scratch') return { value: [file('notes.txt', CLEAN_MTIME), dir('src')] }
    return { value: listRepo(e.path) }
  })
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: gitAnswer(e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '' } }))
}

/** The local-time stamp the panel draws for `CLEAN_MTIME`. */
function stampOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

test('FILES draws the header, the tree with plain glyphs, badges, counts and times', async ($, on) => {
  mock.clock(on, { now: NOW + 3_600_000 })
  bootFiles(on, true)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  // title row and branch row
  expect(await ui.find({ type: 'Text', text: /^FILES$/ })).toBeDefined()
  const titles = await ui.findAll({ type: 'Text', text: /^claude-sidebar$/ })
  expect(titles.map(t => t.props.color)).toContain('#5b9bd5')
  expect(await ui.find({ type: 'Text', text: /^⎇ $/ })).toBeDefined()
  const branches = await ui.findAll({ type: 'Text', text: /^main$/ })
  expect(branches.map(t => t.props.bold)).toContain(true)
  expect(await ui.find({ type: 'Text', text: /^ ↑1$/ })).toBeDefined()
  const unpushed = await ui.find({ type: 'Text', text: /^ ↑$/ })
  expect(unpushed).toBeDefined()
  expect(unpushed?.props.color).toBe('#61afef')
  const upstream = await ui.find({ type: 'Text', text: /^ origin\/main$/ })
  expect(upstream?.props.color).toBe('#808a96')
  expect(await ui.find({ type: 'Text', text: /^ N:1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ D:1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /changed/ })).toBeUndefined()
  // plain glyphs: open folders, a folder square, a file dot
  expect(await ui.find({ type: 'Text', text: /^▾ $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▸ $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^■ $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^· $/ })).toBeDefined()
  // register.tsx: lines and a bold amber M
  expect(await ui.find({ type: 'Text', text: /^register\.tsx$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ \+41$/ })).toBeDefined()
  const del = await ui.find({ type: 'Text', text: /^ -3$/ })
  expect(del?.props.color).toBe('#e06c75')
  const badge = await ui.find({ type: 'Text', text: /^ M$/ })
  expect(badge?.props.bold).toBe(true)
  expect(badge?.props.color).toBe('#e5c07b')
  expect(await ui.find({ type: 'Text', text: /^ A$/ })).toBeDefined()
  // the hooks folder row rolls up its lines and counts
  expect(await ui.find({ type: 'Text', text: /^ \+129$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ M:1$/ })).toBeDefined()
  // a clean file shows its timestamp
  const clean = await ui.find({ type: 'Text', text: new RegExp(`^ ${stampOf(CLEAN_MTIME)}$`) })
  expect(clean?.props.color).toBe('#808a96')
  expect(await ui.find({ type: 'Text', text: /index\.d\.ts/ })).toBeDefined()
  // a deleted file is struck through and red
  const gone = await ui.find({ type: 'Text', text: /^old\.d\.ts$/ })
  expect(gone?.props.strikethrough).toBe(true)
  expect(gone?.props.color).toBe('#d0605e')
  // docs holds only a clean file: one collapsed row, its file out of sight
  expect(await ui.find({ type: 'Text', text: /^docs$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /FEEDBACK\.md/ })).toBeUndefined()
  // .git is a muted folder; the ignored folder is muted with the ignored badge
  const dotGit = await ui.find({ type: 'Text', text: /^\.git$/ })
  expect(dotGit?.props.color).toBe('#808a96')
  const ignored = await ui.find({ type: 'Text', text: /^node_modules$/ })
  expect(ignored?.props.color).toBe('#808a96')
  expect(await ui.find({ type: 'Text', text: /^ ⊘$/ })).toBeDefined()
  // the old fills and marks are gone
  expect(await ui.find({ type: 'Text', text: /◆|◇/ })).toBeUndefined()
  await ui.unmount()
})

test('FILES draws Nerd Font glyphs when a Nerd Font is installed', async ($, on) => {
  mock.clock(on, { now: NOW + 3_600_000 })
  bootFiles(on, true, true)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: new RegExp(`^${String.fromCodePoint(0xe0a0)} $`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^${String.fromCodePoint(0xf47c)} $`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^${String.fromCodePoint(0xf460)} $`) })).toBeDefined()
  // an open folder, a collapsed one, and a .tsx file by extension
  expect(await ui.find({ type: 'Text', text: new RegExp(`^${String.fromCodePoint(0xe5fe)} $`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^${String.fromCodePoint(0xe5ff)} $`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^${String.fromCodePoint(0xe7ba)} $`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^${String.fromCodePoint(0xf0354)} $`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^ ${String.fromCodePoint(0xf05e)}$`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^■ $|^· $/ })).toBeUndefined()
  await ui.unmount()
})

test('FILES colours a written file while the tool runs and drops the colour after 45 s', async ($, on) => {
  const clock = mock.clock(on, { now: NOW + 7_200_000 })
  bootFiles(on, true)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  await $.tool.call({ tool: 'Write', tool_use_id: 'tu-w', file_path: `${ROOT}/hooks/register.tsx`, content: 'x' })
  const marked = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect((await marked.find({ type: 'Text', text: /^register\.tsx$/ }))?.props.color).toBe('#f97316')
  expect(await marked.find({ type: 'Text', text: /◆/ })).toBeUndefined()
  await marked.unmount()

  await clock.advance(46_000)
  const later = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  // back to its git colour: amber for a modified file
  expect((await later.find({ type: 'Text', text: /^register\.tsx$/ }))?.props.color).toBe('#e5c07b')
  await later.unmount()
})

test('FILES outside a repo lists the top level and says so', async ($, on) => {
  mock.clock(on, { now: NOW + 10_800_000 })
  bootFiles(on, false)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^scratch$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /not a git repo/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^notes\.txt$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^src$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^ ${stampOf(CLEAN_MTIME)}$`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /clean|N:|M:|D:/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^⎇ $/ })).toBeUndefined()
  await ui.unmount()
})
