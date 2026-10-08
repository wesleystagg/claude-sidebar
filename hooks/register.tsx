import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, Timer } from 'claude-code'

import type { AgentRow, Compactions, ModelTally, Place, Sample, Segment, Snapshot, Window } from '../types'

const STORE_KEY = 'enabled'
const COMMAND = 'sidebar'
const PANE = 'sidebar'
const WANT_COLUMNS = 36
const TICK_MS = 60_000
const MAX_AGENT_ROWS = 12
/** A finished run's row fades this long after it ended; running rows always stay. */
const FADE_MS = 2 * 60_000
/** Cells of the small per-agent context bar, scaled to the session model's window. */
const CTX_BAR = 10
/** Minutes of rate-limit samples kept for the burn rate, and the least span it is read over. */
const SAMPLE_KEEP = 30
const SAMPLE_MIN_SPAN_MS = 3 * 60_000

const enabled = atom({ plugin: 'sidebar', key: 'enabled' } as const, false)
const snapshot = atom({ plugin: 'sidebar', key: 'snapshot' } as const, null)
const model = atom({ plugin: 'sidebar', key: 'model' } as const, null)
const agents = atom({ plugin: 'sidebar', key: 'agents' } as const, [])
const burned = atom({ plugin: 'sidebar', key: 'burned' } as const, 0)
const samples = atom({ plugin: 'sidebar', key: 'samples' } as const, [])
const compactions = atom({ plugin: 'sidebar', key: 'compactions' } as const, { count: 0 })
const effort = atom({ plugin: 'sidebar', key: 'effort' } as const, null)
const mode = atom({ plugin: 'sidebar', key: 'mode' } as const, null)
const place = atom({ plugin: 'sidebar', key: 'place' } as const, null)
const byModel = atom({ plugin: 'sidebar', key: 'byModel' } as const, {})

const GLYPH: Record<Segment['kind'], string> = { used: '█', buffer: '▒', free: '░', deferred: '' }
const MARK: Record<Segment['kind'], string> = { used: '■', buffer: '▒', free: '░', deferred: '' }

/** One theme color per rate-limit window, so the rows tell apart at a glance. */
const WINDOW_COLOR: Record<string, string> = { five_hour: 'claude', seven_day: 'permission', spend_limit: 'warning' }
const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$ ' }

/** One theme color per run status. */
const STATUS_COLOR: Record<AgentRow['status'], string> = { running: 'warning', done: 'success', failed: 'error' }
const STATUS_MARK: Record<AgentRow['status'], string> = { running: '●', done: '✓', failed: '✗' }

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

function fmtPct(p: number): string {
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`
}

function fmtReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const mins = Math.round((at - now) / 60_000)
  if (mins <= 0) return 'reset due'
  if (mins < 60) return `resets in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `resets in ${hours}h ${mins % 60}m`
  return `resets in ${Math.round(hours / 24)}d`
}

function fmtBig(n: number): string {
  if (n < 1_000_000) return fmtTokens(n)
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${(s % 60).toString().padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${(m % 60).toString().padStart(2, '0')}m`
}

/** `claude-sonnet-5-5` reads as `sonnet-5-5`; a local tag or alias is left as it is. */
function shortModel(id: string): string {
  return id.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** The theme color of a model's tier: frontier orange, Sonnet blue, Haiku green, a local model in the IDE color. */
function tierColor(id: string, local: boolean): string {
  if (local) return 'ide'
  if (isFrontier(id)) return 'claude'
  if (/sonnet/i.test(id)) return 'permission'
  if (/haiku/i.test(id)) return 'success'
  return 'text'
}

async function tally($: EngineInterface, id: string, tokens: number, local: boolean): Promise<void> {
  await update($, byModel, table => {
    const prev: ModelTally = table[id] ?? { tokens: 0, calls: 0, local }
    return { ...table, [id]: { tokens: prev.tokens + tokens, calls: prev.calls + 1, local } }
  })
}

/** A frontier-tier model by its id: the tier coding is meant to stay off. */
function isFrontier(id: string): boolean {
  return /fable|opus|mythos/i.test(id)
}

/** Minutes until a window is full at the pace of the recent samples, or null when flat or unknown. */
function minutesToFull(kind: string, latest: number, history: Sample[], now: number): number | null {
  const old = history.find(sm => sm.pct[kind] !== undefined && now - sm.at >= SAMPLE_MIN_SPAN_MS)
  if (!old) return null
  const span = now - old.at
  const rise = latest - (old.pct[kind] ?? latest)
  if (rise <= 0 || span <= 0) return null
  const perMin = rise / (span / 60_000)
  return (100 - latest) / perMin
}

function fmtMinutes(mins: number): string {
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h${Math.round(mins % 60).toString().padStart(2, '0')}`
  return `${Math.round(mins / 1440)}d`
}

function fmtAgo(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`
}

/** `/Users/wesley/Projects/agency-os` reads as `~/Projects/agency-os`; a long one keeps its tail. */
function shortPath(path: string, width: number): string {
  const home = /^\/Users\/[^/]+|^\/home\/[^/]+/.exec(path)
  const tidy = home ? `~${path.slice(home[0].length)}` : path
  return tidy.length <= width ? tidy : `…${tidy.slice(-(width - 1))}`
}

/** Split `width` cells across the segments in proportion, largest remainder so the sum is exact. */
function widths(segments: Segment[], max: number, width: number): number[] {
  const total = Math.max(max, segments.reduce((sum, s) => sum + s.tokens, 0), 1)
  const exact = segments.map(s => (s.tokens / total) * width)
  const floors = exact.map(Math.floor)
  let left = width - floors.reduce((a, b) => a + b, 0)
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (left <= 0) break
    floors[i] = (floors[i] ?? 0) + 1
    left -= 1
  }
  const freeIdx = segments.findIndex(s => s.kind === 'free')
  segments.forEach((s, i) => {
    if (s.kind === 'used' && s.tokens > 0 && floors[i] === 0 && freeIdx >= 0 && (floors[freeIdx] ?? 0) > 1) {
      floors[i] = 1
      floors[freeIdx] = (floors[freeIdx] ?? 0) - 1
    }
  })
  return floors
}

function ctxCells(tokens: number, window: number): number {
  return Math.max(0, Math.min(CTX_BAR, Math.round((tokens / Math.max(window, 1)) * CTX_BAR)))
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text.padEnd(width)
  return width > 1 ? `${text.slice(0, width - 1)}…` : text.slice(0, width)
}

/** The model and node a `cfn ... ask` shell command names, or null for any other command. */
function parseCfnAsk(command: string): { node: string; model: string } | null {
  const fleet = /\bcfn\s+fleet\s+ask\b/.exec(command)
  const node = /\bcfn\s+node\s+(\S+)\s+ask\b/.exec(command)
  if (!fleet && !node) return null
  const m = /\s(?:-m|--model)[\s=]+(\S+)/.exec(command)
  return { node: node?.[1] ?? 'fleet', model: m?.[1] ?? 'fast' }
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const [usage, current] = await Promise.all([$.session.usage({ breakdown: 'summary' }), $.session.model()])
    const b = usage.context.breakdown
    const segments: Segment[] = (b?.categories ?? [])
      .filter(c => c.kind !== 'deferred')
      .map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }))
    const windows: Window[] = usage.rateLimits.map(w => ({
      kind: w.kind,
      percentUsed: w.percentUsed,
      ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
    }))
    const now = await $.clock.now()
    const next: Snapshot = {
      segments,
      totalTokens: b?.totalTokens ?? usage.context.tokens ?? 0,
      maxTokens: b?.rawMaxTokens ?? usage.context.window,
      percentage: b?.percentage ?? usage.context.percent ?? 0,
      windows,
      takenAt: now,
      ...(b?.isAutoCompactEnabled && b.autoCompactThreshold ? { compactAt: b.autoCompactThreshold } : {}),
    }
    await update($, snapshot, () => next)
    await update($, model, () => current)
    if (windows.length > 0) {
      const pct: Record<string, number> = {}
      for (const w of windows) pct[w.kind] = w.percentUsed
      await update($, samples, list => {
        // One sample a minute at most, newest first, the last SAMPLE_KEEP minutes.
        const kept = list[0] && now - list[0].at < 55_000 ? list.slice(1) : list
        return [{ at: now, pct }, ...kept].filter(sm => now - sm.at <= SAMPLE_KEEP * 60_000).slice(0, SAMPLE_KEEP)
      })
    }
  } catch {
    // No session bound yet: keep the last drawing.
  }
}

async function readBranch($: EngineInterface, root: string): Promise<string | undefined> {
  try {
    let dir = `${root}/.git`
    let head = ''
    try {
      head = await $.fs.read(`${dir}/HEAD`)
    } catch {
      // A worktree's .git is a file naming the real git dir.
      const link = /^gitdir:\s*(.+)$/m.exec(await $.fs.read(dir))
      if (!link?.[1]) return undefined
      dir = link[1].trim()
      head = await $.fs.read(`${dir}/HEAD`)
    }
    const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)
    return ref?.[1]?.trim() ?? head.trim().slice(0, 7)
  } catch {
    return undefined
  }
}

async function refreshPlace($: EngineInterface): Promise<void> {
  try {
    const [cwd, repo] = await Promise.all([$.session.cwd(), $.session.repo()])
    const next: Place = { cwd }
    if (repo) {
      next.repo = repo.root.split('/').filter(Boolean).pop() ?? repo.root
      const branch = await readBranch($, repo.root)
      if (branch) next.branch = branch
    }
    await update($, place, () => next)
  } catch {
    // No session bound yet: keep the last drawing.
  }
}

async function addRun($: EngineInterface, row: Omit<AgentRow, 'startedAt' | 'status'>): Promise<void> {
  const startedAt = await $.clock.now()
  await update($, agents, list => [...list, { ...row, status: 'running' as const, startedAt }].slice(-MAX_AGENT_ROWS))
}

async function noteStep($: EngineInterface, id: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }): Promise<void> {
  const context = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  await update($, burned, total => total + context + usage.output_tokens)
  await update($, agents, list =>
    list.map(row =>
      row.id === id
        ? {
            ...row,
            model: usage.model,
            contextTokens: context,
            totalTokens: (row.totalTokens ?? 0) + context + usage.output_tokens,
            steps: (row.steps ?? 0) + 1,
          }
        : row,
    ),
  )
}

async function noteTool($: EngineInterface, id: string, tool: string | undefined): Promise<void> {
  await update($, agents, list =>
    list.map(row =>
      row.id === id && row.status === 'running'
        ? { ...row, toolCalls: (row.toolCalls ?? 0) + (tool ? 1 : 0), ...(tool ? { currentTool: tool } : { currentTool: undefined }) }
        : row,
    ),
  )
}

/** Drops finished rows older than FADE_MS. */
async function prune($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, agents, list => list.filter(row => row.status === 'running' || row.endedAt === undefined || now - row.endedAt < FADE_MS))
}

async function endRun($: EngineInterface, id: string, status: 'done' | 'failed', answeredBy?: string): Promise<void> {
  const endedAt = await $.clock.now()
  $.clock.after(FADE_MS, () => void prune($))
  await update($, agents, list =>
    list.map(row =>
      row.id === id && row.status === 'running'
        ? { ...row, status, endedAt, model: answeredBy ?? row.model, currentTool: undefined }
        : row,
    ),
  )
}

/** After a reload, rows left `running` are settled against the engine's own agent list. */
async function reconcileRuns($: EngineInterface): Promise<void> {
  try {
    const live = await $.agent.list()
    const now = await $.clock.now()
    await update($, agents, list =>
      list.map(row => {
        if (row.status !== 'running' || row.type === 'local') return row
        const found = live.find(a => a.id === row.id)
        const isLive = found && (found.status === 'pending' || found.status === 'running' || found.status === 'waiting')
        if (isLive) return row
        const failed = found?.status === 'failed' || found?.status === 'killed'
        return { ...row, status: failed ? ('failed' as const) : ('done' as const), endedAt: now }
      }),
    )
  } catch {
    // The list is unavailable before the session binds: try again next turn.
  }
}

async function open($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: 'Sidebar', columns: WANT_COLUMNS })
  if (!opened.isPlaced) $.ui.toast(`sidebar: ${opened.reason}`)
}

// While the panel is open, re-take the figures once a minute so the reset
// countdown and the elapsed times stay live between turns. A hot reload drops
// this environment's timers, so `register` starts it again from the stored state.
let tick: Timer | null = null

function startTick($: EngineInterface): void {
  tick?.cancel()
  tick = $.clock.every(TICK_MS, () => {
    void refresh($)
    void prune($)
  })
}

function stopTick(): void {
  tick?.cancel()
  tick = null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Toggle the context + usage + agents side panel',
      argumentHint: '[on|off]',
    })
    const isOn = (await $.store.get(STORE_KEY)) === true
    await update($, enabled, () => isOn)
    if (isOn) {
      void refresh($)
      void refreshPlace($)
      void reconcileRuns($)
      startTick($)
      const isUp = (await $.ui.panes()).some(p => p.id === PANE)
      if (!isUp) void open($)
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await read($, enabled)
    const want = arg === 'on' ? true : arg === 'off' ? false : !current
    await $.store.set(STORE_KEY, want)
    await update($, enabled, () => want)
    if (want) {
      await refresh($)
      await refreshPlace($)
      startTick($)
      await open($)
      return { text: 'Sidebar open.' }
    }
    stopTick()
    await $.ui.close({ id: PANE })
    return { text: 'Sidebar closed.' }
  })

  // The person's own close (the mark, or Escape) switches it off so it stays closed next session.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      stopTick()
      await $.store.set(STORE_KEY, false)
      await update($, enabled, () => false)
    }
    return next(e)
  })

  // A /model switch shows at once rather than at the next turn's end.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (await read($, enabled)) void refresh($)
    return next(e)
  })

  // A subagent the Agent tool spawns: one row, on the model the engine resolved for it.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId && spawned.model && (await read($, enabled))) {
      await addRun($, { id: spawned.agentId, label: e.description, type: e.subagentType, model: spawned.model })
    }
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (await read($, enabled)) {
      if (e.agentId) await endRun($, e.agentId, e.isAborted ? 'failed' : 'done', e.usage?.model)
      // The model that answered on the main loop is the one to show (a fallback included).
      else if (e.usage?.model) await update($, model, () => e.usage?.model ?? null)
      void refresh($)
    }
    return result
  })

  // Each request a subagent makes: its input side is how full its own window is.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    if (await read($, enabled)) {
      if (step.usage) {
        const u = step.usage
        await tally($, u.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens, false)
      }
      if (e.agentId && step.usage) await noteStep($, e.agentId, step.usage)
      else if (!e.agentId) {
        const level = e.effort === undefined ? null : String(e.effort)
        if (level !== (await read($, effort))) await update($, effort, () => level)
      }
    }
    return step
  })

  // The permission mode rides on every classic hook input: read it as each prompt goes in and each turn ends.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (!e.agent_id && (await read($, enabled))) {
      const m = e.permission_mode ?? null
      if (m !== (await read($, mode))) await update($, mode, () => m)
      void refreshPlace($)
    }
    return next(e)
  })

  // A compaction of the main conversation: count it and remember when.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && !done.skip && (await read($, enabled))) {
      const at = await $.clock.now()
      await update($, compactions, c => ({ count: c.count + 1, lastAt: at }))
      void refresh($)
    }
    return done
  })

  // Each tool call inside a subagent's loop: a count, and the tool it is on now.
  on('tool.call', async ($, e, next) => {
    const isTracked = e.agentId !== undefined && (await read($, enabled))
    if (isTracked) await noteTool($, e.agentId as string, e.tool)
    const ran = await next(e)
    if (isTracked) await noteTool($, e.agentId as string, undefined)
    return ran
  })

  // A prompt sent to a local fleet model through the fleet MCP tools.
  on('tool.call', { tool: 'mcp__fleet__fleet_ask' }, async ($, e, next) => {
    const isOn = await read($, enabled)
    const node = typeof e.node === 'string' ? e.node : 'fleet'
    const tag = typeof e.model === 'string' ? e.model : 'fast'
    if (isOn) await addRun($, { id: e.tool_use_id, label: node, type: 'local', model: tag })
    const ran = await next(e)
    if (isOn) {
      await endRun($, e.tool_use_id, ran.isError ? 'failed' : 'done')
      await tally($, tag, 0, true)
    }
    return ran
  })
  on('tool.call', { tool: 'mcp__fleet__node_ask' }, async ($, e, next) => {
    const isOn = await read($, enabled)
    const node = typeof e.node === 'string' ? e.node : 'fleet'
    const tag = typeof e.model === 'string' ? e.model : 'fast'
    if (isOn) await addRun($, { id: e.tool_use_id, label: node, type: 'local', model: tag })
    const ran = await next(e)
    if (isOn) {
      await endRun($, e.tool_use_id, ran.isError ? 'failed' : 'done')
      await tally($, tag, 0, true)
    }
    return ran
  })

  // The same through the cfn command line.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ask = parseCfnAsk(e.command)
    const isOn = ask !== null && (await read($, enabled))
    if (isOn) await addRun($, { id: e.tool_use_id, label: ask.node, type: 'local', model: ask.model })
    const ran = await next(e)
    if (isOn) {
      await endRun($, e.tool_use_id, ran.isError ? 'failed' : 'done')
      await tally($, ask.model, 0, true)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    const current = await read($, model)
    const runs = await read($, agents)
    const total = await read($, burned)
    const history = await read($, samples)
    const compacted = await read($, compactions)
    const level = await read($, effort)
    const permission = await read($, mode)
    const here = await read($, place)
    const tallies = Object.entries(await read($, byModel)).sort((a, b) => b[1].tokens - a[1].tokens || b[1].calls - a[1].calls)
    const topTokens = Math.max(1, ...tallies.map(([, t]) => t.tokens))
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(12, e.props.bodyColumns)

    if (!snap) {
      return (
        <Box>
          <Text dimColor>waiting for the first measurement…</Text>
        </Box>
      )
    }

    const cells = widths(snap.segments, snap.maxTokens, width)
    const over = snap.totalTokens > snap.maxTokens
    const compactCell = snap.compactAt !== undefined ? Math.min(width - 1, Math.round((snap.compactAt / Math.max(snap.maxTokens, 1)) * width)) : null
    const nearCompact = snap.compactAt !== undefined && snap.totalTokens >= snap.compactAt * 0.9
    const pastCompact = snap.compactAt !== undefined && snap.totalTokens >= snap.compactAt
    const ctxColor = over || pastCompact ? 'error' : nearCompact ? 'warning' : 'text'
    const nameWidth = width - 2 - 6 // mark + space, then a right-aligned 5-wide token figure after a space
    const barWidth = Math.max(6, width - 3 - 1 - 7) // label(2) + space, bar, space, pct(6)
    const runLabelWidth = Math.max(4, width - 2 - 1 - 7) // mark + space, label, space, elapsed(6)

    return (
      <Box flexDirection="column">
        <Box key="model" gap={1}>
          <Text bold>MODEL</Text>
          <Text color="claude" wrap="truncate">
            {current ? shortModel(current) : '…'}
          </Text>
        </Box>
        {(level || permission) && (
          <Box key="mode" gap={1}>
            {level && <Text dimColor wrap="truncate">effort {level}</Text>}
            {level && permission && <Text dimColor>·</Text>}
            {permission && (
              <Text color={permission === 'default' ? 'text' : permission === 'plan' ? 'planMode' : permission === 'acceptEdits' ? 'autoAccept' : 'warning'} dimColor={permission === 'default'} wrap="truncate">
                {permission === 'default' ? 'mode default' : permission}
              </Text>
            )}
          </Box>
        )}
        {here && (
          <Box key="where" flexDirection="column">
            {here.repo && (
              <Box gap={1}>
                <Text bold>REPO</Text>
                <Text wrap="truncate">{here.repo}</Text>
                {here.branch && <Text color="ide" wrap="truncate">{here.branch}</Text>}
              </Box>
            )}
            <Text dimColor wrap="truncate">{shortPath(here.cwd, width)}</Text>
          </Box>
        )}

        <Box key="ctx-head" gap={1} marginTop={1}>
          <Text bold>CONTEXT</Text>
          <Text bold color={ctxColor}>
            {snap.percentage}%
          </Text>
          <Text dimColor>
            {fmtTokens(snap.totalTokens)}/{fmtTokens(snap.maxTokens)}
          </Text>
        </Box>
        <Box key="ctx-bar">
          {snap.segments.map((s, i) => {
            const w = cells[i] ?? 0
            if (w === 0) return null
            return (
              <Text key={`seg-${i}`} color={s.color} dimColor={s.kind === 'free'} wrap="truncate">
                {GLYPH[s.kind].repeat(w)}
              </Text>
            )
          })}
        </Box>
        {compactCell !== null && (
          <Box key="compact-mark">
            <Text dimColor>{' '.repeat(compactCell)}</Text>
            <Text color={ctxColor === 'text' ? 'warning' : ctxColor}>▲</Text>
            <Text dimColor wrap="truncate">
              {' '}compact @ {Math.round(((snap.compactAt ?? 0) / Math.max(snap.maxTokens, 1)) * 100)}%
            </Text>
          </Box>
        )}
        {snap.segments.map((s, i) => (
          <Box key={`leg-${i}`}>
            <Text color={s.color} dimColor={s.kind === 'free'} wrap="truncate">
              {MARK[s.kind]} {fit(s.name, nameWidth)}
            </Text>
            <Text color={s.color} dimColor={s.kind === 'free'}>
              {' '}{fmtTokens(s.tokens).padStart(5)}
            </Text>
          </Box>
        ))}

        {compacted.count > 0 && (
          <Text key="compactions" dimColor wrap="truncate">
            compacted {compacted.count}× · last {compacted.lastAt !== undefined ? fmtAgo(snap.takenAt - compacted.lastAt) : '?'}
          </Text>
        )}

        <Box key="usage-head" marginTop={1}>
          <Text bold>USAGE</Text>
        </Box>
        {snap.windows.length === 0 && (
          <Text dimColor wrap="wrap">no rate-limit figures yet</Text>
        )}
        {snap.windows.map((w, i) => {
          const pct = Math.max(0, Math.min(100, w.percentUsed))
          const filled = Math.round((pct / 100) * barWidth)
          const color = WINDOW_COLOR[w.kind] ?? 'text'
          const exceeded = w.percentUsed >= 100
          const reset = fmtReset(w.resetsAt, snap.takenAt)
          const eta = minutesToFull(w.kind, w.percentUsed, history, snap.takenAt)
          const resetMins = w.resetsAt ? (Date.parse(w.resetsAt) - snap.takenAt) / 60_000 : Infinity
          const fillsFirst = eta !== null && eta < resetMins
          return (
            <Box key={`win-${i}`} flexDirection="column">
              <Box>
                <Text color={color} bold>
                  {(WINDOW_LABEL[w.kind] ?? w.kind.slice(0, 2)).padEnd(2)}{' '}
                </Text>
                <Text color={color} wrap="truncate">
                  {'█'.repeat(filled)}
                </Text>
                <Text dimColor wrap="truncate">
                  {'░'.repeat(barWidth - filled)}
                </Text>
                <Text color={exceeded ? 'error' : color} bold={exceeded}>
                  {' '}{fmtPct(w.percentUsed).padStart(6)}
                </Text>
              </Box>
              {(reset !== '' || fillsFirst) && (
                <Box>
                  <Text dimColor wrap="truncate">
                    {'   '}{reset}
                  </Text>
                  {fillsFirst && (
                    <Text color={eta < 10 ? 'error' : eta < 30 ? 'warning' : 'text'} dimColor={eta >= 30} wrap="truncate">
                      {reset !== '' ? ' · ' : ''}full in ~{fmtMinutes(eta)}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          )
        })}

        {tallies.length > 0 && (
          <Box key="by-model" flexDirection="column" marginTop={1}>
            <Box gap={1}>
              <Text bold>BY MODEL</Text>
              <Text dimColor>this session</Text>
            </Box>
            {tallies.map(([id, t]) => {
              const color = tierColor(id, t.local)
              const cells = t.local ? 0 : Math.max(1, Math.round((t.tokens / topTokens) * CTX_BAR))
              return (
                <Box key={`model-${id}`}>
                  <Text color={color} wrap="truncate">
                    {fit(`${t.local ? '⌂ ' : ''}${shortModel(id)}`, Math.max(6, width - CTX_BAR - 8))}
                  </Text>
                  {!t.local && <Text color={color}>{'█'.repeat(cells)}</Text>}
                  {!t.local && <Text dimColor>{'░'.repeat(CTX_BAR - cells)}</Text>}
                  <Text dimColor>
                    {' '}{t.local ? `${t.calls} call${t.calls === 1 ? '' : 's'}`.padStart(7) : fmtBig(t.tokens).padStart(6)}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}

        <Box key="agents-head" marginTop={1} gap={1}>
          <Text bold>AGENTS</Text>
          {runs.some(r => r.status === 'running') && (
            <Text color="warning">{runs.filter(r => r.status === 'running').length} running</Text>
          )}
          {total > 0 && <Text dimColor>{fmtBig(total)} tok</Text>}
        </Box>
        {runs.length === 0 && <Text dimColor>{total > 0 ? 'none running' : 'none spawned yet'}</Text>}
        {runs.map(r => {
          const color = STATUS_COLOR[r.status]
          const elapsed = fmtElapsed((r.endedAt ?? snap.takenAt) - r.startedAt)
          const who = r.type === 'local' ? `⌂ ${r.label}` : r.type
          return (
            <Box key={`run-${r.id}`} flexDirection="column">
              <Box>
                <Text color={color}>{STATUS_MARK[r.status]} </Text>
                <Text color={color} dimColor={r.status !== 'running'} wrap="truncate">
                  {fit(who, runLabelWidth)}
                </Text>
                <Text dimColor>{' '}{elapsed.padStart(6)}</Text>
              </Box>
              <Box>
                {r.type !== 'local' && isFrontier(r.model) && <Text color="error">{'  ⚠ frontier '}</Text>}
                <Text dimColor wrap="truncate">
                  {r.type !== 'local' && isFrontier(r.model) ? '' : '  '}{shortModel(r.model)}{r.type === 'local' || r.label === '' ? '' : ` · ${r.label}`}
                </Text>
              </Box>
              {r.contextTokens !== undefined && (
                <Box>
                  <Text dimColor>{'  ctx '}</Text>
                  <Text color={color}>{'█'.repeat(ctxCells(r.contextTokens, snap.maxTokens))}</Text>
                  <Text dimColor>{'░'.repeat(CTX_BAR - ctxCells(r.contextTokens, snap.maxTokens))}</Text>
                  <Text dimColor wrap="truncate">
                    {' '}{fmtTokens(r.contextTokens)}
                    {r.toolCalls ? ` · ${r.toolCalls} tool${r.toolCalls === 1 ? '' : 's'}` : ''}
                    {r.currentTool ? ` · ${r.currentTool}` : ''}
                  </Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
