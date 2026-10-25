// PRISMA flow (06-UI-SPEC "PrismaFlow"): the selection stages as vertical boxes, the exclusion reasons as boxes to
// the right joined by 1px arrows. Counts arrive from release.prisma already merged (reasons under 10 become
// "other", protocol 6.7); a box that still holds a suppressed tuple shows its state as words, never 0.
import { stateCell, stateText, type PrismaBox, type Release } from '../data'
import { HowWeKnow, releaseRow, selectionRow, whoRow } from '../components/how-we-know'

const W = 640, MAIN = 280, SPINE = 300, SIDE = 320, PAD = 16, LINE = 18, GAP = 32, SIDE_GAP = 8

/** The box's count as text: the number, or the explicit state. */
const countOf = (b: PrismaBox) => (b.row ? stateText(b.row) ?? b.row.c!.toLocaleString('en') : b.count!.toLocaleString('en'))
const explicit = (b: PrismaBox) => !!b.row && stateText(b.row) !== null

/** Word-wrap a label to lines of at most `max` characters. */
function wrap(text: string, max: number) {
  const lines: string[] = []
  for (const word of text.split(' ')) {
    const last = lines.at(-1)
    if (last !== undefined && `${last} ${word}`.length <= max) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines
}

interface Placed { b: PrismaBox; x: number; y: number; w: number; h: number; lines: string[]; compact: boolean }
/** Main boxes: label lines, then the count. Compact (exclusion) boxes: label lines with the count at the right. */
function place(boxes: PrismaBox[], x: number, w: number, y0: number, gap: number, compact = false) {
  let y = y0
  return boxes.map(b => {
    const lines = wrap(b.label, Math.floor((w - 2 * PAD - (compact ? 64 : 0)) / 7))
    const h = compact ? lines.length * LINE + 2 * 8 : PAD + lines.length * LINE + 24 + PAD - 4
    const p = { b, x, y, w, h, lines, compact }
    y += h + gap
    return p
  })
}

function Box({ p }: { p: Placed }) {
  const top = p.compact ? 8 : PAD
  const count = p.compact
    ? { x: p.x + p.w - PAD, y: p.y + top + 13, anchor: 'end' as const }
    : { x: p.x + PAD, y: p.y + PAD + p.lines.length * LINE + 14, anchor: 'start' as const }
  return (
    <g data-row-state={explicit(p.b) ? p.b.row!.state : 'released'}>
      <title>{`${p.b.label}: ${countOf(p.b)}`}</title>
      <rect className="prisma-box" x={p.x + 0.5} y={p.y + 0.5} width={p.w - 1} height={p.h - 1} rx={8} />
      {p.lines.map((l, i) => <text key={i} className="chart-label" x={p.x + PAD} y={p.y + top + (p.compact ? 13 : 10) + i * LINE}>{l}</text>)}
      {explicit(p.b)
        ? <text className="chart-state" data-state-text x={count.x} y={count.y} textAnchor={count.anchor}>{countOf(p.b)}</text>
        : <text className="chart-pct" x={count.x} y={count.y} textAnchor={count.anchor}>n = {countOf(p.b)}</text>}
    </g>
  )
}

export function PrismaFlow({ id, title, prisma }: { id: string; title: string; prisma: NonNullable<Release['prisma']> }) {
  const main = place(prisma.boxes, 0, MAIN, 0, GAP)
  // Exclusions hang off the screening stage (the second box), or the first if there is only one.
  const anchor = main[Math.min(1, main.length - 1)]
  const side = place(prisma.exclusions, SIDE, W - SIDE, anchor?.y ?? 0, SIDE_GAP, true)
  const H = Math.max(...[...main, ...side].map(p => p.y + p.h)) + 1
  const mid = (p: Placed) => p.y + p.h / 2
  const arrow = `${id}-arrow`
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-desc`}>{[...prisma.boxes, ...prisma.exclusions].map(b => `${b.label}: ${countOf(b)}`).join('. ')}</desc>
        <defs>
          <marker id={arrow} viewBox="0 0 8 8" refX={8} refY={4} markerWidth={8} markerHeight={8} orient="auto">
            <path className="prisma-head" d="M0,0L8,4L0,8Z" />
          </marker>
        </defs>
        {main.slice(1).map((p, i) => <line key={p.b.id} className="prisma-arrow" x1={MAIN / 2} x2={MAIN / 2} y1={main[i]!.y + main[i]!.h} y2={p.y - 1} markerEnd={`url(#${arrow})`} />)}
        {anchor && side.length > 0 && <>
          <line className="prisma-arrow" x1={MAIN} x2={SPINE} y1={mid(anchor)} y2={mid(anchor)} />
          <line className="prisma-arrow" x1={SPINE} x2={SPINE} y1={Math.min(mid(anchor), mid(side[0]!))} y2={Math.max(mid(anchor), mid(side.at(-1)!))} />
          {side.map(p => <line key={p.b.id} className="prisma-arrow" x1={SPINE} x2={SIDE - 1} y1={mid(p)} y2={mid(p)} markerEnd={`url(#${arrow})`} />)}
        </>}
        {[...main, ...side].map(p => <Box key={p.b.id} p={p} />)}
      </svg>
    </div>
  )
}

/** The flow's data table (table view and Appendix B). */
export function PrismaTable({ prisma, caption }: { prisma: NonNullable<Release['prisma']>; caption: string }) {
  const rows = [...prisma.boxes.map(b => ({ b, stage: 'Selection stage' })), ...prisma.exclusions.map(b => ({ b, stage: 'Excluded' }))]
  return (
    <div className="table-scroll">
      <table className="data">
        <caption>{caption}</caption>
        <thead><tr><th scope="col">Box</th><th scope="col">Kind</th><th scope="col">Records</th></tr></thead>
        <tbody>{rows.map(({ b, stage }) => (
          <tr key={b.id}>
            <th scope="row">{b.label}</th><td>{stage}</td>
            {explicit(b) ? <td data-state-text>{stateCell(b.row!)}</td> : <td className="num">{countOf(b)}</td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

/** The numbered PRISMA figure with its How we know panel (the selection row) and table view. */
export function PrismaFigure({ release, id, number }: { release: Release; id: string; number: number }) {
  const caption = `Figure ${number}. How launches were selected`
  return (
    <figure className="figure" id={id}>
      <figcaption>{caption}<span className="measure">Records at each stage of selection and the reasons for exclusion; reasons with fewer than 10 records are merged.</span></figcaption>
      <PrismaFlow id={`${id}-chart`} title={caption} prisma={release.prisma!} />
      <HowWeKnow id={id} rows={[
        { kind: 'n', text: `N = ${release.n} included launches.` },
        selectionRow(release), whoRow(release), releaseRow(release),
      ]} />
      <details className="table-view">
        <summary>Table view</summary>
        <PrismaTable prisma={release.prisma!} caption={caption} />
      </details>
    </figure>
  )
}
