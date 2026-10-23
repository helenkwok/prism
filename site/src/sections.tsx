// Sections of the written review, shared by /review (the PDF source) and the /prisma, /validation and /methods
// pages. Every number comes from release.json or its manifest; nothing here is a literal finding.
import type { ReactNode } from 'react'
import { manifest, rowSentence, stateText, statementText, type Release, type Row } from './data'
import { StatementText } from './components/figure'
import { collectionRow, selectionRow } from './components/how-we-know'

const said = (id: string) => statementText(id) ?? ''
const finding = (release: Release, id: string) => release.statements.find(s => s.id === id && s.kind === 'finding')

/**
 * A review section. In the review it has an h2 and h3 sub-headings; on its own page (`top`) the page h1 stands in
 * for the h2 and the sub-headings move up to h2, so no heading level is skipped.
 */
function Section({ id, title, top, children }: { id: string; title: string; top?: boolean; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={top ? undefined : `${id}-h`} aria-label={top ? title : undefined}>
      {!top && <h2 id={`${id}-h`}>{title}</h2>}
      {children}
    </section>
  )
}
const Sub = ({ top, children }: { top?: boolean; children: ReactNode }) => (top ? <h2>{children}</h2> : <h3>{children}</h3>)

/** A row's value: the released share, or its explicit state as words (never a number for a hidden tuple). */
function Cell({ r }: { r: Row }) {
  const s = stateText(r)
  return s === null ? <td className="num">{r.pct}% ({r.c} of {r.n})</td> : <td data-state-text>{s}</td>
}

/** The manifest's process figures (D-83): published outside k = 10 under one addendum. */
const processFigures = () => manifest?.processFigures ?? []
const addenda = () => [...new Set(processFigures().map(p => p.addendum))].join(', ')
/** "screening error of the audited exclusions: a property of ..." -> "screening error of the audited exclusions". */
const processLabel = (reason: string) => reason.split(':')[0]!

/** 06-UI-SPEC item 1: a structured abstract assembled from the release's own statements. */
export function Abstract({ release }: { release: Release }) {
  const h = release.hypotheses
  const results = [h.h1, h.h3].map(x => finding(release, x.statementId)).filter(s => s !== undefined)
  return (
    <section aria-labelledby="abstract" data-abstract>
      <h2 id="abstract">Abstract</h2>
      <p><strong>Background.</strong> AI launch pages say a lot about how a product is built and checked. This review asks which checks launches publicly evidence on their own site or repository with an artefact linked, and which they only claim.</p>
      <p><strong>Methods.</strong> {said('method:frame')} {release.n} launches were included. Each of {release.methods.codebook.length} checks was coded by agent roles, every positive was confirmed by a separate role, and a deterministic gate decided each decision. {said('method:disclosure')}</p>
      <p><strong>Results.</strong> {results.map(s => <span key={s.id} data-finding><StatementText text={s.text} /> </span>)}</p>
      <p><strong>Limitations.</strong> {said('limitation:screening')} {said('limitation:not-done')}</p>
    </section>
  )
}

/** 06-UI-SPEC item 2. */
export function Introduction({ release }: { release: Release }) {
  const decisions = [...new Set(release.methods.codebook.map(e => e.decisionId))]
  return (
    <Section id="introduction" title="Introduction">
      <p>Launch pages for AI products make many statements about how a product is tested, limited, operated and measured. A reader deciding whether to explore, rely on or pay for a product needs to know which of those statements the launch backs with something they can inspect.</p>
      <p>PRISM reads each launch's own site and own repository and records, for each of {release.methods.codebook.length} checks grouped under {decisions.length} decisions ({decisions.map((d, i) => <span key={d}>{i ? ', ' : ''}<code>{d}</code></span>)}), whether the launch publicly evidences the check with an artefact linked, only claims it, or shows nothing. The questions, tests and thresholds were registered in the protocol before any launch was coded. The review reports aggregate figures only: no launch is named, counted alone or linked.</p>
    </Section>
  )
}

const MANIFEST_KEYS: Record<string, string> = { promptVersion: 'prompt', codebookVersion: 'codebook', seed: 'seed', tokenCap: 'token cap' }

/** 06-UI-SPEC item 3. */
export function MethodsSection({ release, top }: { release: Release; top?: boolean }) {
  const m = release.methods
  const process = processFigures()
  return (
    <Section id="methods" title="Methods" top={top}>
      <Sub top={top}>Eligibility</Sub>
      <p>{said('method:eligibility')}</p>
      <Sub top={top}>Sampling frame and window</Sub>
      <p>{said('method:frame')}</p>
      <Sub top={top}>Collection</Sub>
      <p>{said('method:collection')} {said('limitation:collector-change')}</p>
      <Sub top={top}>Coding states and the self-claim rule</Sub>
      <p>{said('method:self-claim')} Every check on every launch is in one of four states:</p>
      <ul className="findings-list">
        <li><code>pass</code>: publicly evidenced (artefact linked)</li>
        <li><code>claimed</code>: claimed, no artefact linked</li>
        <li><code>unknown</code>: no public evidence found</li>
        <li><code>fail</code>: own page shows the check is not met</li>
      </ul>
      <Sub top={top}>AI use</Sub>
      <p>Every role below is an agent, named by its model id and host. Agreement figures are agreement with an independent labeller.</p>
      <div className="table-scroll">
        <table className="data" data-ai-use>
          <caption>AI use: every role, its model, host and run settings</caption>
          <thead><tr><th scope="col">Role</th><th scope="col">Model id</th><th scope="col">Host</th><th scope="col">Run settings</th></tr></thead>
          <tbody>{m.roles.map(r => (
            <tr key={r.role}>
              <th scope="row">{r.role}</th><td>{r.modelId}</td><td>{r.host}</td>
              <td>{Object.entries(r.manifest).map(([k, v]) => `${MANIFEST_KEYS[k] ?? k} ${typeof v === 'number' ? v.toLocaleString('en') : v}`).join(' · ')}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Sub top={top}>Confirmation</Sub>
      <p>{said('method:confirmation')}</p>
      <Sub top={top}>The deterministic gate</Sub>
      <p>{said('method:gate')}</p>
      <Sub top={top}>Disclosure control</Sub>
      <p data-disclosure>k = {m.disclosure.floor}. {said('method:disclosure')} The complement clause applies: a count whose complement is under {m.disclosure.floor} is suppressed even when the count itself is not.</p>
      {process.length > 0 && <p data-process-exception>Exception (addendum {addenda()}): {process.length} process figures describe the instrument, not any launch, and are published outside the k = {m.disclosure.floor} rule: {process.map(p => processLabel(p.reason)).join('; ')}. Per-check precision and per-check changes at confirmation stay under the rule.</p>}
      <Sub top={top}>Hypotheses and tests</Sub>
      <p>{said('method:hypotheses')} {said('method:sensitivity')}</p>
      <Sub top={top}>Release ledger</Sub>
      <p>Release {release.version} is recorded in disclosure ledger {m.ledgerVersion}: later releases are audited against every figure already published, so no hidden count can be worked out by comparing releases.</p>
    </Section>
  )
}

/** The value of each D-83 process figure, by manifest id. */
const PROCESS_TEXT: Record<string, (r: Release) => string> = {
  'screening-audit': r => selectionRow(r).text,
  'collection-recall': r => collectionRow(r).text,
  'person-edits': r => `${r.howWeKnow.personEdits.count} of ${r.howWeKnow.personEdits.total} labels edited by a person. ${said('validation:person-edits')}`,
  'confirmation-total': r => {
    const c = r.howWeKnow.confirmation
    return `${c.total.changed} of ${c.total.proposed} proposed positives (${c.total.pct}%) changed at confirmation: ${rowSentence(c.rejected)}; ${rowSentence(c.downgraded)}.`
  },
}

/** 06-UI-SPEC item 5 (and /validation): agreement per check, then the process figures under their addendum. */
export function ValidationSection({ release }: { release: Release }) {
  const h = release.howWeKnow
  const perCheck = h.confirmation.perCheck ?? {}
  const ac1 = (id: string) => {
    const a = h.agreement[id]
    return a?.ac1 == null ? <td data-state-text>not estimable</td> : <td className="num">{a.ac1.toFixed(2)} ({a.ac1CI![0].toFixed(2)}–{a.ac1CI![1].toFixed(2)})</td>
  }
  return (
    <Section id="validation" title="Validation">
      <h3>Agreement with an independent labeller</h3>
      <p>Labeller: {h.labeller.modelId} on {h.labeller.host}. Confirmer: {h.confirmer.modelId} on {h.confirmer.host}. Pass precision and the changes at confirmation per check are counts of launches and stay under disclosure control, so a small or suppressed value reads as words.</p>
      <div className="table-scroll">
        <table className="data" data-agreement>
          <caption>Agreement, pass precision and changes at confirmation, per check</caption>
          <thead><tr><th scope="col">Check</th><th scope="col">AC1 (95% CI)</th><th scope="col">Pass precision</th><th scope="col">Changed at confirmation</th></tr></thead>
          <tbody>{release.methods.codebook.map(e => (
            <tr key={e.checkId}>
              <th scope="row">{e.shortTitle}</th>
              {ac1(e.checkId)}
              {h.agreement[e.checkId] ? <Cell r={h.agreement[e.checkId]!.precision} /> : <td data-state-text>not estimable</td>}
              {perCheck[e.checkId] ? <Cell r={perCheck[e.checkId]!} /> : <td data-state-text>not in this release</td>}
            </tr>
          ))}</tbody>
        </table>
      </div>
      {processFigures().length > 0 && <>
        <h3>Process figures (addendum {addenda()})</h3>
        <dl className="process-figures" data-process-figures>{processFigures().map(p => (
          <div key={p.id}>
            <dt>{processLabel(p.reason)}</dt>
            <dd>{PROCESS_TEXT[p.id]?.(release)} <span className="muted">Published under addendum {p.addendum}, outside the k = {release.methods.disclosure.floor} rule: {p.reason.slice(processLabel(p.reason).length + 2)}.</span></dd>
          </div>
        ))}</dl>
      </>}
    </Section>
  )
}

// Limitations that carry a related exploratory result or released row in the same item (06-UI-SPEC § Limitations).
const WITH: Record<string, string> = { 'limitation:screening': 'exploratory:screening-remeasure', 'limitation:collector-change': 'exploratory:collector-cross-check' }

/** 06-UI-SPEC item 6 / D-76: every limitation statement in the release, in its order. */
export function LimitationsSection({ release }: { release: Release }) {
  const visibility = release.validation?.visibility
  return (
    <Section id="limitations" title="Limitations">
      <ol className="findings-list" data-limitations>{release.statements.filter(s => s.kind === 'limitation').map(s => (
        <li key={s.id}>
          {s.text}{WITH[s.id] && ` ${said(WITH[s.id]!)}`}
          {visibility?.statementId === s.id && ` ${rowSentence(visibility.row)}.`}
        </li>
      ))}</ol>
    </Section>
  )
}

/** 06-UI-SPEC item 7: each block headed "Exploratory"; nothing here feeds a published figure. */
export function ExploratorySection() {
  const blocks: [string, string][] = [
    ['Exploratory: collector cross-check (addendum A8)', said('exploratory:collector-cross-check')],
    ['Exploratory: whole-page-span archive (addendum A9)', said('limitation:whole-page-spans')],
    ['Exploratory: screening re-measure', said('exploratory:screening-remeasure')],
    ['Exploratory: community layer (addendum A4)', said('exploratory:community')],
  ]
  return (
    <Section id="exploratory" title="Exploratory analyses">
      {blocks.filter(([, text]) => text).map(([title, text]) => <div key={title} data-exploratory><h3>{title}</h3><p>{text}</p></div>)}
    </Section>
  )
}
