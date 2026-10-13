import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, Timer, ElementConstructor, BoxProps, TextProps, RenderElement } from 'claude-code'

import type { RowSeg, RowSpec } from './rows'
import type { Activity, AgentRow, Compactions, FilesState, GroupGit, ListedEntry, ModelTally, OutsideFile, Place, Sample, Segment, Snapshot, Window } from '../types'

const STORE_KEY = 'enabled'
const COMMAND = 'sidebar'
const PANE = 'sidebar'
const WANT_COLUMNS = 60
const TICK_MS = 60_000
/** `claude -p /usage` is a ~2 s subprocess, so it is polled on its own slower cadence, not on every tick. */
const MODEL_USAGE_MS = 5 * 60_000
const MAX_AGENT_ROWS = 12
/** A finished run's row fades this long after it ended; running rows always stay. */
const FADE_MS = 2 * 60_000
/** Cells of the small per-agent context bar, scaled to the session model's window. */
const CTX_BAR = 10
/** Minutes of rate-limit samples kept for the burn rate, and the least span it is read over. */
const SAMPLE_KEEP = 30
const SAMPLE_MIN_SPAN_MS = 3 * 60_000
/** A file the session read or wrote keeps its mark this long after the last event. */
const ACTIVITY_MS = 45_000
/** A git refresh that finished more recently than this is not repeated at once. */
const FILES_MIN_GAP_MS = 1000
/** Rows of the FILES tree drawn; the rest collapse into a `… N more` line. */
const FILES_MAX_ROWS = 40
/** Rows of ELSEWHERE drawn across all its groups; the rest collapse into a `… N more` line. */
const ELSEWHERE_MAX_ROWS = 20
/** FILES palette: fixed hexes, so the tree reads the same in every theme. */
const WRITE_COLOR = '#f97316'
const READ_COLOR = '#c084fc'
const MUTED = '#808a96'
const ACCENT = '#5b9bd5'
const ADD_COLOR = '#98c379'
const DEL_COLOR = '#e06c75'
const AHEAD_COLOR = '#2dd4bf'
const BEHIND_COLOR = '#60a5fa'
/** A clean file whose commit has not reached the upstream. */
const UNPUSHED_COLOR = '#61afef'
const GIT_COLOR: Record<string, string> = {
  M: '#e5c07b',
  T: '#e5c07b',
  A: '#98c379',
  '?': '#98c379',
  R: '#61afef',
  C: '#61afef',
  D: '#d0605e',
  U: '#d0605e',
}
const COUNT_COLOR = { n: '#98c379', m: '#e5c07b', d: '#d0605e' } as const

const enabled = atom({ plugin: 'sidebar', key: 'enabled' } as const, false)
const snapshot = atom({ plugin: 'sidebar', key: 'snapshot' } as const, null)
const model = atom({ plugin: 'sidebar', key: 'model' } as const, null)
const agents = atom({ plugin: 'sidebar', key: 'agents' } as const, [])
const burned = atom({ plugin: 'sidebar', key: 'burned' } as const, 0)
const samples = atom({ plugin: 'sidebar', key: 'samples' } as const, [])
const modelWindows = atom({ plugin: 'sidebar', key: 'modelWindows' } as const, [])
const compactions = atom({ plugin: 'sidebar', key: 'compactions' } as const, { count: 0 })
const effort = atom({ plugin: 'sidebar', key: 'effort' } as const, null)
const mode = atom({ plugin: 'sidebar', key: 'mode' } as const, null)
const place = atom({ plugin: 'sidebar', key: 'place' } as const, null)
const byModel = atom({ plugin: 'sidebar', key: 'byModel' } as const, {})
const files = atom({ plugin: 'sidebar', key: 'files' } as const, null)
const activity = atom({ plugin: 'sidebar', key: 'activity' } as const, {})
const nerd = atom({ plugin: 'sidebar', key: 'nerd' } as const, false)
const elsewhere = atom({ plugin: 'sidebar', key: 'elsewhere' } as const, {})
const elsewhereGit = atom({ plugin: 'sidebar', key: 'elsewhereGit' } as const, {})

const GLYPH: Record<Segment['kind'], string> = { used: '█', buffer: '▒', free: '░', deferred: '' }
const MARK: Record<Segment['kind'], string> = { used: '■', buffer: '▒', free: '░', deferred: '' }

/** One theme color per rate-limit window, so the rows tell apart at a glance. */
const WINDOW_COLOR: Record<string, string> = { five_hour: 'claude', seven_day: 'permission', spend_limit: 'warning' }
const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$ ' }
/** Per-model weekly windows carry the kind `model:<display name>`. */
const MODEL_KIND = 'model:'

function windowColor(kind: string): string {
  return kind.startsWith(MODEL_KIND) ? 'success' : (WINDOW_COLOR[kind] ?? 'text')
}

function windowLabel(kind: string): string {
  return kind.startsWith(MODEL_KIND) ? kind.slice(MODEL_KIND.length) : (WINDOW_LABEL[kind] ?? kind.slice(0, 2))
}

/** The engine's windows with the per-model ones directly after `seven_day`, or at the end when there is none. */
function mergeWindows(engine: Window[], perModel: Window[]): Window[] {
  const at = engine.findIndex(w => w.kind === 'seven_day')
  if (at < 0) return [...engine, ...perModel]
  return [...engine.slice(0, at + 1), ...perModel, ...engine.slice(at + 1)]
}

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

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Milliseconds `zone` is ahead of UTC at the instant `ms`; throws RangeError for a zone name Intl does not know. */
function zoneOffset(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000
}

/** The instant of a wall-clock time in `zone` (the machine's own zone when absent). */
function wallInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string | undefined): number {
  if (!zone) return new Date(year, month, day, hour, minute).getTime()
  const guess = Date.UTC(year, month, day, hour, minute)
  // The offset at the guess may sit across a DST change from the offset at the answer, so settle it twice.
  const first = guess - zoneOffset(guess, zone)
  return guess - zoneOffset(first, zone)
}

/**
 * The ISO instant of a `/usage` reset such as `Oct 13 at 5pm (America/Denver)` or `Oct 13 at 5:30pm`,
 * in the year that makes it the nearest instant after `now`. A missing zone reads in the machine's own.
 * Undefined when the text does not parse.
 */
function parseResetTime(when: string, now: number): string | undefined {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?\s*$/i.exec(when.trim())
  if (!m) return undefined
  const month = MONTHS.indexOf((m[1] ?? '').slice(0, 3).toLowerCase())
  const day = Number(m[2])
  const hour12 = Number(m[3])
  const minute = m[4] === undefined ? 0 : Number(m[4])
  if (month < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return undefined
  const hour = (hour12 % 12) + ((m[5] ?? '').toLowerCase() === 'pm' ? 12 : 0)
  const zone = m[6]?.trim() || undefined
  try {
    const year = new Date(now).getUTCFullYear()
    const ahead = [year - 1, year, year + 1].map(y => wallInstant(y, month, day, hour, minute, zone)).filter(t => t > now)
    const nearest = Math.min(...ahead)
    return Number.isFinite(nearest) ? new Date(nearest).toISOString() : undefined
  } catch {
    return undefined
  }
}

/** One window per `Current week (<model>): N% used · resets <when>` line of `/usage` output, except the all-models one. */
function parseModelUsage(text: string, now: number): Window[] {
  const out: Window[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Current week \((.+?)\):\s*(\d+(?:\.\d+)?)%\s+used(?:\s*·\s*resets\s+(.+?))?\s*$/.exec(line)
    const name = m?.[1]?.trim()
    if (!m || !name || name.toLowerCase() === 'all models') continue
    const resetsAt = m[3] ? parseResetTime(m[3], now) : undefined
    out.push({ kind: `${MODEL_KIND}${name}`, percentUsed: Number(m[2]), ...(resetsAt ? { resetsAt } : {}) })
  }
  return out
}

let modelPolling = false

/**
 * Reads the per-model weekly windows from Claude Code's own `/usage` (no model call, ~2 s). Any failure, a
 * non-zero exit or output with no such line leaves no rows: stale figures are never kept. One poll at a time.
 */
async function refreshModelUsage($: EngineInterface): Promise<void> {
  if (modelPolling) return
  modelPolling = true
  try {
    let found: Window[] = []
    let now = 0
    try {
      const done = await $.process.run(['claude', '-p', '/usage'], { timeoutMs: 20_000 })
      now = await $.clock.now()
      if (done.exitCode === 0) found = parseModelUsage(done.stdout, now)
    } catch {
      found = []
    }
    await update($, modelWindows, () => found)
    if (found.length > 0) {
      const pct: Record<string, number> = {}
      for (const w of found) pct[w.kind] = w.percentUsed
      // Its own sample at the poll's time: the burn rate reads each window over real elapsed time.
      await update($, samples, list => [{ at: now, pct }, ...list].filter(sm => now - sm.at <= SAMPLE_KEEP * 60_000).slice(0, SAMPLE_KEEP * 2))
    }
  } catch {
    // Bookkeeping only: never fail the open or the tick that rides on it.
  } finally {
    modelPolling = false
  }
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
        // One engine sample a minute at most, newest first, the last SAMPLE_KEEP minutes; the per-model
        // samples that refreshModelUsage adds ride in the same list and are never replaced here.
        const last = list.findIndex(sm => Object.keys(sm.pct).some(k => !k.startsWith(MODEL_KIND)))
        const kept = last >= 0 && now - (list[last]?.at ?? 0) < 55_000 ? list.filter((_, i) => i !== last) : list
        return [{ at: now, pct }, ...kept].filter(sm => now - sm.at <= SAMPLE_KEEP * 60_000).slice(0, SAMPLE_KEEP * 2)
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

// ---- FILES: the working directory as a pruned tree, coloured by git and tool activity ----

type GitMark = { letter: string; staged: boolean }

/** The one letter a porcelain `XY` shows: an unstaged change wins over a staged one; ignored has none. */
function gitMark(xy: string): GitMark | null {
  if (xy === '!!') return null
  if (xy === '??') return { letter: '?', staged: false }
  const x = xy[0] ?? ' '
  const y = xy[1] ?? ' '
  if (y === 'M' || y === 'D') return { letter: y, staged: false }
  if ('AMDRC'.includes(x)) return { letter: x, staged: true }
  const other = y !== ' ' ? y : x
  return other === ' ' ? null : { letter: other, staged: false }
}

function parseStatus(out: string): Pick<FilesState, 'branch' | 'upstream' | 'ahead' | 'behind' | 'hasUpstream' | 'status'> {
  const status: Record<string, { xy: string }> = {}
  const result: Pick<FilesState, 'branch' | 'upstream' | 'ahead' | 'behind' | 'hasUpstream' | 'status'> = { ahead: 0, behind: 0, hasUpstream: false, status }
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i] ?? ''
    if (f === '') continue
    if (f.startsWith('## ')) {
      const line = f.slice(3)
      const counts = /\[([^\]]*)\]\s*$/.exec(line)
      const head = (counts ? line.slice(0, counts.index) : line).trim()
      result.hasUpstream = head.includes('...')
      const upstream = head.split('...')[1]
      if (upstream) result.upstream = upstream
      const name = (head.split('...')[0] ?? head).replace(/^(?:No commits yet on|Initial commit on) /, '').replace(/ \(no branch\)$/, '')
      if (name !== '') result.branch = name
      result.ahead = Number(/ahead (\d+)/.exec(counts?.[1] ?? '')?.[1] ?? 0)
      result.behind = Number(/behind (\d+)/.exec(counts?.[1] ?? '')?.[1] ?? 0)
      continue
    }
    const xy = f.slice(0, 2)
    status[f.slice(3)] = { xy }
    // A rename or copy is followed by one more field, the path it came from.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i += 1
  }
  return result
}

/** `added<TAB>deleted<TAB>path` per entry; binary files show `-`, read as 0. */
function parseNumstat(out: string, into: Record<string, { add: number; del: number }>): void {
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i] ?? ''
    if (f === '') continue
    const parts = f.split('\t')
    const add = Number(parts[0]) || 0
    const del = Number(parts[1]) || 0
    let path = parts.slice(2).join('\t')
    // A rename lists an empty path, then the old and the new path as their own fields.
    if (path === '') {
      path = fields[i + 2] ?? ''
      i += 2
    }
    if (path === '') continue
    const prev = into[path] ?? { add: 0, del: 0 }
    into[path] = { add: prev.add + add, del: prev.del + del }
  }
}

function splitNul(out: string | null): string[] {
  return (out ?? '').split('\0').filter(f => f !== '')
}

/** Runs git in the repo root; null on a failure or a non-zero exit, never a throw. */
async function runGit($: EngineInterface, root: string, args: string[]): Promise<string | null> {
  try {
    const done = await $.process.run(['git', ...args], { cwd: root })
    return done.exitCode === 0 ? done.stdout : null
  } catch {
    return null
  }
}

type GitPicture = Pick<FilesState, 'branch' | 'upstream' | 'ahead' | 'behind' | 'hasUpstream' | 'status' | 'numstat' | 'unpushed'>

/** Status, both numstats and the unpushed set of the repo at `root`; `ok` is false when `git status` itself failed. */
async function readGit($: EngineInterface, root: string): Promise<{ ok: boolean; git: GitPicture }> {
  const [statusOut, unstagedOut, stagedOut, unpushedOut] = await Promise.all([
    runGit($, root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal', '--ignored=traditional']),
    runGit($, root, ['diff', '--numstat', '-z']),
    runGit($, root, ['diff', '--numstat', '--cached', '-z']),
    runGit($, root, ['diff', '--name-only', '-z', '@{upstream}..HEAD']),
  ])
  const numstat: Record<string, { add: number; del: number }> = {}
  parseNumstat(unstagedOut ?? '', numstat)
  parseNumstat(stagedOut ?? '', numstat)
  return { ok: statusOut !== null, git: { ...parseStatus(statusOut ?? ''), numstat, unpushed: splitNul(unpushedOut) } }
}

// One git refresh at a time; a call that lands during one joins it, and one that lands
// within FILES_MIN_GAP_MS of the last finish is replayed once when that gap is over.
let filesRun: Promise<void> | null = null
let filesDoneAt: number | null = null
let filesRetry = false

/** Every folder holding a flagged path (git change, unpushed or session activity): the ones the tree draws open. */
function expandedDirs(status: Record<string, { xy: string }>, unpushed: string[], marks: Record<string, Activity>): Set<string> {
  const flagged = [...Object.entries(status).filter(([, s]) => s.xy !== '!!').map(([path]) => path), ...unpushed, ...Object.keys(marks)]
  const open = new Set<string>()
  for (const path of flagged) {
    const parts = path.split('/').filter(part => part !== '')
    for (let i = 1; i < parts.length; i += 1) open.add(parts.slice(0, i).join('/'))
  }
  return open
}

/** One folder from disk (`dir` relative to `root`, `''` the root itself); null when it cannot be read. */
async function listDir($: EngineInterface, root: string, dir: string): Promise<ListedEntry[] | null> {
  try {
    const entries = await $.fs.list(dir === '' ? root : `${root}/${dir}`)
    return entries.map(en => ({ name: en.name, kind: en.kind, mtimeMs: en.mtimeMs, isLink: en.isLink }))
  } catch {
    return null
  }
}

async function listDirs($: EngineInterface, root: string, dirs: string[]): Promise<Record<string, ListedEntry[]>> {
  const got = await Promise.all(dirs.map(async dir => [dir, await listDir($, root, dir)] as const))
  const listed: Record<string, ListedEntry[]> = {}
  for (const [dir, entries] of got) if (entries) listed[dir] = entries
  return listed
}

/** Where Nerd Fonts are installed, tried in turn; the home folder comes from HOME or the working directory. */
async function hasNerdFont($: EngineInterface): Promise<boolean> {
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {
    // No environment to read: fall back to the working directory below.
  }
  if (home === '') {
    const cwd = await $.session.cwd()
    home = /^\/(?:Users|home)\/[^/]+/.exec(cwd)?.[0] ?? ''
  }
  const dirs = [`${home}/Library/Fonts`, '/Library/Fonts', `${home}/.local/share/fonts`, `${home}/.fonts`]
  for (const dir of dirs) {
    try {
      const entries = await $.fs.list(dir)
      if (entries.some(en => en.name.toLowerCase().includes('nerd'))) return true
    } catch {
      // A missing or unreadable folder just has no font in it.
    }
  }
  return false
}

/** Settles whether FILES draws Nerd Font glyphs: the setting, or for `auto` whether one is installed. */
async function resolveGlyphs($: EngineInterface, setting: unknown): Promise<void> {
  const want = setting === 'nerd' ? true : setting === 'plain' ? false : await hasNerdFont($)
  await update($, nerd, () => want)
}

async function gatherFiles($: EngineInterface): Promise<void> {
  try {
    const [cwd, repo] = await Promise.all([$.session.cwd(), $.session.repo()])
    const takenAt = await $.clock.now()
    if (!repo) {
      const listed = await listDirs($, cwd, [''])
      await update($, files, () => ({
        root: cwd,
        isRepo: false,
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        tracked: [],
        listed,
        status: {},
        numstat: {},
        unpushed: [],
        takenAt,
      }))
      return
    }
    const root = repo.root
    const [got, listOut] = await Promise.all([readGit($, root), runGit($, root, ['ls-files', '-z'])])
    // Git gave nothing at all: keep the last drawing rather than blanking it.
    if (!got.ok && listOut === null) return
    const git = got.git
    // The folders the tree will draw open, from git and live activity, are the ones read from disk.
    const live = Object.fromEntries(Object.entries(await read($, activity)).filter(([, m]) => takenAt - m.at < ACTIVITY_MS))
    const listed = await listDirs($, root, ['', ...expandedDirs(git.status, git.unpushed, live)])
    const next: FilesState = { root, isRepo: true, ...git, tracked: splitNul(listOut), listed, takenAt }
    await update($, files, () => next)
  } catch {
    // No session bound yet: keep the last drawing.
  }
}

async function refreshFiles($: EngineInterface): Promise<void> {
  if (filesRun) return filesRun
  const now = await $.clock.now()
  if (filesRun) return filesRun
  if (filesDoneAt !== null && now >= filesDoneAt && now - filesDoneAt < FILES_MIN_GAP_MS) {
    if (!filesRetry) {
      filesRetry = true
      $.clock.after(FILES_MIN_GAP_MS - (now - filesDoneAt), () => {
        filesRetry = false
        void refreshFiles($)
      })
    }
    return
  }
  const run = Promise.all([gatherFiles($), gatherElsewhere($)]).then(() => undefined).finally(async () => {
    filesRun = null
    filesDoneAt = await $.clock.now()
  })
  filesRun = run
  return run
}

async function refreshFilesIfOn($: EngineInterface): Promise<void> {
  if (await read($, enabled)) void refreshFiles($)
}

/** Marks a file the session is reading or writing; a path outside the repo (or cwd) goes to ELSEWHERE instead. */
async function markActivity($: EngineInterface, path: string | undefined, kind: Activity['kind']): Promise<void> {
  try {
    if (!path || !(await read($, enabled))) return
    const [cwd, repo] = await Promise.all([$.session.cwd(), $.session.repo()])
    const root = (repo?.root ?? cwd).replace(/\/+$/, '')
    if (!path.startsWith(`${root}/`)) {
      if (path !== root) await markOutside($, path, kind)
      return
    }
    const rel = path.slice(root.length + 1)
    const at = await $.clock.now()
    $.clock.after(ACTIVITY_MS, () => void pruneActivity($))
    await update($, activity, marks => {
      const prev = marks[rel]
      // A live write mark is not downgraded by a read.
      if (kind === 'read' && prev?.kind === 'write' && at - prev.at < ACTIVITY_MS) return marks
      return { ...marks, [rel]: { kind, at } }
    })
  } catch {
    // Bookkeeping only: a failure here must never fail the tool call it rides on.
  }
}

const SHELL_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'sed', 'awk', 'grep', 'rg', 'wc', 'diff', 'stat', 'file', 'ls'])
const SHELL_PREFIXES = new Set(['sudo', 'env', 'time', 'nice'])
/** Options whose next word is their value, not a file, per reader. */
const SHELL_OPTION_ARGS: Record<string, string[]> = {
  sed: ['-e', '-f'],
  grep: ['-e', '-f', '-g', '-t', '-m', '-A', '-B', '-C', '--include', '--exclude', '--glob'],
  rg: ['-e', '-f', '-g', '-t', '-m', '-A', '-B', '-C', '--include', '--exclude', '--glob'],
  head: ['-n', '-c'],
  tail: ['-n', '-c'],
  awk: ['-F', '-v', '-f'],
}
const SHELL_READ_CAP = 20

/** A shell command as segments of words: split on `|`, `&&`, `||`, `;` and newlines outside quotes, words unquoted. */
function shellSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  const endWord = (): void => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = (): void => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < command.length) word += command[++i]!
      else word += ch
    } else if (ch === '\\' && i + 1 < command.length) {
      word += command[++i]!
      inWord = true
    } else if (ch === "'" || ch === '"') {
      quote = ch
      inWord = true
    } else if (ch === '|' || ch === ';' || ch === '\n') {
      endSegment()
    } else if (ch === '&' && command[i + 1] === '&') {
      endSegment()
      i += 1
    } else if (ch === ' ' || ch === '\t') {
      endWord()
    } else {
      word += ch
      inWord = true
    }
  }
  endSegment()
  return segments
}

/** The paths a shell command's reader commands (`cat`, `sed`, `grep`, ...) name, in order and unique; globs and flags are dropped. */
function readTargets(command: string): string[] {
  const found: string[] = []
  // A `cd` earlier in the command moves where later relative paths are read from.
  let dir = ''
  for (const words of shellSegments(command)) {
    let at = 0
    while (at < words.length && (SHELL_PREFIXES.has(words[at]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!))) at += 1
    if (words[at] === 'cd') {
      const to = words[at + 1] ?? '~'
      dir = to.startsWith('/') || to === '~' || to.startsWith('~/') || dir === '' ? to : `${dir}/${to}`
      continue
    }
    const reader = words[at]?.split('/').pop() ?? ''
    if (!SHELL_READERS.has(reader)) continue
    const takesValue = SHELL_OPTION_ARGS[reader] ?? []
    for (let i = at + 1; i < words.length; i += 1) {
      const w = words[i]!
      if (/^\d*[<>]/.test(w)) {
        if (/^\d*(>>?|<)$/.test(w)) i += 1
        continue
      }
      if (w.startsWith('-')) {
        if (takesValue.includes(w)) i += 1
        continue
      }
      if (/[*?[]/.test(w)) continue
      const target = dir === '' || w.startsWith('/') || w === '~' || w.startsWith('~/') ? w : `${dir}/${w}`
      if (!found.includes(target)) found.push(target)
    }
  }
  return found
}

/** `a/./b/../c` to `a/c`; the input is absolute. */
function normalisePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/** Marks the existing files and folders a shell command's readers name as read: inside the repo (or cwd) for FILES, elsewhere for ELSEWHERE. */
async function markShellReads($: EngineInterface, command: string): Promise<void> {
  try {
    if (!(await read($, enabled))) return
    const candidates = readTargets(command).slice(0, SHELL_READ_CAP)
    if (candidates.length === 0) return
    const [cwd, home] = await Promise.all([$.session.cwd(), $.env.get('HOME')])
    for (const c of candidates) {
      const raw = c === '~' || c.startsWith('~/') ? (home ? `${home}${c.slice(1)}` : '') : c
      if (raw === '') continue
      const path = normalisePath(raw.startsWith('/') ? raw : `${cwd}/${raw}`)
      if (!(await $.fs.exists(path))) continue
      await markActivity($, path, 'read')
    }
  } catch {
    // Bookkeeping only: a failure here must never fail the Bash call it rides on.
  }
}

/** Drops marks older than ACTIVITY_MS. */
async function pruneActivity($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, activity, marks => {
    const live = Object.entries(marks).filter(([, m]) => now - m.at < ACTIVITY_MS)
    return live.length === Object.keys(marks).length ? marks : Object.fromEntries(live)
  })
}

// ---- ELSEWHERE: paths the session touches outside the FILES root, grouped by the repo that holds them ----

/** The group a path outside the FILES root is filed under: the nearest folder above it holding a `.git`, else its parent folder. */
async function groupOf($: EngineInterface, path: string): Promise<{ root: string; isRepo: boolean }> {
  const parent = path.slice(0, path.lastIndexOf('/')) || '/'
  let dir = parent
  for (;;) {
    if (await $.fs.exists(`${dir === '/' ? '' : dir}/.git`).catch(() => false)) return { root: dir, isRepo: true }
    if (dir === '/') return { root: parent, isRepo: false }
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }
}

/** Whether a path is a folder now; a path not there yet (a Write about to create it) is not. */
async function isFolder($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

/** Records a path outside the FILES root: filed under its group on first touch, re-stamped on each later one. */
async function markOutside($: EngineInterface, raw: string, kind: Activity['kind']): Promise<void> {
  if (!raw.startsWith('/')) return
  const path = normalisePath(raw)
  if (path === '/') return
  const known = (await read($, elsewhere))[path]
  const place = known ? { root: known.root, isRepo: known.isRepo, isDir: known.isDir } : { ...(await groupOf($, path)), isDir: await isFolder($, path) }
  const at = await $.clock.now()
  // The row stays; only its colour fades, so the pane is drawn again once the mark is over.
  $.clock.after(ACTIVITY_MS, () => {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // The next state write redraws it anyway.
    }
  })
  let isNewGroup = false
  await update($, elsewhere, map => {
    const prev = map[path]
    // A live write mark is not downgraded by a read.
    if (kind === 'read' && prev?.kind === 'write' && at - prev.at < ACTIVITY_MS) return map
    isNewGroup = place.isRepo && !Object.values(map).some(f => f.root === place.root)
    const next: OutsideFile = { kind, at, root: place.root, isRepo: place.isRepo, isDir: place.isDir }
    return { ...map, [path]: next }
  })
  // A repo seen for the first time is read at once rather than at the next refresh.
  if (isNewGroup) void readGroup($, place.root)
}

/** Reads one ELSEWHERE group's git; a repo git cannot read loses its entry, so its rows draw without badges. */
async function readGroup($: EngineInterface, root: string): Promise<void> {
  const [{ ok, git }, takenAt] = await Promise.all([readGit($, root), $.clock.now()])
  await update($, elsewhereGit, groups => {
    if (ok) return { ...groups, [root]: { ...git, takenAt } }
    return root in groups ? Object.fromEntries(Object.entries(groups).filter(([r]) => r !== root)) : groups
  })
}

/** Reads every ELSEWHERE group that is a repo, one git call set each. */
async function gatherElsewhere($: EngineInterface): Promise<void> {
  try {
    const roots = new Set(Object.values(await read($, elsewhere)).filter(f => f.isRepo).map(f => f.root))
    await Promise.all([...roots].map(root => readGroup($, root)))
  } catch {
    // No session bound yet: keep the last drawing.
  }
}

type TreeNode = {
  name: string
  path: string
  isDir: boolean
  kids: Map<string, TreeNode>
  opaque?: 'ignored' | 'untracked'
  mtimeMs?: number
  isLink?: boolean
}

type FileRow = {
  path: string
  name: string
  depth: number
  isDir: boolean
  expanded: boolean
  isLink: boolean
  mtimeMs: number | undefined
  mark: 'read' | 'write' | null
  letter: string | null
  /** Committed but not yet on the upstream, and otherwise clean. */
  unpushed: boolean
  /** A file's own lines; a folder's, summed over everything beneath it. */
  add: number
  del: number
  ignored: boolean
  opaque?: TreeNode['opaque']
  /** A folder's files beneath it that are new, modified and deleted. */
  newN: number
  modN: number
  delN: number
}

type Roll = { add: number; del: number; newN: number; modN: number; delN: number }

/** Lines and file counts of everything git flags at or under `prefix` (`''` is the whole repo). */
function rollUp(state: Pick<FilesState, 'numstat' | 'status'>, prefix: string): Roll {
  const roll: Roll = { add: 0, del: 0, newN: 0, modN: 0, delN: 0 }
  const under = (path: string): boolean => prefix === '' || path.startsWith(`${prefix}/`)
  for (const [path, stat] of Object.entries(state.numstat)) {
    if (!under(path)) continue
    roll.add += stat.add
    roll.del += stat.del
  }
  for (const [path, s] of Object.entries(state.status)) {
    if (!under(path) || s.xy === '!!') continue
    const letter = s.xy === '??' ? '?' : gitMark(s.xy)?.letter
    if (!letter) continue
    if (letter === 'A' || letter === '?') roll.newN += 1
    else if (letter === 'D' || letter === 'U') roll.delN += 1
    else roll.modN += 1
  }
  return roll
}

function addNode(root: TreeNode, path: string, opaque?: TreeNode['opaque']): void {
  const parts = path.split('/').filter(part => part !== '')
  let node = root
  parts.forEach((part, i) => {
    const isLast = i === parts.length - 1
    let kid = node.kids.get(part)
    if (!kid) {
      kid = { name: part, path: parts.slice(0, i + 1).join('/'), isDir: !isLast || opaque !== undefined, kids: new Map() }
      node.kids.set(part, kid)
    }
    if (isLast && opaque !== undefined) kid.opaque = opaque
    node = kid
  })
}

function findNode(root: TreeNode, path: string): TreeNode | null {
  let node: TreeNode | undefined = root
  for (const part of path.split('/').filter(p => p !== '')) node = node?.kids.get(part)
  return node ?? null
}

/** The pruned tree as drawn rows: folders open only where a flagged file sits below them. */
function buildRows(state: FilesState, marks: Record<string, Activity>): { rows: FileRow[]; more: number } {
  const unpushed = new Set(state.unpushed)
  const root: TreeNode = { name: '', path: '', isDir: true, kids: new Map() }
  for (const path of state.tracked) addNode(root, path)
  for (const [path, s] of Object.entries(state.status)) {
    if (path.endsWith('/')) addNode(root, path, s.xy === '!!' ? 'ignored' : 'untracked')
    else addNode(root, path)
  }
  for (const path of Object.keys(marks)) addNode(root, path)
  // The disk listing adds what git does not name (dot entries, clean folders) and carries the times.
  for (const [dir, entries] of Object.entries(state.listed ?? {})) {
    const node = findNode(root, dir)
    if (!node?.isDir) continue
    for (const en of entries) {
      let kid = node.kids.get(en.name)
      if (!kid) {
        kid = { name: en.name, path: dir === '' ? en.name : `${dir}/${en.name}`, isDir: en.kind === 'dir', kids: new Map() }
        node.kids.set(en.name, kid)
      }
      if (en.kind === 'file') kid.mtimeMs = en.mtimeMs
      if (en.isLink) kid.isLink = true
    }
  }
  const expanded = expandedDirs(state.status, state.unpushed, marks)

  const rows: FileRow[] = []
  const walk = (node: TreeNode, depth: number): void => {
    const kids = [...node.kids.values()].sort(
      (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    )
    for (const kid of kids) {
      const base = {
        path: kid.path,
        name: kid.name,
        depth,
        isLink: kid.isLink === true,
        mtimeMs: kid.mtimeMs,
        mark: null,
        letter: null,
        unpushed: false,
        add: 0,
        del: 0,
        ignored: false,
        newN: 0,
        modN: 0,
        delN: 0,
      }
      if (!kid.isDir) {
        const xy = state.status[kid.path]?.xy
        const git = xy === undefined ? null : gitMark(xy)
        const stat = state.numstat[kid.path]
        rows.push({
          ...base,
          isDir: false,
          expanded: false,
          mark: marks[kid.path]?.kind ?? null,
          letter: git?.letter ?? null,
          unpushed: unpushed.has(kid.path) && git === null,
          add: stat?.add ?? 0,
          del: stat?.del ?? 0,
          ignored: xy === '!!',
        })
      } else if (kid.opaque) {
        rows.push({ ...base, mark: marks[kid.path]?.kind ?? null, isDir: true, expanded: false, opaque: kid.opaque, ignored: kid.opaque === 'ignored', letter: kid.opaque === 'untracked' ? '?' : null })
      } else {
        const open = expanded.has(kid.path)
        const roll = state.isRepo ? rollUp(state, kid.path) : { add: 0, del: 0, newN: 0, modN: 0, delN: 0 }
        rows.push({ ...base, mark: marks[kid.path]?.kind ?? null, isDir: true, expanded: open, ...roll })
        if (open) walk(kid, depth + 1)
      }
    }
  }
  walk(root, 0)
  return { rows: rows.slice(0, FILES_MAX_ROWS), more: Math.max(0, rows.length - FILES_MAX_ROWS) }
}

type OutsideGroup = { root: string; name: string; isRepo: boolean; git: GroupGit | null; rows: FileRow[] }

/** The `XY` of `rel` in a status: its own, or that of the untracked or ignored folder above it that git lists instead. */
function statusOf(status: Record<string, { xy: string }>, rel: string): string | undefined {
  const own = status[rel]?.xy
  if (own !== undefined) return own
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const above = status[`${parts.slice(0, i).join('/')}/`]?.xy
    if (above !== undefined) return above
  }
  return undefined
}

/** ELSEWHERE as groups of flat rows (paths relative to the group), groups by folder name, rows by path; ELSEWHERE_MAX_ROWS rows in all. */
function outsideGroups(outside: Record<string, OutsideFile>, gits: Record<string, GroupGit>, now: number): { groups: OutsideGroup[]; more: number } {
  const byRoot = new Map<string, OutsideGroup>()
  for (const [path, f] of Object.entries(outside)) {
    let group = byRoot.get(f.root)
    if (!group) {
      group = { root: f.root, name: f.root.split('/').filter(part => part !== '').pop() ?? '/', isRepo: f.isRepo, git: f.isRepo ? (gits[f.root] ?? null) : null, rows: [] }
      byRoot.set(f.root, group)
    }
    const rel = f.root === '/' ? path.slice(1) : path.slice(f.root.length + 1)
    const git = group.git
    const xy = git ? statusOf(git.status, f.isDir ? `${rel}/` : rel) : undefined
    const base = {
      path,
      name: rel,
      depth: 0,
      expanded: false,
      isLink: false,
      mtimeMs: undefined,
      mark: now - f.at < ACTIVITY_MS ? f.kind : null,
      unpushed: false,
      add: 0,
      del: 0,
      newN: 0,
      modN: 0,
      delN: 0,
    }
    if (f.isDir) {
      const opaque = xy === '!!' ? ('ignored' as const) : xy === '??' ? ('untracked' as const) : undefined
      const roll = git && !opaque ? rollUp(git, rel) : {}
      group.rows.push({ ...base, isDir: true, ...(opaque ? { opaque } : {}), ignored: opaque === 'ignored', letter: opaque === 'untracked' ? '?' : null, ...roll })
    } else {
      const mark = xy === undefined ? null : gitMark(xy)
      const stat = git?.numstat[rel]
      group.rows.push({
        ...base,
        isDir: false,
        letter: mark?.letter ?? null,
        unpushed: git !== null && mark === null && git.unpushed.includes(rel),
        add: stat?.add ?? 0,
        del: stat?.del ?? 0,
        ignored: xy === '!!',
      })
    }
  }
  const byName = (a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase())
  const groups = [...byRoot.values()].sort((a, b) => byName(a.name, b.name) || byName(a.root, b.root))
  let left = ELSEWHERE_MAX_ROWS
  let more = 0
  for (const g of groups) {
    g.rows.sort((a, b) => byName(a.name, b.name))
    more += Math.max(0, g.rows.length - left)
    g.rows = g.rows.slice(0, left)
    left -= g.rows.length
  }
  return { groups: groups.filter(g => g.rows.length > 0), more }
}

/** The colour of a row's icon and name: activity, then git state, then muted for dot and ignored; undefined is the terminal's own. */
function rowTone(r: FileRow): string | undefined {
  if (r.mark === 'write') return WRITE_COLOR
  if (r.mark === 'read') return READ_COLOR
  if (r.letter) return GIT_COLOR[r.letter]
  if (r.unpushed) return UNPUSHED_COLOR
  if (r.ignored || baseName(r.name).startsWith('.')) return MUTED
  return undefined
}

const FILE_ICON_NAMES: Record<string, number> = {
  'agents.md': 0xf0354,
  'changelog.md': 0xf0354,
  'contributing.md': 0xf0354,
  'todo.md': 0xf0354,
  'readme.md': 0xf0354,
  license: 0xe60a,
  dockerfile: 0xf0868,
  makefile: 0xf1064,
  'cmakelists.txt': 0xf1064,
  justfile: 0xf05b7,
  gemfile: 0xf0d2d,
  rakefile: 0xf0d2d,
  'cargo.toml': 0xe6b2,
  'cargo.lock': 0xe6b2,
  'pyproject.toml': 0xe6b2,
  'requirements.txt': 0xf160e,
  'go.mod': 0xf0afa,
  'go.sum': 0xf07d3,
  'package.json': 0xf0626,
  'package-lock.json': 0xf0626,
  'tsconfig.json': 0xf0626,
  '.prettierrc': 0xf0626,
  '.eslintrc': 0xf0626,
  'pnpm-lock.yaml': 0xe6a8,
  'yarn.lock': 0xe6a8,
  '.gitignore': 0xf02a2,
  '.gitmodules': 0xf0493,
  '.editorconfig': 0xe652,
}

const FILE_ICON_EXTS: Record<string, number> = {
  lua: 0xe620, py: 0xe606, pyi: 0xe606, js: 0xe60c, mjs: 0xe60c, cjs: 0xe60c, ts: 0xe628, jsx: 0xe625, tsx: 0xe7ba,
  json: 0xe60b, jsonc: 0xe60b, yaml: 0xe6a8, yml: 0xe6a8, sh: 0xe795, bash: 0xe795, zsh: 0xe795, fish: 0xe795,
  md: 0xf0354, markdown: 0xf0354, css: 0xe6b8, scss: 0xf031c, html: 0xe736, htm: 0xe736, go: 0xe627, rs: 0xe68b,
  rb: 0xe791, php: 0xe608, java: 0xe738, cs: 0xf031b, sql: 0xe706, graphql: 0xf20e, gql: 0xf20e, xml: 0xf05c0,
  toml: 0xe6b2, ini: 0xf0bc2, conf: 0xf0493, pdf: 0xeaeb, svg: 0xf0721, jpg: 0xf0225, jpeg: 0xf0225, png: 0xe60d,
  gif: 0xf0d78, webp: 0xf021f, mp4: 0xf022b, mkv: 0xf022b, mov: 0xf022b, mp3: 0xf0223, wav: 0xf0223, flac: 0xf0223,
  zip: 0xf05c4, gz: 0xf05c4, xz: 0xf05c4, tar: 0xf05c4, qml: 0xf375, cpp: 0xe61d, cc: 0xe61d, cxx: 0xe61d, c: 0xe61e,
  h: 0xf0af5, hpp: 0xf0af5, vue: 0xe6a0, svelte: 0xe697, csv: 0xe64a, txt: 0xf09aa,
}

/** The last part of a row's name: FILES names are one part already, ELSEWHERE's are paths. */
function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

/** The chevron of a folder row, without its trailing space. */
function chevronGlyph(open: boolean, nerdOn: boolean): string {
  if (!nerdOn) return open ? '▾' : '▸'
  return String.fromCodePoint(open ? 0xf47c : 0xf460)
}

/** The icon of a row, without its trailing space: by exact name, then extension, in Nerd mode. */
function iconGlyph(r: FileRow, nerdOn: boolean): string {
  if (!nerdOn) return r.isDir ? '■' : '·'
  if (r.isLink) return String.fromCodePoint(0xf481)
  if (r.isDir) return String.fromCodePoint(r.expanded ? 0xe5fe : 0xe5ff)
  const lower = baseName(r.name).toLowerCase()
  const named = FILE_ICON_NAMES[lower]
  if (named) return String.fromCodePoint(named)
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  return String.fromCodePoint(FILE_ICON_EXTS[ext] ?? 0xf0214)
}

type Seg = { t: string; color?: string; bold?: boolean }

/** ` YYYY-MM-DD HH:MM` in local time, or nothing when the time is unknown. */
function fmtStamp(ms: number | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return ` ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

function lineSegs(add: number, del: number): Seg[] {
  const segs: Seg[] = []
  if (add > 0) segs.push({ t: ` +${add}`, color: ADD_COLOR })
  if (del > 0) segs.push({ t: ` -${del}`, color: DEL_COLOR })
  return segs
}

function countSegs(roll: Roll): Seg[] {
  const segs: Seg[] = []
  if (roll.newN > 0) segs.push({ t: ` N:${roll.newN}`, color: COUNT_COLOR.n })
  if (roll.modN > 0) segs.push({ t: ` M:${roll.modN}`, color: COUNT_COLOR.m })
  if (roll.delN > 0) segs.push({ t: ` D:${roll.delN}`, color: COUNT_COLOR.d })
  return segs
}

/** The right-hand column of a row: lines or time, then the badge (a file) or the counts (a folder). */
function rowRight(r: FileRow, nerdOn: boolean): Seg[] {
  const ignoredBadge: Seg = { t: nerdOn ? ` ${String.fromCodePoint(0xf05e)}` : ' ⊘', color: MUTED }
  if (r.isDir) {
    if (r.opaque === 'ignored') return [ignoredBadge]
    if (r.opaque === 'untracked') return [{ t: ' ?', color: GIT_COLOR['?'], bold: true }]
    return [...lineSegs(r.add, r.del), ...countSegs(r)]
  }
  const segs: Seg[] = r.add > 0 || r.del > 0 ? lineSegs(r.add, r.del) : fmtStamp(r.mtimeMs) === '' ? [] : [{ t: fmtStamp(r.mtimeMs), color: MUTED }]
  if (r.letter) segs.push({ t: ` ${r.letter}`, color: GIT_COLOR[r.letter], bold: true })
  else if (r.unpushed) segs.push({ t: ' ↑', color: UNPUSHED_COLOR, bold: true })
  else if (r.ignored) segs.push(ignoredBadge)
  else segs.push({ t: '  ' })
  return segs
}

/** A segment for `rows.tsx` without its unset fields: the props are plain JSON, which holds no `undefined`. */
function wire(seg: RowSeg): RowSeg {
  return Object.fromEntries(Object.entries(seg).filter(([, v]) => v !== undefined && v !== false)) as RowSeg
}

/** The wire form of a FILES row for the surface module `rows.tsx`: lit segments carry the sweep tone and the activity's time. */
function rowSpec(r: FileRow, nerdOn: boolean, at: number | undefined): RowSpec {
  const tone = rowTone(r)
  const sh = r.mark && at !== undefined ? r.mark : undefined
  return {
    id: r.path,
    left: [
      { t: `${'  '.repeat(r.depth)}${r.isDir ? chevronGlyph(r.expanded, nerdOn) : ' '} `, c: MUTED },
      { t: `${iconGlyph(r, nerdOn)} `, c: r.isDir ? (tone ?? ACCENT) : tone, one: true, sh, at: sh ? at : undefined },
      { t: r.name, c: tone, s: r.letter === 'D', sh, at: sh ? at : undefined },
    ].map(wire),
    right: rowRight(r, nerdOn).map(g => wire({ t: g.t, c: g.color, b: g.bold })),
  }
}

/** A section's title row (`word`, the folder's name in the accent colour) and, for a repo git can read, its branch row with the whole repo's totals. */
function repoHead(Box: ElementConstructor<BoxProps>, Text: ElementConstructor<TextProps>, word: string, key: string, name: string, isRepo: boolean, git: GroupGit | null, nerdOn: boolean): RenderElement[] {
  const head = (
    <Box key={`${key}-head`} flexDirection="row" gap={1}>
      <Text bold>{word}</Text>
      <Text color={ACCENT} wrap="truncate-end">{name}</Text>
      {!isRepo && <Text color={MUTED}>not a git repo</Text>}
    </Box>
  )
  if (!isRepo || !git) return [head]
  const roll = rollUp(git, '')
  return [
    head,
    <Box key={`${key}-branch`} flexDirection="row" height={1} overflow="hidden">
      <Box flexShrink={1} overflow="hidden" flexDirection="row">
        <Text color={ACCENT}>{`${nerdOn ? String.fromCodePoint(0xe0a0) : '⎇'} `}</Text>
        {git.branch && <Text bold wrap="truncate-end">{git.branch}</Text>}
        {git.ahead > 0 && <Text color={AHEAD_COLOR}>{` ↑${git.ahead}`}</Text>}
        {git.behind > 0 && <Text color={BEHIND_COLOR}>{` ↓${git.behind}`}</Text>}
        {git.upstream && <Text color={MUTED} wrap="truncate-end">{` ${git.upstream}`}</Text>}
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} flexDirection="row">
        {[...lineSegs(roll.add, roll.del), ...countSegs(roll)].map((g, i) => (
          <Text key={`total-${i}`} color={g.color} bold={g.bold}>{g.t}</Text>
        ))}
        {roll.newN + roll.modN + roll.delN === 0 && <Text color={MUTED}> clean</Text>}
      </Box>
    </Box>,
  ]
}

async function open($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: 'Sidebar', columns: WANT_COLUMNS })
  if (!opened.isPlaced) $.ui.toast(`sidebar: ${opened.reason}`)
}

// While the panel is open, re-take the figures once a minute so the reset
// countdown and the elapsed times stay live between turns. A hot reload drops
// this environment's timers, so `register` starts it again from the stored state.
let tick: Timer | null = null
let modelTick: Timer | null = null

function startTick($: EngineInterface): void {
  tick?.cancel()
  tick = $.clock.every(TICK_MS, () => {
    void refresh($)
    void prune($)
    void pruneActivity($)
    void refreshFiles($)
  })
  // The per-model rows come from a subprocess: once now, then every MODEL_USAGE_MS. Whatever an
  // earlier open left is dropped first, so a figure from before the panel closed never shows.
  modelTick?.cancel()
  void update($, modelWindows, () => []).then(() => refreshModelUsage($))
  modelTick = $.clock.every(MODEL_USAGE_MS, () => void refreshModelUsage($))
}

function stopTick(): void {
  tick?.cancel()
  tick = null
  modelTick?.cancel()
  modelTick = null
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Toggle the context + usage + agents side panel',
      argumentHint: '[on|off]',
    })
    const isOn = (await $.store.get(STORE_KEY)) === true
    await update($, enabled, () => isOn)
    await resolveGlyphs($, options.glyphs)
    if (isOn) {
      void refresh($)
      void refreshPlace($)
      void refreshFiles($)
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
      await resolveGlyphs($, options.glyphs)
      await refresh($)
      await refreshPlace($)
      await refreshFiles($)
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
      void refreshFiles($)
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

  // Files the session reads and writes: marked before the tool runs so the mark shows while it works.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    await markActivity($, e.file_path, 'read')
    return next(e)
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    await markActivity($, e.file_path, 'write')
    const ran = await next(e)
    await refreshFilesIfOn($)
    return ran
  })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    await markActivity($, e.file_path, 'write')
    const ran = await next(e)
    await refreshFilesIfOn($)
    return ran
  })
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    await markActivity($, e.notebook_path, 'write')
    const ran = await next(e)
    await refreshFilesIfOn($)
    return ran
  })

  // The same through the cfn command line.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await markShellReads($, e.command)
    const ask = parseCfnAsk(e.command)
    const isOn = ask !== null && (await read($, enabled))
    if (isOn) await addRun($, { id: e.tool_use_id, label: ask.node, type: 'local', model: ask.model })
    const ran = await next(e)
    if (isOn) {
      await endRun($, e.tool_use_id, ran.isError ? 'failed' : 'done')
      await tally($, ask.model, 0, true)
    }
    await refreshFilesIfOn($)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    const current = await read($, model)
    const runs = await read($, agents)
    const total = await read($, burned)
    const history = await read($, samples)
    const perModel = await read($, modelWindows)
    const compacted = await read($, compactions)
    const level = await read($, effort)
    const permission = await read($, mode)
    const here = await read($, place)
    const filesNow = await read($, files)
    const marks = await read($, activity)
    const outsideNow = await read($, elsewhere)
    const outsideGit = await read($, elsewhereGit)
    const filesClock = await $.clock.now()
    const nerdOn = options.glyphs === 'nerd' ? true : options.glyphs === 'plain' ? false : await read($, nerd)
    const tallies = Object.entries(await read($, byModel)).sort((a, b) => b[1].tokens - a[1].tokens || b[1].calls - a[1].calls)
    const topTokens = Math.max(1, ...tallies.map(([, t]) => t.tokens))
    const { Box, Text, Client } = $.ui.resolve(e)
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
    const wins = mergeWindows(snap.windows, perModel)
    const labelWidth = Math.max(2, ...wins.map(w => windowLabel(w.kind).length))
    const barWidth = Math.max(6, width - (labelWidth + 1) - 1 - 7) // label + space, bar, space, pct(6)
    const runLabelWidth = Math.max(4, width - 2 - 1 - 7) // mark + space, label, space, elapsed(6)

    const tree = filesNow ? buildRows(filesNow, marks) : null
    const outside = outsideGroups(outsideNow, outsideGit, filesClock)

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
        {wins.length === 0 && (
          <Text dimColor wrap="wrap">no rate-limit figures yet</Text>
        )}
        {wins.map((w, i) => {
          const pct = Math.max(0, Math.min(100, w.percentUsed))
          const filled = Math.round((pct / 100) * barWidth)
          const color = windowColor(w.kind)
          const exceeded = w.percentUsed >= 100
          const reset = fmtReset(w.resetsAt, snap.takenAt)
          const eta = minutesToFull(w.kind, w.percentUsed, history, snap.takenAt)
          const resetMins = w.resetsAt ? (Date.parse(w.resetsAt) - snap.takenAt) / 60_000 : Infinity
          const fillsFirst = eta !== null && eta < resetMins
          return (
            <Box key={`win-${i}`} flexDirection="column">
              <Box>
                <Text color={color} bold>
                  {windowLabel(w.kind).padEnd(labelWidth)}{' '}
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
                    {' '.repeat(labelWidth + 1)}{reset}
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

        {filesNow && tree && (
          <Box key="files" flexDirection="column" marginTop={1}>
            {repoHead(Box, Text, 'FILES', 'files', filesNow.root.split('/').filter(part => part !== '').pop() ?? '/', filesNow.isRepo, filesNow, nerdOn)}
            <Client key="files-rows" module="./rows.tsx" props={{ rows: tree.rows.map(r => rowSpec(r, nerdOn, marks[r.path]?.at)), now: filesClock }} />
            {tree.more > 0 && <Text dimColor>… {tree.more} more</Text>}
          </Box>
        )}

        {outside.groups.length > 0 && (
          <Box key="elsewhere" flexDirection="column">
            {outside.groups.map(g => (
              <Box key={`else-${g.root}`} flexDirection="column" marginTop={1}>
                {repoHead(Box, Text, 'ELSEWHERE', `else-${g.root}`, g.name, g.isRepo, g.git, nerdOn)}
                <Client key={`else-rows-${g.root}`} module="./rows.tsx" props={{ rows: g.rows.map(r => rowSpec(r, nerdOn, outsideNow[r.path]?.at)), now: filesClock }} />
              </Box>
            ))}
            {outside.more > 0 && <Text dimColor>… {outside.more} more</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
