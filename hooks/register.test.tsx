import { test, expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
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
  on('session.cwd', () => ({ value: '/Users/me/code/my-app' }))
  on('session.repo', () => ({ value: { root: '/Users/me/code/my-app', remote: null, internal: false, name: null } }))
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
    expect(await ui.find({ type: 'Text', text: /^my-app$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~\/code\/my-app/ })).toBeDefined()
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
  await $.tool.call({ tool: 'mcp__fleet__node_ask', tool_use_id: 'tu-2', node: 'node1', model: 'local-coder', prompt: 'x' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-3', command: 'echo hi | cfn fleet ask -m coder' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-4', command: 'ls -la' })
  const local = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await local.find({ type: 'Text', text: /⌂ node1/ })).toBeDefined()
  expect(await local.find({ type: 'Text', text: /^\s*local-coder$/ })).toBeDefined()
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
  expect(await modes.find({ type: 'Text', text: /^⌂ local-coder/ })).toBeDefined()
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

/** The props of the FILES `Client` in a mounted drawing: the kit exposes them, not what the module draws. */
async function filesProps(ui: { find: (m: any) => Promise<any> }): Promise<{ rows: any[]; now: number }> {
  const client = await ui.find({ type: 'Client' })
  expect(client?.props.module).toBe('hooks/rows.tsx')
  return client.props.props
}

/** The first segment of any row, either column, whose text matches. */
function segOf(p: { rows: any[] }, text: RegExp): any {
  return p.rows.flatMap(r => [...r.left, ...r.right]).find((g: any) => text.test(g.t))
}

const ROOT = '/Users/me/code/claude-sidebar'
const NUL = '\0'
const CLEAN_MTIME = Date.parse('2026-03-04T09:05:00Z')

/** A git answer by argv and the folder it runs in: the FILES fixture, the ELSEWHERE repo's, or a failure (null) for the gone repo. */
function gitAnswer(argv: readonly string[], cwd?: string): string | null {
  if (cwd === OTHER) return otherGitAnswer(argv)
  if (cwd === GONE) return null
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

/** ELSEWHERE fixtures: a repo outside the FILES root, a repo git cannot read, and a folder in no repo. */
const OTHER = '/Users/me/code/other'
const GONE = '/Users/me/code/gone'
const LOOSE = '/Users/me/loose'

/** The git answers of OTHER: branch dev two behind, one modified file, an untracked and an ignored folder, one unpushed file. */
function otherGitAnswer(argv: readonly string[]): string {
  const line = argv.slice(1).join(' ')
  if (line.startsWith('status')) return ['## dev...origin/dev [behind 2]', ' M src/app.ts', '?? notes/', '!! build/', ''].join(NUL)
  if (line === 'diff --numstat -z') return ['5\t2\tsrc/app.ts', ''].join(NUL)
  if (line.startsWith('diff --name-only')) return ['lib/util.ts', ''].join(NUL)
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
function bootFiles(on: Parameters<TestBody>[1], repo: boolean, fonts = false) {
  mock.store(on)
  on('session.usage', () => ({ value: usage() }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.cwd', () => ({ value: repo ? ROOT : '/Users/me/scratch' }))
  on('session.repo', () => ({ value: repo ? { root: ROOT, remote: null, internal: false, name: null } : null }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.read', () => ({ value: 'ref: refs/heads/main\n' }))
  on('fs.list', (_, e) => {
    if (e.path === '/Users/me/Library/Fonts') return { value: fonts ? [file('JetBrainsMono Nerd Font Regular.ttf')] : [file('Helvetica.ttf')] }
    if (e.path.toLowerCase().endsWith('fonts')) throw new Error('ENOENT')
    if (e.path === '/Users/me/scratch') return { value: [file('notes.txt', CLEAN_MTIME), dir('src')] }
    return { value: listRepo(e.path) }
  })
  on('process.run', (_, e) => {
    const out = gitAnswer(e.argv, e.init?.cwd)
    return { value: { exitCode: out === null ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
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
  const p = await filesProps(ui)
  // title row and branch row
  expect(await ui.find({ type: 'Text', text: /^FILES$/ })).toBeDefined()
  const titles = await ui.findAll({ type: 'Text', text: /^claude-sidebar$/ })
  expect(titles.map(t => t.props.color)).toContain('#5b9bd5')
  expect(await ui.find({ type: 'Text', text: /^⎇ $/ })).toBeDefined()
  const branches = await ui.findAll({ type: 'Text', text: /^main$/ })
  expect(branches.map(t => t.props.bold)).toContain(true)
  expect(await ui.find({ type: 'Text', text: /^ ↑1$/ })).toBeDefined()
  const unpushed = segOf(p, /^ ↑$/)
  expect(unpushed).toBeDefined()
  expect(unpushed?.c).toBe('#61afef')
  const upstream = await ui.find({ type: 'Text', text: /^ origin\/main$/ })
  expect(upstream?.props.color).toBe('#808a96')
  expect(await ui.find({ type: 'Text', text: /^ N:1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ D:1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /changed/ })).toBeUndefined()
  // plain glyphs: open folders, a folder square, a file dot
  expect(segOf(p, /▾ $/)).toBeDefined()
  expect(segOf(p, /▸ $/)).toBeDefined()
  expect(segOf(p, /^■ $/)).toBeDefined()
  expect(segOf(p, /^· $/)).toBeDefined()
  // register.tsx: lines and a bold amber M
  expect(segOf(p, /^register\.tsx$/)).toBeDefined()
  expect(segOf(p, /^ \+41$/)).toBeDefined()
  const del = segOf(p, /^ -3$/)
  expect(del?.c).toBe('#e06c75')
  const badge = segOf(p, /^ M$/)
  expect(badge?.b).toBe(true)
  expect(badge?.c).toBe('#e5c07b')
  expect(segOf(p, /^ A$/)).toBeDefined()
  // the hooks folder row rolls up its lines and counts
  expect(segOf(p, /^ \+129$/)).toBeDefined()
  expect(segOf(p, /^ M:1$/)).toBeDefined()
  // a clean file shows its timestamp
  const clean = segOf(p, new RegExp(`^ ${stampOf(CLEAN_MTIME)}$`))
  expect(clean?.c).toBe('#808a96')
  expect(segOf(p, /index\.d\.ts/)).toBeDefined()
  // a deleted file is struck through and red
  const gone = segOf(p, /^old\.d\.ts$/)
  expect(gone?.s).toBe(true)
  expect(gone?.c).toBe('#d0605e')
  // docs holds only a clean file: one collapsed row, its file out of sight
  expect(segOf(p, /^docs$/)).toBeDefined()
  expect(segOf(p, /FEEDBACK\.md/)).toBeUndefined()
  // .git is a muted folder; the ignored folder is muted with the ignored badge
  const dotGit = segOf(p, /^\.git$/)
  expect(dotGit?.c).toBe('#808a96')
  const ignored = segOf(p, /^node_modules$/)
  expect(ignored?.c).toBe('#808a96')
  expect(segOf(p, /^ ⊘$/)).toBeDefined()
  // the old fills and marks are gone
  expect(await ui.find({ type: 'Text', text: /◆|◇/ })).toBeUndefined()
  await ui.unmount()
})

test('FILES draws Nerd Font glyphs when a Nerd Font is installed', async ($, on) => {
  mock.clock(on, { now: NOW + 3_600_000 })
  bootFiles(on, true, true)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  const p = await filesProps(ui)
  expect(await ui.find({ type: 'Text', text: new RegExp(`^${String.fromCodePoint(0xe0a0)} $`) })).toBeDefined()
  expect(segOf(p, new RegExp(`${String.fromCodePoint(0xf47c)} $`))).toBeDefined()
  expect(segOf(p, new RegExp(`${String.fromCodePoint(0xf460)} $`))).toBeDefined()
  // an open folder, a collapsed one, and a .tsx file by extension
  expect(segOf(p, new RegExp(`^${String.fromCodePoint(0xe5fe)} $`))).toBeDefined()
  expect(segOf(p, new RegExp(`^${String.fromCodePoint(0xe5ff)} $`))).toBeDefined()
  expect(segOf(p, new RegExp(`^${String.fromCodePoint(0xe7ba)} $`))).toBeDefined()
  expect(segOf(p, new RegExp(`^${String.fromCodePoint(0xf0354)} $`))).toBeDefined()
  expect(segOf(p, new RegExp(`^ ${String.fromCodePoint(0xf05e)}$`))).toBeDefined()
  expect(segOf(p, /^■ $|^· $/)).toBeUndefined()
  await ui.unmount()
})

test('FILES lights a written file for 45 s and then drops the sweep', async ($, on) => {
  const clock = mock.clock(on, { now: NOW + 7_200_000 })
  bootFiles(on, true)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  await $.tool.call({ tool: 'Write', tool_use_id: 'tu-w', file_path: `${ROOT}/hooks/register.tsx`, content: 'x' })
  const writtenAt = NOW + 7_200_000
  const marked = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  const lit = await filesProps(marked)
  expect(lit.now).toBe(writtenAt)
  const row = lit.rows.find((r: any) => r.id === 'hooks/register.tsx')
  const name = row.left.find((g: any) => g.t === 'register.tsx')
  expect(name).toMatchObject({ c: '#f97316', sh: 'write', at: writtenAt })
  expect(row.left.find((g: any) => g.one)).toMatchObject({ sh: 'write', at: writtenAt })
  // the right column is plain: no sweep
  expect(row.right.some((g: any) => g.sh)).toBe(false)
  // only the written file is lit
  expect(lit.rows.filter((r: any) => [...r.left, ...r.right].some((g: any) => g.sh)).length).toBe(1)
  expect(segOf(lit, /◆/)).toBeUndefined()
  await marked.unmount()

  await clock.advance(46_000)
  const later = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  const idle = await filesProps(later)
  const gone = idle.rows.find((r: any) => r.id === 'hooks/register.tsx')
  // back to its git colour: amber for a modified file, and nothing sweeps
  expect(gone.left.find((g: any) => g.t === 'register.tsx')).toEqual({ t: 'register.tsx', c: '#e5c07b' })
  expect(JSON.stringify(idle.rows)).not.toContain('"sh"')
  await later.unmount()
})

test('FILES lights a read file purple', async ($, on) => {
  mock.clock(on, { now: NOW + 7_200_000 })
  bootFiles(on, true)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  await $.tool.call({ tool: 'Read', tool_use_id: 'tu-r', file_path: `${ROOT}/README.md` })
  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  const p = await filesProps(ui)
  expect(segOf(p, /^README\.md$/)).toMatchObject({ c: '#c084fc', sh: 'read', at: NOW + 7_200_000 })
  await ui.unmount()
})

test('FILES outside a repo lists the top level and says so', async ($, on) => {
  mock.clock(on, { now: NOW + 10_800_000 })
  bootFiles(on, false)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  const p = await filesProps(ui)
  expect(await ui.find({ type: 'Text', text: /^scratch$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /not a git repo/ })).toBeDefined()
  expect(segOf(p, /^notes\.txt$/)).toBeDefined()
  expect(segOf(p, /^src$/)).toBeDefined()
  expect(segOf(p, new RegExp(`^ ${stampOf(CLEAN_MTIME)}$`))).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /clean|N:|M:|D:/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^⎇ $/ })).toBeUndefined()
  await ui.unmount()
})

/** The ids of the FILES rows whose name is lit, with the kind of the mark. */
function litRows(p: { rows: any[] }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of p.rows) {
    const name = r.left.find((g: any) => g.sh && !g.one)
    if (name) out[r.id] = name.sh
  }
  return out
}

const SHELL_REAL = ['README.md', 'docs', 'hooks', 'hooks/register.tsx']

/** Boots a repo session where only the `real` repo-relative paths exist; returns the paths `fs.exists` was asked about. */
async function bootShell($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], real: string[]) {
  mock.clock(on, { now: NOW + 7_200_000 })
  bootFiles(on, true)
  const asked: string[] = []
  on('fs.exists', (_, e) => {
    asked.push(e.path)
    return { value: real.some(r => e.path === `${ROOT}/${r}`) }
  })
  await $.command.run({ command: 'sidebar', args: '', ...RUN })
  return asked
}

test('FILES marks files and folders that shell readers name as read', async ($, on) => {
  const asked = await bootShell($, on, SHELL_REAL)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b1', command: 'cat README.md' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b2', command: "sed -n '1,40p' hooks/register.tsx" })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b3', command: 'grep -n "foo" hooks/register.tsx docs' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b4', command: "rg --glob '*.ts' pattern hooks" })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b5', command: 'head -n 20 README.md | tail -5' })

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  const p = await filesProps(ui)
  expect(litRows(p)).toEqual({ 'README.md': 'read', docs: 'read', hooks: 'read', 'hooks/register.tsx': 'read' })
  // a folder row takes the read colour on its icon and name
  const docs = p.rows.find((r: any) => r.id === 'docs')
  expect(docs.left.find((g: any) => g.t === 'docs')).toMatchObject({ c: '#c084fc', sh: 'read' })
  expect(docs.left.find((g: any) => g.one)).toMatchObject({ c: '#c084fc', sh: 'read' })
  // the sed script, grep pattern and rg pattern are candidates that fail the exists check, so none becomes a mark
  expect(asked).toContain(`${ROOT}/1,40p`)
  expect(asked).toContain(`${ROOT}/foo`)
  expect(asked).toContain(`${ROOT}/pattern`)
  expect(Object.keys(litRows(p)).some(id => /1,40p|foo|pattern/.test(id))).toBe(false)
  // the glob and the -n values are dropped before any lookup
  expect(asked.some(a => a.includes('*') || a.endsWith('/20') || a.endsWith('/-5') || a.endsWith('/5'))).toBe(false)
  await ui.unmount()
})

test('FILES never lights a reader candidate that does not exist, even a sed script', async ($, on) => {
  await bootShell($, on, [])
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b6', command: "sed -n '1,40p' hooks/register.tsx" })
  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(litRows(await filesProps(ui))).toEqual({})
  await ui.unmount()
})

test('FILES follows a cd inside the command when resolving shell reads', async ($, on) => {
  // `cd hooks && cat register.tsx` names hooks/register.tsx; an absolute cd to the root resolves the same way.
  await bootShell($, on, SHELL_REAL)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b7', command: 'cd hooks && cat register.tsx' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b8', command: `cd ${ROOT} && head -n 3 README.md` })
  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(litRows(await filesProps(ui))).toEqual({ 'README.md': 'read', 'hooks/register.tsx': 'read' })
  await ui.unmount()
})

test('FILES ignores shell writes and paths outside the repo', async ($, on) => {
  const asked = await bootShell($, on, SHELL_REAL)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b8', command: 'echo x > README.md' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-b9', command: 'cat /etc/hosts ../outside.txt 2>&1 > hooks/register.tsx' })
  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(litRows(await filesProps(ui))).toEqual({})
  // the outside reads are looked up for ELSEWHERE, and neither exists, so nothing is recorded
  expect(asked).toEqual(['/etc/hosts', '/Users/me/code/outside.txt'])
  expect(await ui.find({ type: 'Text', text: /^ELSEWHERE$/ })).toBeUndefined()
  await ui.unmount()
})

/** The rows of every ELSEWHERE `Client` (each after the FILES one), by row id. */
async function elsewhereRows(ui: { findAll: (m: any) => Promise<any[]> }): Promise<Record<string, any>> {
  const clients = await ui.findAll({ type: 'Client' })
  const out: Record<string, any> = {}
  for (const c of clients.slice(1)) for (const r of c.props.props.rows) out[r.id] = r
  return out
}

/** Boots a repo session that also knows OTHER and GONE as repos (each has a `.git`), and `src` and `lib` of OTHER as folders. */
async function bootElsewhere($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  const clock = mock.clock(on, { now: NOW + 7_200_000 })
  bootFiles(on, true)
  const folders = [`${OTHER}/src`, `${OTHER}/lib`]
  on('fs.exists', (_, e) => ({ value: e.path === `${OTHER}/.git` || e.path === `${GONE}/.git` || folders.includes(e.path) || e.path === `${OTHER}/lib/util.ts` }))
  on('fs.stat', (_, e) => ({ value: { kind: folders.includes(e.path) ? ('dir' as const) : ('file' as const), size: 1, mtimeMs: 0, isLink: false } }))
  await $.command.run({ command: 'sidebar', args: '', ...RUN })
  return clock
}

test('ELSEWHERE files outside reads and writes under their repo with git badges; inside ones stay in FILES', async ($, on) => {
  const clock = await bootElsewhere($, on)
  const before = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await before.find({ type: 'Text', text: /^ELSEWHERE$/ })).toBeUndefined()
  expect((await before.findAll({ type: 'Client' })).length).toBe(1)
  await before.unmount()

  await $.tool.call({ tool: 'Read', tool_use_id: 'tu-o1', file_path: `${OTHER}/src/app.ts` })
  await $.tool.call({ tool: 'Write', tool_use_id: 'tu-o2', file_path: `${OTHER}/notes/todo.md`, content: 'x' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'tu-o3', file_path: `${OTHER}/build/out.js` })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-o4', command: 'cat ~/code/other/lib/util.ts && ls ~/code/other/src' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'tu-o5', file_path: `${GONE}/a.txt`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'tu-o6', file_path: `${LOOSE}/x.txt` })
  await $.tool.call({ tool: 'Read', tool_use_id: 'tu-o7', file_path: `${ROOT}/README.md` })

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  // one header per group: the section word, the folder name in the accent colour
  expect((await ui.findAll({ type: 'Text', text: /^ELSEWHERE$/ })).length).toBe(3)
  for (const name of ['other', 'gone', 'loose']) {
    const title = await ui.find({ type: 'Text', text: new RegExp(`^${name}$`) })
    expect(title?.props.color).toBe('#5b9bd5')
  }
  expect((await ui.findAll({ type: 'Text', text: /not a git repo/ })).length).toBe(1)
  // OTHER's branch row: branch, behind, upstream, then the whole repo's totals
  expect((await ui.find({ type: 'Text', text: /^dev$/ }))?.props.bold).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^ ↓2$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ origin\/dev$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ \+5$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ M:1$/ })).toBeDefined()
  // two branch rows in all: FILES's and OTHER's; the unreadable repo draws none
  expect((await ui.findAll({ type: 'Text', text: /^⎇ $/ })).length).toBe(2)

  const rows = await elsewhereRows(ui)
  expect(Object.keys(rows).sort()).toEqual(
    [`${GONE}/a.txt`, `${LOOSE}/x.txt`, `${OTHER}/build/out.js`, `${OTHER}/lib/util.ts`, `${OTHER}/notes/todo.md`, `${OTHER}/src`, `${OTHER}/src/app.ts`].sort(),
  )
  const right = (id: string) => rows[id].right.map((g: any) => g.t).join('')
  const name = (id: string, t: string) => rows[id].left.find((g: any) => g.t === t)
  // paths relative to the group, lit like FILES: purple read, orange write
  expect(name(`${OTHER}/src/app.ts`, 'src/app.ts')).toMatchObject({ c: '#c084fc', sh: 'read' })
  expect(right(`${OTHER}/src/app.ts`)).toBe(' +5 -2 M')
  expect(name(`${OTHER}/notes/todo.md`, 'notes/todo.md')).toMatchObject({ c: '#f97316', sh: 'write' })
  expect(right(`${OTHER}/notes/todo.md`)).toBe(' ?')
  expect(right(`${OTHER}/build/out.js`)).toBe(' ⊘')
  expect(right(`${OTHER}/lib/util.ts`)).toBe(' ↑')
  // a folder a shell reader named: collapsed, with its own totals
  expect(rows[`${OTHER}/src`].left[0].t).toBe('▸ ')
  expect(right(`${OTHER}/src`)).toBe(' +5 -2 M:1')
  // no badge where git cannot read the repo, nor outside any repo
  expect(right(`${GONE}/a.txt`)).toBe('  ')
  expect(right(`${LOOSE}/x.txt`)).toBe('  ')
  // the inside read stays in FILES alone
  expect(rows[`${ROOT}/README.md`]).toBeUndefined()
  expect(litRows(await filesProps(ui))).toEqual({ 'README.md': 'read' })
  await ui.unmount()

  // after 45 s the colour is gone and the rows stay, badges and all
  await clock.advance(46_000)
  const later = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  const kept = await elsewhereRows(later)
  expect(Object.keys(kept).length).toBe(7)
  expect(JSON.stringify(kept)).not.toContain('"sh"')
  expect(kept[`${OTHER}/src/app.ts`].left.find((g: any) => g.t === 'src/app.ts')).toEqual({ t: 'src/app.ts', c: '#e5c07b' })
  await later.unmount()
})

test('ELSEWHERE draws at most 20 rows, then a more line', async ($, on) => {
  await bootElsewhere($, on)
  for (let i = 0; i < 25; i += 1) {
    await $.tool.call({ tool: 'Read', tool_use_id: `tu-c${i}`, file_path: `${LOOSE}/f${String(i).padStart(2, '0')}.txt` })
  }
  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  const rows = await elsewhereRows(ui)
  expect(Object.keys(rows).length).toBe(20)
  expect(rows[`${LOOSE}/f00.txt`]).toBeDefined()
  expect(rows[`${LOOSE}/f24.txt`]).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /… 5 more/ })).toBeDefined()
  await ui.unmount()
})

const USAGE_TEXT = `You are currently using your subscription to power your Claude Code usage

Current session: 56% used · resets Oct 13 at 12pm (America/Denver)
Current week (all models): 41% used · resets Oct 13 at 5pm (America/Denver)
Current week (Fable): 77% used · resets Oct 13 at 5pm (America/Denver)

What's contributing to your limits usage?
`

/** The mocks a USAGE test needs; `usageReply` is what `claude -p /usage` answers, and `ran` counts its runs. */
function bootUsage(on: Parameters<TestBody>[1], usageReply: { current: { exitCode: number; stdout: string } | 'throw' }) {
  const ran = { count: 0, argv: [] as string[] }
  mock.store(on)
  on('session.usage', () => ({ value: usage() }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.cwd', () => ({ value: '/Users/me/code/my-app' }))
  on('session.repo', () => ({ value: null }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.read', () => ({ value: '' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'claude') {
      ran.count += 1
      ran.argv = [...e.argv]
      const reply = usageReply.current
      if (reply === 'throw') throw new Error('spawn claude ENOENT')
      return { value: { exitCode: reply.exitCode, stdout: reply.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 128, stdout: '', stderr: 'not mocked', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  return ran
}

test('USAGE adds a per-model weekly row from claude -p /usage, and drops it when the command fails', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const reply: Parameters<typeof bootUsage>[1] = { current: { exitCode: 0, stdout: USAGE_TEXT } }
  const ran = bootUsage(on, reply)

  await $.command.run({ command: 'sidebar', args: '', ...RUN })
  await clock.advance(1)
  expect(ran.argv).toEqual(['claude', '-p', '/usage', '--no-session-persistence', '--strict-mcp-config'])
  expect(ran.count).toBe(1)

  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^Fable $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s*77%$/ })).toBeDefined()
  // 2026-10-13 5pm in Denver (UTC-6) is 23:00Z, six and a half days after NOW
  expect(await ui.find({ type: 'Text', text: /resets in 6d/ })).toBeDefined()
  // the all-models line and the session line are not rows of their own
  expect(await ui.find({ type: 'Text', text: /41%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /56%/ })).toBeUndefined()
  // the label column widens to the longest label: 5h and 7d pad to five cells
  expect(await ui.find({ type: 'Text', text: /^5h    $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^7d    $/ })).toBeDefined()
  // the row follows 7d, before nothing else here, and every row keeps one line (same bar width)
  const labels = (await ui.findAll({ type: 'Text', text: /^(5h|7d|Fable) +$/ })).map(t => t.text.trim())
  expect(labels).toEqual(['5h', '7d', 'Fable'])
  const bars = await ui.findAll({ type: 'Text', text: /^[█░]+$/ })
  const barLen = (t: { text: string }) => t.text.length
  // 5h, 7d and Fable each draw a filled run and an empty run summing to one bar width
  const widthsOfBars = [bars.slice(-6, -4), bars.slice(-4, -2), bars.slice(-2)].map(pair => pair.reduce((n, t) => n + barLen(t), 0))
  expect(new Set(widthsOfBars).size).toBe(1)
  await ui.unmount()

  // The poll repeats every five minutes, not every minute; a failure removes the row at once.
  reply.current = { exitCode: 1, stdout: USAGE_TEXT }
  await clock.advance(4 * 60_000)
  expect(ran.count).toBe(1)
  await clock.advance(61_000)
  expect(ran.count).toBe(2)
  const failed = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await failed.find({ type: 'Text', text: /Fable/ })).toBeUndefined()
  expect(await failed.find({ type: 'Text', text: /5h/ })).toBeDefined()
  await failed.unmount()

  // It comes back when the command does, and the burn rate reads the row over the real time between polls:
  // 77% at the first poll, 80% ten minutes later is 0.3 points a minute, so 20 points left is ~67 minutes.
  reply.current = { exitCode: 0, stdout: USAGE_TEXT.replace('77%', '80%') }
  await clock.advance(5 * 60_000)
  await clock.advance(1)
  const back = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await back.find({ type: 'Text', text: /^Fable $/ })).toBeDefined()
  expect(await back.find({ type: 'Text', text: /^\s*80%$/ })).toBeDefined()
  expect(await back.find({ type: 'Text', text: /full in ~1h07/ })).toBeDefined()
  await back.unmount()
})

test('USAGE shows no model row when the command cannot run or prints no per-model line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const reply: Parameters<typeof bootUsage>[1] = { current: 'throw' }
  const ran = bootUsage(on, reply)
  await $.command.run({ command: 'sidebar', args: '', ...RUN })
  await clock.advance(1)
  expect(ran.count).toBe(1)
  const spawnFailed = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await spawnFailed.find({ type: 'Text', text: /5h/ })).toBeDefined()
  expect(await spawnFailed.find({ type: 'Text', text: /Fable/ })).toBeUndefined()
  await spawnFailed.unmount()

  // Exit 0 with only the session and all-models lines: nothing to show, and the plain 2-cell labels stay.
  reply.current = { exitCode: 0, stdout: 'Current session: 56% used · resets Oct 13 at 12pm (America/Denver)\nCurrent week (all models): 41% used · resets Oct 13 at 5pm (America/Denver)\n' }
  await $.command.run({ command: 'sidebar', args: 'off', ...RUN })
  await $.command.run({ command: 'sidebar', args: 'on', ...RUN })
  await clock.advance(1)
  expect(ran.count).toBe(2)
  const none = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  expect(await none.find({ type: 'Text', text: /^5h $/ })).toBeDefined()
  expect(await none.find({ type: 'Text', text: /41%/ })).toBeUndefined()
  await none.unmount()
})

/** The reset text the panel draws for a model line whose `<when>` is `when`, at clock `now`; undefined when it draws none. */
async function resetDrawn($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], now: number, when: string): Promise<string | undefined> {
  const clock = mock.clock(on, { now })
  bootUsage(on, { current: { exitCode: 0, stdout: `Current week (Fable): 12.5% used · resets ${when}\n` } })
  await $.command.run({ command: 'sidebar', args: '', ...RUN })
  await clock.advance(1)
  const ui = await $.ui.mount({ plugin: 'sidebar', surface: 'terminal', ...PANE })
  // The row is drawn whatever the reset text says; the engine's two windows draw the first two countdowns.
  expect(await ui.find({ type: 'Text', text: /12\.5%/ })).toBeDefined()
  const texts = (await ui.findAll({ type: 'Text', text: /resets in|reset due/ })).map(t => t.text.trim())
  await ui.unmount()
  return texts[2]
}

/** Month name, day and 12-hour clock text of the machine-local wall time at `ms`, as `/usage` would print it. */
function localWhen(ms: number): string {
  const at = new Date(ms)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][at.getMonth()]
  const h = at.getHours()
  return `${mon} ${at.getDate()} at ${h % 12 === 0 ? 12 : h % 12}:${String(at.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
}

test('USAGE reads a model reset time with minutes in its named zone', async ($, on) => {
  // Oct 7 7:30am in Denver (UTC-6) is 13:30Z, 90 minutes after NOW.
  expect(await resetDrawn($, on, NOW, 'Oct 7 at 7:30am (America/Denver)')).toBe('resets in 1h 30m')
})

test('USAGE reads Oct 13 at 5pm (America/Denver) as 23:00Z', async ($, on) => {
  expect(await resetDrawn($, on, NOW, 'Oct 13 at 5pm (America/Denver)')).toBe('resets in 6d')
})

test('USAGE reads 5pm in its zone as 23:00Z the same day', async ($, on) => {
  expect(await resetDrawn($, on, NOW, 'Oct 7 at 5pm (America/Denver)')).toBe('resets in 11h 0m')
})

test('USAGE reads 12pm as noon', async ($, on) => {
  // 12pm Denver is 18:00Z, six hours after NOW.
  expect(await resetDrawn($, on, NOW, 'Oct 7 at 12pm (America/Denver)')).toBe('resets in 6h 0m')
})

test('USAGE reads 12am as midnight', async ($, on) => {
  // 12am Oct 8 Denver is 06:00Z, eighteen hours after NOW.
  expect(await resetDrawn($, on, NOW, 'Oct 8 at 12am (America/Denver)')).toBe('resets in 18h 0m')
})

test('USAGE reads Oct 13 at 5:30pm with no zone in the machine zone', async ($, on) => {
  // The machine zone is whatever it is: the text names the local wall time 90 minutes after NOW.
  expect(await resetDrawn($, on, NOW, localWhen(NOW + 90 * 60_000))).toBe('resets in 1h 30m')
})

test('USAGE picks the next year for a month already past', async ($, on) => {
  // Dec 30 12:00Z: "Jan 2 at 9am" Denver is Jan 2 16:00Z of the next year, 3 days 4 hours on.
  expect(await resetDrawn($, on, Date.parse('2026-12-30T12:00:00Z'), 'Jan 2 at 9am (America/Denver)')).toBe('resets in 3d')
})

test('USAGE keeps the row without a countdown when the reset text is unreadable', async ($, on) => {
  expect(await resetDrawn($, on, NOW, 'sometime next week')).toBeUndefined()
})

test('USAGE keeps the row without a countdown when the zone is unknown', async ($, on) => {
  expect(await resetDrawn($, on, NOW, 'Oct 13 at 5pm (Nowhere/Land)')).toBeUndefined()
})
