// Sections of the written review, shared by /review (the PDF source) and the /prisma, /validation and /methods
// pages. Every number comes from release.json or its manifest; nothing here is a literal finding.
import { statementText, type Release } from './data'
import { StatementText } from './components/figure'

const said = (id: string) => statementText(id) ?? ''
const finding = (release: Release, id: string) => release.statements.find(s => s.id === id && s.kind === 'finding')

/** 06-UI-SPEC item 1: a structured abstract assembled from the release's own statements. */
export function Abstract({ release }: { release: Release }) {
  const h = release.hypotheses
  const results = [h.h1, h.h3].map(x => finding(release, x.statementId)).filter(s => s !== undefined)
  return (
    <section aria-labelledby="abstract" data-abstract>
      <h2 id="abstract">Abstract</h2>
      <p><strong>Background.</strong> AI products launch in public every week, and their pages often say how they are built and checked. This review asks what those launches publicly evidence: which checks a launch's own site or repository shows with an artefact linked, and which it only claims.</p>
      <p><strong>Methods.</strong> {said('method:frame')} {release.n} launches were included. Each of {release.methods.codebook.length} checks was coded by agent roles, every positive was confirmed by a separate role, and a deterministic gate decided each decision. {said('method:disclosure')}</p>
      <p><strong>Results.</strong> {results.map(s => <span key={s.id} data-finding><StatementText text={s.text} /> </span>)}</p>
      <p><strong>Limitations.</strong> {said('limitation:screening')} {said('limitation:not-done')}</p>
    </section>
  )
}
