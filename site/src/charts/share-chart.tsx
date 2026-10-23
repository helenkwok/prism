// The one chart (D-72, 06-UI-SPEC "Chart Grammar"): horizontal share bars on one 0-100% axis, Wilson whiskers,
// direct value labels, and explicit non-number rows that never draw a bar or a 0. Ported from top-app's
// carbon-chart.ts method to React SVG. It receives rows from public-data and never computes a suppression.
// Paired mode (claims chart): consecutive rows of one check are drawn as two bars 2px apart, "claimed" in red and
// the other in blue, with a legend above the plot and direct labels on the first pair.
import { checkIdOf, rowSentence, stateText, type Row } from '../data'

const W = 640, ROW = 48, PAIR = 64, PLOT = 520, BAR = 12, GAP = 2
const x = (pct: number) => (Math.max(0, Math.min(100, pct)) / 100) * PLOT

const TITLES: Partial<Record<Row['state'], string>> = {
  lt10: 'Fewer than 10 launches; suppressed by disclosure control',
  suppressed: 'Suppressed so no hidden figure can be worked out from released ones',
}

export interface ChartOptions {
  /** Draw consecutive rows of the same check as one pair (claims chart). */
  paired?: boolean
  /** Row ids drawn in the neutral colour (the folded "other source types" bar). */
  neutral?: string[]
}

/** Square start at 0, 4px rounded data end. */
function barPath(w: number, y: number) {
  const r = Math.min(4, w / 2)
  return `M0,${y}H${w - r}Q${w},${y} ${w},${y + r}V${y + BAR - r}Q${w},${y + BAR} ${w - r},${y + BAR}H0Z`
}

const short = (label: string) => (label.length > 80 ? `${label.slice(0, 79)}…` : label)
/** "Check title. (claimed, no artefact linked)" -> ["Check title.", "claimed, no artefact linked"]. */
const split = (label: string) => {
  const m = / \(([^()]+)\)$/.exec(label)
  return m ? [label.slice(0, m.index), m[1]!] as const : [label, ''] as const
}
const barClass = (r: Row, neutral: Set<string>) =>
  neutral.has(r.id) ? 'fill-(--chart-neutral) forced-color-adjust-auto' : r.id.split('|')[2] === 'claimed' ? 'chart-bar-red' : 'chart-bar'

/** One bar line: bar, whisker and value, or the explicit-state tick and text. `series` adds a direct label. */
function BarLine({ r, barY, neutral, compact, series }: { r: Row; barY: number; neutral: Set<string>; compact: boolean; series?: string }) {
  const cy = barY + BAR / 2
  const explicit = stateText(r)
  if (explicit !== null) return (
    <g data-row-state={r.state}>
      <title>{`${r.label}: ${TITLES[r.state] ?? explicit}`}</title>
      <line className="chart-state-tick" x1={1} x2={1} y1={barY} y2={barY + BAR} />
      <text className="chart-state" data-state-text x={8} y={cy + 4}>{series ? `${series}: ${explicit}` : explicit}</text>
    </g>
  )
  const w = r.c! > 0 ? Math.max(3, x(r.pct!)) : 0
  const [lo, hi] = r.ci!
  // Direct label: right of the whisker if it fits, else left of it over the bar, else at the start.
  const room = (series?.length ?? 0) * 7
  const label = x(hi) + 6 + room <= PLOT ? { x: x(hi) + 6, anchor: 'start' } : x(lo) - 6 - room >= 0 ? { x: x(lo) - 6, anchor: 'end' } : { x: 8, anchor: 'start' }
  return (
    <g data-row-state="released">
      <title>{rowSentence(r)}</title>
      {w > 0 && <path className={barClass(r, neutral)} d={barPath(w, barY)} />}
      <line className="chart-whisker" x1={x(lo)} x2={x(hi)} y1={cy} y2={cy} />
      <line className="chart-whisker" x1={x(lo)} x2={x(lo)} y1={cy - 4} y2={cy + 4} />
      <line className="chart-whisker" x1={x(hi)} x2={x(hi)} y1={cy - 4} y2={cy + 4} />
      {series && <text className="chart-label" x={label.x} y={cy + 4} textAnchor={label.anchor}>{series}</text>}
      {compact
        ? <text className="chart-detail" x={W} y={cy + 4} textAnchor="end">{`${r.pct}% (${r.c} of ${r.n})`}</text>
        : <>
            <text className="chart-pct" x={W} y={cy + 5} textAnchor="end">{r.pct}%</text>
            <text className="chart-detail" x={W} y={barY + 26} textAnchor="end">{`${r.c} of ${r.n} · CI ${lo}–${hi}%`}</text>
          </>}
    </g>
  )
}

export function ShareChart({ id, title, rows, paired = false, neutral = [] }: { id: string; title: string; rows: Row[] } & ChartOptions) {
  const groups: Row[][] = []
  for (const r of rows) {
    const last = groups.at(-1)
    if (paired && last && checkIdOf(last[0]!.id) === checkIdOf(r.id)) last.push(r)
    else groups.push([r])
  }
  const legend = paired ? (groups[0] ?? []).map(r => ({ cls: barClass(r, new Set()), text: split(r.label)[1] })) : []
  const ticksY = legend.length ? 38 : 14
  const top = ticksY + 10
  const H = top + groups.reduce((h, g) => h + (g.length > 1 ? PAIR : ROW), 0) + 8
  const neutralSet = new Set(neutral)
  let y = top
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-desc`}>{rows.map(rowSentence).join('. ')}</desc>
        {legend.map((l, i) => (
          <g key={l.text} data-legend transform={`translate(${i * 240},4)`}>
            <rect className={l.cls} width={BAR} height={BAR} />
            <text className="chart-label" x={BAR + 6} y={BAR - 1}>{l.text}</text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map(t => (
          <g key={t}>
            <line className="chart-grid" x1={x(t) + 0.5} x2={x(t) + 0.5} y1={top - 4} y2={H - 8} />
            <text className="chart-tick" x={x(t)} y={ticksY} textAnchor={t === 0 ? 'start' : t === 100 ? 'end' : 'middle'}>{t}%</text>
          </g>
        ))}
        {groups.map((g, gi) => {
          const at = y
          y += g.length > 1 ? PAIR : ROW
          const label = g.length > 1 ? split(g[0]!.label)[0] : g[0]!.label
          return (
            <g key={g[0]!.id}>
              <text className="chart-label" x={0} y={at + 14}>{short(label)}</text>
              {g.map((r, i) => (
                <BarLine key={r.id} r={r} barY={at + 20 + i * (BAR + GAP)} neutral={neutralSet} compact={g.length > 1}
                  series={g.length > 1 && gi === 0 ? split(r.label)[1] : undefined} />
              ))}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
