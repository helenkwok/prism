import { createFileRoute } from '@tanstack/react-router'
import { release } from '../data'
import { Figure, figureNumber, NotReleased, StatementText } from '../components/figure'
import { codedStateRows } from '../components/how-we-know'

export const Route = createFileRoute('/findings/decisions')({
  head: () => ({ meta: [{ title: 'Evidence by decision · PRISM' }] }),
  component: Decisions,
})

function Decisions() {
  const figure = release?.figures.decisions
  if (!release || !figure) return <><h1>Evidence by decision</h1><NotReleased /></>
  const n = figureNumber(release, 'decisions')
  const findings = release.statements.filter(s => s.kind === 'finding' && s.id.startsWith('decision:'))
  return (
    <>
      <p className="kicker">PRISM · Release {release.version}</p>
      <h1>Evidence by decision</h1>
      <p>Each bar is the share of all {release.n} included launches whose confirmed check states let the deterministic gate support the decision on public evidence. The gate, not a model, decides.</p>
      <Figure id={`fig-${n}`} number={n} figure={figure} howWeKnow={codedStateRows(release, figure.rows)}>
        {findings.length > 0 && <ul className="findings-list">{findings.map(s => <li key={s.id} data-finding><StatementText text={s.text} /></li>)}</ul>}
      </Figure>
    </>
  )
}
