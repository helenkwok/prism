import { createFileRoute } from '@tanstack/react-router'
import { release, statementText } from '../data'
import { Figure, figureNumber, NotReleased } from '../components/figure'
import { codedStateRows, collectionRow } from '../components/how-we-know'

export const Route = createFileRoute('/findings/source-types')({
  head: () => ({ meta: [{ title: 'Where launches put their evidence · PRISM' }] }),
  component: SourceTypes,
})

// Rows arrive from the export as the top source types then "other source types" (st|other|...), drawn neutral.
function SourceTypes() {
  const figure = release?.figures.sourceTypes
  if (!release || !figure) return <><h1>Where launches put their evidence</h1><NotReleased /></>
  const n = figureNumber(release, 'sourceTypes')
  const overlap = statementText('method:source-types-overlap')
  const howWeKnow = [...codedStateRows(release, figure.rows, release.methods.codebook.map(e => e.checkId)), collectionRow(release)]
  return (
    <>
      <p className="kicker">PRISM · Release {release.version}</p>
      <h1>Where launches put their evidence</h1>
      <p>Each bar is the share of all {release.n} included launches with at least one confirmed positive quoted from that type of source.</p>
      {overlap && <p data-overlap-note>{overlap}</p>}
      <Figure id={`fig-${n}`} number={n} figure={figure} howWeKnow={howWeKnow}
        chart={{ neutral: figure.rows.filter(r => r.id.split('|')[1] === 'other').map(r => r.id) }} />
    </>
  )
}
