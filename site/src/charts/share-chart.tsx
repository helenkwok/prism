// The one chart (D-72, 06-UI-SPEC "Chart Grammar"): horizontal share bars on one 0-100% axis, Wilson whiskers,
// direct value labels, and explicit non-number rows that never draw a bar or a 0. Ported from top-app's
// carbon-chart.ts method to React SVG. It receives rows from public-data and never computes a suppression.
import { rowSentence, stateText, type Row } from '../data'

const W = 640, ROW = 48, TOP = 24, PLOT = 520, BAR = 12
const x = (pct: number) => (Math.max(0, Math.min(100, pct)) / 100) * PLOT

const TITLES: Partial<Record<Row['state'], string>> = {
  lt10: 'Fewer than 10 launches; suppressed by disclosure control',
  suppressed: 'Suppressed so no hidden figure can be worked out from released ones',
}

/** Square start at 0, 4px rounded data end. */
function barPath(w: number, y: number) {
  const r = Math.min(4, w / 2)
  return `M0,${y}H${w - r}Q${w},${y} ${w},${y + r}V${y + BAR - r}Q${w},${y + BAR} ${w - r},${y + BAR}H0Z`
}

export function ShareChart({ id, title, rows }: { id: string; title: string; rows: Row[] }) {
  const H = TOP + rows.length * ROW + 8
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-desc`}>{rows.map(rowSentence).join('. ')}</desc>
        {[0, 25, 50, 75, 100].map(t => (
          <g key={t}>
            <line className="chart-grid" x1={x(t) + 0.5} x2={x(t) + 0.5} y1={TOP - 4} y2={H - 8} />
            <text className="chart-tick" x={x(t)} y={14} textAnchor={t === 0 ? 'start' : t === 100 ? 'end' : 'middle'}>{t}%</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const top = TOP + i * ROW
          const barY = top + 20, cy = barY + BAR / 2
          const label = r.label.length > 80 ? `${r.label.slice(0, 79)}…` : r.label
          const explicit = stateText(r)
          if (explicit !== null) return (
            <g key={r.id} data-row-state={r.state}>
              <title>{`${r.label}: ${TITLES[r.state] ?? explicit}`}</title>
              <text className="chart-label" x={0} y={top + 14}>{label}</text>
              <line className="chart-state-tick" x1={1} x2={1} y1={barY} y2={barY + BAR} />
              <text className="chart-state" data-state-text x={8} y={cy + 4}>{explicit}</text>
            </g>
          )
          const w = r.c! > 0 ? Math.max(3, x(r.pct!)) : 0
          const [lo, hi] = r.ci!
          return (
            <g key={r.id} data-row-state="released">
              <title>{rowSentence(r)}</title>
              <text className="chart-label" x={0} y={top + 14}>{label}</text>
              {w > 0 && <path className="chart-bar" d={barPath(w, barY)} />}
              <line className="chart-whisker" x1={x(lo)} x2={x(hi)} y1={cy} y2={cy} />
              <line className="chart-whisker" x1={x(lo)} x2={x(lo)} y1={cy - 4} y2={cy + 4} />
              <line className="chart-whisker" x1={x(hi)} x2={x(hi)} y1={cy - 4} y2={cy + 4} />
              <text className="chart-pct" x={W} y={cy + 5} textAnchor="end">{r.pct}%</text>
              <text className="chart-detail" x={W} y={top + 46} textAnchor="end">{`${r.c} of ${r.n} · CI ${lo}–${hi}%`}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
