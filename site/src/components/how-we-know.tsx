// "How we know" (D-74, PUB-06, 06-UI-SPEC): under every chart, inside its <figure>. Every value comes from
// release.json; model ids and hosts are data, never literals here.
import { checkIdOf, shareText, stateText, statementText, type Release, type Row } from '../data'
import { useExisting } from '../pages'

export type HowWeKnowKind = 'n' | 'agreement' | 'confirmation' | 'who' | 'sensitivity' | 'selection' | 'collection' | 'release'
/** `link` turns the words `link[0]` inside the text into a link to `link[1]`, once that page exists. */
export interface HowWeKnowRow { kind: HowWeKnowKind; text: string; link?: readonly [string, string] }

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
const VALIDATION = ['the Validation page', '/validation'] as const

/** Renders the rows whose data exists, in the UI-SPEC order. */
export function HowWeKnow({ id, rows }: { id: string; rows: HowWeKnowRow[] }) {
  const shown = ORDER.flatMap(kind => rows.filter(r => r.kind === kind && r.text))
  const pages = new Set(useExisting([VALIDATION]).map(([, href]) => href))
  return (
    <aside className="how-we-know" aria-labelledby={`${id}-hwk`}>
      <h3 id={`${id}-hwk`}>How we know</h3>
      <dl>{shown.map(r => <div key={r.kind} className="contents"><dt>{LABELS[r.kind]}</dt><dd>{linked(r, pages)}</dd></div>)}</dl>
    </aside>
  )
}

function linked(r: HowWeKnowRow, pages: Set<string>) {
  const at = r.link ? r.text.indexOf(r.link[0]) : -1
  if (!r.link || at < 0 || !pages.has(r.link[1])) return r.text
  return <>{r.text.slice(0, at)}<a href={r.link[1]}>{r.link[0]}</a>{r.text.slice(at + r.link[0].length)}</>
}

const share = (r: Row) => (r.state === 'released' ? `${r.pct}%` : stateText(r))
const by = (a: { modelId: string; host: string }) => `${a.modelId} on ${a.host}`

/** The checks behind a figure's rows: a check row counts itself, a decision row counts the decision's checks. */
function checksOf(release: Release, rows: Row[]) {
  const ids = new Set(rows.map(r => checkIdOf(r.id)))
  return release.methods.codebook.filter(e => ids.has(e.checkId) || ids.has(e.decisionId)).map(e => e.checkId)
}

function agreementText(release: Release, checkIds: string[]) {
  const h = release.howWeKnow
  const ids = checkIds.filter(id => h.agreement[id])
  if (ids.length === 1) {
    const a = h.agreement[ids[0]!]!
    const p = a.precision
    const ac1 = a.ac1 === null ? 'AC1 not estimable' : `AC1 ${a.ac1.toFixed(2)} (95% CI ${a.ac1CI![0].toFixed(2)}–${a.ac1CI![1].toFixed(2)})`
    const pp = p.state === 'released' ? `pass precision ${p.pct}% (${p.c} of ${p.n})` : `pass precision ${stateText(p)}`
    const limitation = a.status === 'not-estimable' ? `${a.note}. Descriptive figures: ` : ''
    return `Agreement with an independent labeller: ${limitation}${ac1}; ${pp}. Labeller: ${by(h.labeller)}.`
  }
  if (!ids.length) return ''
  const values = ids.map(id => h.agreement[id]!.ac1).filter((v): v is number => v !== null)
  const missing = ids.length - values.length
  const rare = ids.filter(id => h.agreement[id]!.status === 'not-estimable').length
  const limitation = rare ? ` Agreement not estimable for ${rare} shown ${rare === 1 ? 'check' : 'checks'} (fewer than ten gold passes); those figures are descriptive.` : ''
  const [lo, hi] = [Math.min(...values).toFixed(2), Math.max(...values).toFixed(2)]
  const range = !values.length ? 'AC1 not estimable for the shown checks' : `AC1 ${lo === hi ? lo : `${lo}–${hi}`} across the shown checks`
  return `Agreement with an independent labeller: ${range}${missing && values.length ? ` (not estimable for ${missing})` : ''}; per check on the Validation page.${limitation} Labeller: ${by(h.labeller)}.`
}

/**
 * The rows every coded-state figure carries: n, agreement over the checks behind the rows (or `checkIds`),
 * changed at confirmation, who checked, sensitivity where the release repeats a row without the unread sites, release.
 */
export function codedStateRows(release: Release, rows: Row[], checkIds = checksOf(release, rows)): HowWeKnowRow[] {
  const h = release.howWeKnow
  const c = h.confirmation
  return [
    { kind: 'n', text: `N = ${h.n} included launches. Launches with no evidence found stay in the denominator.` },
    { kind: 'agreement', text: agreementText(release, checkIds), link: VALIDATION },
    { kind: 'confirmation', text: `${c.total.pct}% of proposed positives changed at confirmation (${share(c.rejected)} rejected, ${share(c.downgraded)} downgraded to claimed). Confirmer: ${by(h.confirmer)}.` },
    whoRow(release),
    sensitivityRow(release, rows),
    releaseRow(release),
  ]
}

/** Who checked: the release's own statement plus the share of human edits computed from its counts. */
export function whoRow(release: Release): HowWeKnowRow {
  const { count, total } = release.howWeKnow.personEdits
  const edited = total ? Math.round((count / total) * 1000) / 10 : 0
  return { kind: 'who', text: [statementText('validation:person-edits'), `Share human-edited: ${edited}%.`].filter(Boolean).join(' ') }
}

/** Protocol section 3: each shown row repeated without the launches whose site could not be read. */
export function sensitivityRow(release: Release, rows: Row[]): HowWeKnowRow {
  const sens = rows.flatMap(r => {
    const s = release.sensitivity.rows[`${r.id}|sens`]
    return s ? [{ label: r.label, s }] : []
  })
  if (!sens.length) return { kind: 'sensitivity', text: '' }
  const parts = sens.length === 1 ? [shareText(sens[0]!.s)] : sens.map(({ label, s }) => `${label}: ${shareText(s)}`)
  return { kind: 'sensitivity', text: `Excluding the ${release.sensitivity.excluded} launches whose site could not be read: ${parts.join('; ')}.` }
}

export function releaseRow(release: Release): HowWeKnowRow {
  return { kind: 'release', text: `Release ${release.version}, ${release.date}. Data: public-data/release.json.` }
}

/** PrismaFlow (plan 07): the screening-error row against its pre-registered target. */
export function selectionRow(release: Release): HowWeKnowRow {
  const s = release.validation?.screeningAudit
  if (!s) return { kind: 'selection', text: '' }
  const side = s.pct > s.bar ? `above the ${s.bar}% target; see Limitations` : `within the ${s.bar}% target`
  return { kind: 'selection', text: `Screening error ${s.pct}% (${s.errors} of ${s.audited}, 95% CI ${s.ci[0]}–${s.ci[1]}%), ${side}.` }
}

/** Source-type figure: supported and raw collection recall. */
export function collectionRow(release: Release): HowWeKnowRow {
  const c = release.validation?.collectionRecall
  if (!c) return { kind: 'collection', text: '' }
  return { kind: 'collection', text: `Supported recall ${c.recall} (${c.supportedFound} of ${c.supported}); raw recall ${c.rawRecall} (${c.rawFound} of ${c.raw}).` }
}
