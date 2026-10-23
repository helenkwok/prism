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

const lastParen = (label: string) => {
  const m = / \(([^()]+)\)$/.exec(label)
  return m ? [label.slice(0, m.index), m[1]!] as const : [label, ''] as const
}

/**
 * Check-level shares by group (cohort or source) as one table: a row per check and state, a column per group,
 * from rows "chk|<checkId>|<state>|<group>" labelled "<title> (<state>) (<group>)". Explicit states stay words.
 */
export function GroupTable({ figure }: { figure: FigureData }) {
  const titles = new Map(release?.methods.codebook.map(e => [e.checkId, e.shortTitle]))
  const columns = [...new Map(figure.rows.map(r => [r.id.split('|')[3]!, lastParen(r.label)[1]])).entries()]
  const lines = new Map<string, { head: string; cells: Map<string, FigureData['rows'][number]> }>()
  for (const r of figure.rows) {
    const [, check, state, group] = r.id.split('|')
    const key = `${check}|${state}`
    if (!lines.has(key)) lines.set(key, { head: `${titles.get(check!) ?? check} (${lastParen(lastParen(r.label)[0])[1]})`, cells: new Map() })
    lines.get(key)!.cells.set(group!, r)
  }
  return (
    <details className="table-view">
      <summary>Table view: {figure.title.toLowerCase()}</summary>
      <div className="table-scroll">
        <table className="data">
          <caption>{figure.title}: {figure.measure}.</caption>
          <thead><tr><th scope="col">Check</th>{columns.map(([id, label]) => <th key={id} scope="col">{label}</th>)}</tr></thead>
          <tbody>{[...lines].map(([key, line]) => (
            <tr key={key}>
              <th scope="row">{line.head}</th>
              {columns.map(([id]) => {
                const r = line.cells.get(id)
                if (!r) return <td key={id} />
                return r.state === 'released'
                  ? <td key={id} className="num">{stateCell(r)} ({r.pct}%)</td>
                  : <td key={id} data-state-text>{stateCell(r)}</td>
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </details>
  )
}
