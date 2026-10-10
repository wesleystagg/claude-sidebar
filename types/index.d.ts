export type Segment = {
  name: string
  tokens: number
  color: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type Window = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type Snapshot = {
  segments: Segment[]
  totalTokens: number
  maxTokens: number
  percentage: number
  windows: Window[]
  takenAt: number
  /** The token count where auto-compaction fires; absent when it is off. */
  compactAt?: number
}

/** One minute's reading of each rate-limit window, for the burn rate. */
export type Sample = {
  at: number
  pct: Record<string, number>
}

export type Compactions = {
  count: number
  lastAt?: number
}

/** What one model has consumed this session: tokens for an API model, calls alone for a local one. */
export type ModelTally = {
  tokens: number
  calls: number
  local: boolean
}

export type Place = {
  cwd: string
  repo?: string
  branch?: string
}

/** One delegated run: a subagent the Agent tool spawned, or a prompt sent to a local fleet model. */
export type AgentRow = {
  id: string
  /** The Agent call's short description, or for a local run the node it went to. */
  label: string
  /** The agent type (`coder`, `Explore`, ...) or `local` for a fleet call. */
  type: string
  /** The model it runs on, as resolved at spawn, or the one that answered once known. */
  model: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  /** The input side of its last request: uncached, cache-written and cache-read together, so roughly how full its own window is. */
  contextTokens?: number
  /** Every request's input and output tokens summed: what the run has burned so far. */
  totalTokens?: number
  /** Requests made so far. */
  steps?: number
  /** Tool calls made so far. */
  toolCalls?: number
  /** The tool it is running right now, while one is open. */
  currentTool?: string
}

/** A file the session is reading or writing right now; the mark fades after its last event. */
export type Activity = {
  kind: 'read' | 'write'
  at: number
}

/** One entry of a folder listed from disk; `mtimeMs` is 0 for anything but a regular file. */
export type ListedEntry = {
  name: string
  kind: 'file' | 'dir' | 'other'
  mtimeMs: number
  isLink: boolean
}

/** The git picture of the working directory. Paths are POSIX, relative to `root`. */
export type FilesState = {
  /** The repo root, or the working directory outside a repo. */
  root: string
  isRepo: boolean
  branch?: string
  ahead: number
  behind: number
  hasUpstream: boolean
  /** The upstream branch, `origin/main`, when the branch has one. */
  upstream?: string
  /** Every tracked path (outside a repo: none). */
  tracked: string[]
  /** Disk listings by folder path relative to `root` (`''` is the root): the root and every expanded folder. */
  listed?: Record<string, ListedEntry[]>
  /** Porcelain `XY` per path; a path ending `/` is a whole untracked or ignored folder. */
  status: Record<string, { xy: string }>
  /** Lines added and deleted per path, unstaged and staged summed. */
  numstat: Record<string, { add: number; del: number }>
  /** Files committed but not pushed to the upstream. */
  unpushed: string[]
  takenAt: number
}

declare module 'claude-code' {
  interface PluginState {
    sidebar: {
      enabled: boolean
      snapshot: Snapshot | null
      model: string | null
      agents: AgentRow[]
      /** Input + output tokens of every delegated run this session, faded rows included. */
      burned: number
      samples: Sample[]
      compactions: Compactions
      effort: string | null
      mode: string | null
      place: Place | null
      byModel: Record<string, ModelTally>
      files: FilesState | null
      activity: Record<string, Activity>
      /** Whether FILES draws Nerd Font glyphs, as resolved at session start from the `glyphs` setting. */
      nerd: boolean
    }
  }
}
