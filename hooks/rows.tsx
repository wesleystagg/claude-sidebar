import type { ClientModule } from 'claude-code'

/** One run of text on a FILES row: `sh` lights it with the activity sweep, `at` is that activity's event time in ms. */
export type RowSeg = { t: string; c?: string; b?: boolean; s?: boolean; sh?: 'write' | 'read'; at?: number; one?: boolean }
export type RowSpec = { id: string; left: RowSeg[]; right: RowSeg[] }
export type RowsProps = { rows: RowSpec[]; now: number }
type Local = { phase: number; ref: { stop?: () => void; seen: number; ticks: number } }

const TICK_MS = 90
/** A mark this young sweeps in the bright palette, after that in the dim one. */
const BRIGHT_MS = 2700
const PALETTES = {
  write: { bright: ['#f97316', '#fb923c', '#fdba74', '#ffedd5'], dim: ['#8a4316', '#a3562a', '#bd7444', '#d29267'] },
  read: { bright: ['#a855f7', '#c084fc', '#d8b4fe', '#f3e8ff'], dim: ['#581c87', '#6b21a8', '#8b47c4', '#a874d6'] },
}

/** The colour of cell `i` as a band of light passes along a run of `len` cells. */
function shimmer(i: number, phase: number, len: number, palette: string[]): string {
  const band = ((phase * 1.6) % (len + 8)) - 4
  const d = Math.abs(i - band)
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? '#f97316'
}

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { phase: 0, ref: { seen: props.now, ticks: 0 } }
    surface.setState(state)
  }
  const ref = state.ref
  // New props carry a fresh `now`: the elapsed time counts from there again.
  if (props.now !== ref.seen) {
    ref.seen = props.now
    ref.ticks = 0
  }
  // The tick runs only while some segment is lit, and starts again when one appears.
  const lit = props.rows.some(r => r.left.some(s => s.sh) || r.right.some(s => s.sh))
  if (lit && !ref.stop) {
    ref.stop = surface.every(TICK_MS, () => {
      const cur = surface.state
      if (!cur) return
      cur.ref.ticks += 1
      surface.setState({ ...cur, phase: cur.phase + 1 })
    })
  } else if (!lit && ref.stop) {
    ref.stop()
    ref.stop = undefined
  }
  const phase = state.phase
  const draw = (s: RowSeg) => {
    if (!s.sh || s.at === undefined) {
      return (
        <Text color={s.c} bold={s.b} strikethrough={s.s} wrap="truncate-end">
          {s.t}
        </Text>
      )
    }
    const tones = PALETTES[s.sh]
    const palette = props.now - s.at + ref.ticks * TICK_MS < BRIGHT_MS ? tones.bright : tones.dim
    if (s.one) return <Text color={shimmer(-1, phase, [...s.t].length, palette)}>{s.t}</Text>
    const chars = [...s.t]
    return (
      <Text bold={s.b} strikethrough={s.s}>
        {chars.map((ch, i) => (
          <Text color={shimmer(i, phase, chars.length, palette)}>{ch}</Text>
        ))}
      </Text>
    )
  }
  return (
    <Box flexDirection="column">
      {props.rows.map(r => (
        <Box flexDirection="row" height={1} overflow="hidden">
          <Box flexShrink={1} overflow="hidden" flexDirection="row">
            {r.left.map(draw)}
          </Box>
          <Box flexGrow={1} />
          <Box flexShrink={0} flexDirection="row">
            {r.right.map(draw)}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export default Rows
