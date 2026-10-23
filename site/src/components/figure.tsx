// A numbered figure: caption, chart, How we know and a table view (native <details>, readable with JS off).
// The unit that print keeps whole.
import type { ReactNode } from 'react'
import { ShareChart } from '../charts/share-chart'
import { release, stateCell, type Figure as FigureData } from '../data'
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

/** A statement's text with each `check-id` shown as its codebook short title, marked so the lint can skip it. */
export function StatementText({ text }: { text: string }) {
  // The title sits mid-sentence, so its own closing full stop is dropped.
  const titles = new Map(release?.methods.codebook.map(e => [e.checkId, e.shortTitle.replace(/\.$/, '')]))
  return <>{text.split(/(`[^`]+`)/).map((part, i) => {
    const id = /^`([^`]+)`$/.exec(part)?.[1]
    return id ? <span key={i} data-check-id={id}>{titles.get(id) ?? id}</span> : part
  })}</>
}

export function Figure({ id, number, figure, howWeKnow, children }: { id: string; number: number; figure: FigureData; howWeKnow: HowWeKnowRow[]; children?: ReactNode }) {
  return (
    <figure className="figure" id={id}>
      <figcaption>Figure {number}. {figure.title}<span className="measure">{figure.measure}</span></figcaption>
      <ShareChart id={`${id}-chart`} title={`Figure ${number}. ${figure.title}`} rows={figure.rows} />
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
