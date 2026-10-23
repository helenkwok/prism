import { createFileRoute } from '@tanstack/react-router'
import { checkIdOf, release, type Row } from '../data'
import { Figure, figureNumber, NotReleased, StatementText } from '../components/figure'
import { codedStateRows } from '../components/how-we-know'

export const Route = createFileRoute('/findings/claims')({
  head: () => ({ meta: [{ title: 'Claims and evidence · PRISM' }] }),
  component: Claims,
})

// 06-UI-SPEC claims sentence, written only where both shares of a check are released.
function claimSentence(claimed: Row, pass: Row) {
  return `${claimed.c} of ${claimed.n} launches claim \`${checkIdOf(claimed.id)}\` without linking an artefact (${claimed.pct}%); ${pass.c} of ${pass.n} publicly evidence it (${pass.pct}%).`
}

function Claims() {
  const figure = release?.figures.claims
  if (!release || !figure) return <><h1>Claims and evidence</h1><NotReleased /></>
  const n = figureNumber(release, 'claims')
  const sentences = figure.rows.flatMap(claimed => {
    const pass = figure.rows.find(r => r.id === claimed.id.replace('|claimed|', '|pass|'))
    return claimed.id.split('|')[2] === 'claimed' && claimed.state === 'released' && pass?.state === 'released' ? [claimSentence(claimed, pass)] : []
  })
  const h1Id = release.hypotheses.h1.statementId
  const h1 = release.statements.find(s => s.id === h1Id && s.kind === 'finding')
  const findings = [...(h1 ? [h1.text] : []), ...sentences]
  return (
    <>
      <p className="kicker">PRISM · Release {release.version}</p>
      <h1>Claims and evidence</h1>
      <p>For each check, the red bar is the share of launches that claim it without linking an artefact, and the blue bar the share that publicly evidence it with an artefact linked. Both share one denominator: all {release.n} included launches.</p>
      <Figure id={`fig-${n}`} number={n} figure={figure} howWeKnow={codedStateRows(release, figure.rows)} chart={{ paired: true }}>
        {findings.length > 0 && <ul className="findings-list">{findings.map(text => <li key={text} data-finding><StatementText text={text} /></li>)}</ul>}
      </Figure>
    </>
  )
}
