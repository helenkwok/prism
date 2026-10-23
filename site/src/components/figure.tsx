// A numbered figure: caption, chart, How we know and a table view (native <details>, readable with JS off).
// The unit that print keeps whole.
import type { ReactNode } from 'react'
import { ShareChart, type ChartOptions } from '../charts/share-chart'
import { release, stateCell, type Figure as FigureData, type Release } from '../data'
import { useExisting } from '../pages'
import { HowWeKnow, type HowWeKnowRow } from './how-we-know'

/** 06-UI-SPEC empty state: findings routes with no release yet. */
export function NotReleased() {
  const methods = useExisting([['Read the methods', '/methods']] as const)
  return (
    <section data-empty-state>
      <h2>Findings not yet released</h2>
      <p>The figures appear here once the validation gate has been passed and the release has cleared disclosure control. The methods and the protocol are available now.</p>
      {methods.map(([label, href]) => <p key={href}><a href={href}>{label}</a></p>)}
    </section>
  )
}

// Figures are numbered once, in the review's Results order (06-UI-SPEC), so "Figure 7" is the same figure on
// the dashboard and in the review. Key groups: "prisma" (release.prisma), then release.figures keys.
const FIGURE_GROUPS = ['prisma', 'checks', 'decisions', 'sources', 'cohorts', 'claims', 'sourceTypes']

/** Every numbered figure key in order. */
export function figureKeys(r: Release) {
  const keys = ['prisma', ...Object.keys(r.figures)].filter(k => k !== 'prisma' || (r as { prisma?: unknown }).prisma)
  return FIGURE_GROUPS.flatMap(g => keys.filter(k => k === g || k.startsWith(`${g}:`)))
}

/** The figure's number, from 1, in the order above. */
export const figureNumber = (r: Release, key: string) => figureKeys(r).indexOf(key) + 1

/** A statement's text with each `check-id` (or `decision-id`) shown as its short title, marked so the lint can skip it. */
export function StatementText({ text }: { text: string }) {
  // The title sits mid-sentence, so its own closing full stop is dropped.
  const titles = new Map([
    ...(release?.figures.decisions?.rows.map(r => [r.id.split('|')[1]!, r.label] as const) ?? []),
    ...(release?.methods.codebook.map(e => [e.checkId, e.shortTitle.replace(/\.$/, '')] as const) ?? []),
  ])
  return <>{text.split(/(`[^`]+`)/).map((part, i) => {
    const id = /^`([^`]+)`$/.exec(part)?.[1]
    return id ? <span key={i} data-check-id={id}>{titles.get(id) ?? id}</span> : part
  })}</>
}

export function Figure({ id, number, figure, howWeKnow, chart, children }: { id: string; number: number; figure: FigureData; howWeKnow: HowWeKnowRow[]; chart?: ChartOptions; children?: ReactNode }) {
  return (
    <figure className="figure" id={id}>
      <figcaption>Figure {number}. {figure.title}<span className="measure">{figure.measure}</span></figcaption>
      <ShareChart id={`${id}-chart`} title={`Figure ${number}. ${figure.title}`} rows={figure.rows} {...chart} />
      <HowWeKnow id={id} rows={howWeKnow} />
      {children}
      <details className="table-view">
        <summary>Table view</summary>
        <div className="table-scroll">
          <table className="data">
            <caption>Figure {number}. {figure.title}</caption>
            <thead><tr><th scope="col">Row</th><th scope="col">Launches</th><th scope="col">Share</th><th scope="col">95% CI</th></tr></thead>
            <tbody>{figure.rows.map(r => (
              <tr key={r.id}>
                <th scope="row">{r.label}{r.note ? <span className="muted"> ({r.note})</span> : null}</th>
                {r.state === 'released'
                  ? <><td className="num">{stateCell(r)}</td><td className="num">{r.pct}%</td><td className="num">{r.ci![0]}–{r.ci![1]}%</td></>
                  : <td colSpan={3} data-state-text>{stateCell(r)}</td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}
