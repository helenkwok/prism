import { createFileRoute } from '@tanstack/react-router'
import { release as loaded } from '../data'
import { Figure, figureNumber, GroupTable, NotReleased, StatementText } from '../components/figure'
import { codedStateRows } from '../components/how-we-know'

export const Route = createFileRoute('/findings/sources')({
  head: () => ({ meta: [{ title: 'Evidence by discovery source · PRISM' }] }),
  component: Sources,
})

// D-75: absent groups and small groups arrive from the export as explicit rows; H2 is either the test result
// (a finding) or the descriptive line (method text), whichever statement the release names.
function Sources() {
  const release = loaded
  const keys = release ? Object.keys(release.figures).filter(k => k.startsWith('sources:')) : []
  if (!release || !keys.length) return <><h1>Evidence by discovery source</h1><NotReleased /></>
  const h2 = release.statements.find(s => s.id === release.hypotheses.h2.statementId)
  const table = release.figures.checksBySource
  return (
    <>
      <p className="kicker">PRISM · Release {release.version}</p>
      <h1>Evidence by discovery source</h1>
      <p>Each bar is the share of one discovery source's included launches. A source with no included launches is shown as not in this release, and small groups as &lt;10 or suppressed.</p>
      {h2 && (h2.kind === 'finding'
        ? <p data-finding data-h2-status><StatementText text={h2.text} /></p>
        : <p data-h2-status>{h2.text}</p>)}
      {keys.map(key => {
        const f = release.figures[key]!
        const n = figureNumber(release, key)
        return <Figure key={key} id={`fig-${n}`} number={n} figure={f} howWeKnow={codedStateRows(release, f.rows)} />
      })}
      {table && <section><h2>Checks by discovery source</h2><GroupTable figure={table} /></section>}
    </>
  )
}
