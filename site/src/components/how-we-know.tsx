// "How we know" (D-74, PUB-06, 06-UI-SPEC): under every chart, inside its <figure>. Every value comes from
// release.json; model ids and hosts are data, never literals here.
import { checkIdOf, stateText, type Release, type Row } from '../data'

export type HowWeKnowKind = 'n' | 'agreement' | 'confirmation' | 'who' | 'sensitivity' | 'selection' | 'collection' | 'release'
export interface HowWeKnowRow { kind: HowWeKnowKind; text: string }

const LABELS: Record<HowWeKnowKind, string> = {
  n: 'Launches counted',
  agreement: 'Agreement',
  confirmation: 'Changed at confirmation',
  who: 'Who checked',
  sensitivity: 'Sensitivity',
  selection: 'Selection',
  collection: 'Collection',
  release: 'Release',
}
const ORDER = Object.keys(LABELS) as HowWeKnowKind[]

/** Renders the rows whose data exists, in the UI-SPEC order. */
export function HowWeKnow({ id, rows }: { id: string; rows: HowWeKnowRow[] }) {
  const shown = ORDER.flatMap(kind => rows.filter(r => r.kind === kind && r.text))
  return (
    <aside className="how-we-know" aria-labelledby={`${id}-hwk`}>
      <h3 id={`${id}-hwk`}>How we know</h3>
      <dl>{shown.map(r => <div key={r.kind} className="contents"><dt>{LABELS[r.kind]}</dt><dd>{r.text}</dd></div>)}</dl>
    </aside>
  )
}

const share = (r: Row) => (r.state === 'released' ? `${r.pct}%` : stateText(r))
const by = (a: { modelId: string; host: string }) => `${a.modelId} on ${a.host}`

/** The rows every coded-state figure carries: n, agreement over the shown checks, confirmation, who, release. */
export function codedStateRows(release: Release, rows: Row[]): HowWeKnowRow[] {
  const h = release.howWeKnow
  const ids = [...new Set(rows.map(r => checkIdOf(r.id)))].filter(id => h.agreement[id])
  let agreement = ''
  if (ids.length === 1) {
    const a = h.agreement[ids[0]!]!
    const p = a.precision
    const ac1 = a.ac1 === null ? 'AC1 not estimable' : `AC1 ${a.ac1.toFixed(2)} (95% CI ${a.ac1CI![0].toFixed(2)}–${a.ac1CI![1].toFixed(2)})`
    const pp = p.state === 'released' ? `pass precision ${p.pct}% (${p.c} of ${p.n})` : `pass precision ${stateText(p)}`
    agreement = `Agreement with an independent labeller: ${ac1}; ${pp}. Labeller: ${by(h.labeller)}.`
  } else if (ids.length > 1) {
    const values = ids.map(id => h.agreement[id]!.ac1).filter((v): v is number => v !== null)
    const missing = ids.length - values.length
    const [lo, hi] = [Math.min(...values).toFixed(2), Math.max(...values).toFixed(2)]
    const range = !values.length ? 'AC1 not estimable for the shown checks' : `AC1 ${lo === hi ? lo : `${lo}–${hi}`} across the shown checks`
    agreement = `Agreement with an independent labeller: ${range}${missing && values.length ? ` (not estimable for ${missing})` : ''}; per check on the Validation page. Labeller: ${by(h.labeller)}.`
  }
  const c = h.confirmation
  const edits = h.personEdits
  const edited = edits.total ? Math.round((edits.count / edits.total) * 1000) / 10 : 0
  return [
    { kind: 'n', text: `N = ${h.n} included launches. Launches with no evidence found stay in the denominator.` },
    { kind: 'agreement', text: agreement },
    { kind: 'confirmation', text: `${c.total.pct}% of proposed positives changed at confirmation (${share(c.rejected)} rejected, ${share(c.downgraded)} downgraded to claimed). Confirmer: ${by(h.confirmer)}.` },
    { kind: 'who', text: edits.count === 0 ? 'Agent roles, no human edits. Share human-edited: 0%.' : `Agent roles. Share human-edited: ${edited}%.` },
    { kind: 'release', text: `Release ${release.version}, ${release.date}. Data: public-data/release.json.` },
  ]
}
