import { createFileRoute } from '@tanstack/react-router'
import { checkIdOf, release, type Figure as FigureData } from '../data'
import { Figure, figureNumber, NotReleased, StatementText } from '../components/figure'
import { codedStateRows } from '../components/how-we-know'

export const Route = createFileRoute('/findings/checks')({
  head: () => ({ meta: [{ title: 'Evidence by check · PRISM' }] }),
  component: Checks,
})

function Checks() {
  if (!release) return <><h1>Evidence by check</h1><NotReleased /></>
  // One figure per decision ("checks:<decisionId>"), or the single "checks" figure of an early release.
  const figures = Object.keys(release.figures).filter(key => key === 'checks' || key.startsWith('checks:'))
  return (
    <>
      <p className="kicker">PRISM · Release {release.version}</p>
      <h1>Evidence by check</h1>
      <p>Each bar is the share of all {release.n} included launches that publicly evidence the check with an artefact linked. Launches with no public evidence found stay in every denominator.</p>
      {figures.map(key => <CheckFigure key={key} figure={release.figures[key]!} number={figureNumber(release, key)} />)}
    </>
  )
}

function CheckFigure({ figure, number }: { figure: FigureData; number: number }) {
  const checks = new Set(figure.rows.map(r => checkIdOf(r.id)))
  const findings = release!.statements.filter(s => s.kind === 'finding' && s.id.startsWith('share:') && checks.has(s.id.slice('share:'.length)))
  return (
    <Figure id={`fig-${number}`} number={number} figure={figure} howWeKnow={codedStateRows(release!, figure.rows)}>
      {findings.length > 0 && <ul className="findings-list">{findings.map(s => <li key={s.id} data-finding><StatementText text={s.text} /></li>)}</ul>}
    </Figure>
  )
}
