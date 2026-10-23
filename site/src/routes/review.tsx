import { createFileRoute } from '@tanstack/react-router'
import { release as loaded } from '../data'
import { Figure, figureNumber, NotReleased } from '../components/figure'
import { codedStateRows } from '../components/how-we-know'
import { Abstract } from '../sections'

export const Route = createFileRoute('/review')({
  head: () => ({ meta: [{ title: 'PRISM review: what AI launches publicly evidence' }] }),
  component: Review,
})

const H1 = 'PRISM review: what AI launches publicly evidence'

// The written review in systematic-review order (06-UI-SPEC "Review page order"). It is the only source of the
// PDF: scripts/render-pdf.mjs prints this page (D-73).
function Review() {
  const release = loaded
  if (!release) return <><h1>{H1}</h1><NotReleased /></>
  const decisions = release.figures.decisions
  const n = figureNumber(release, 'decisions')
  return (
    <>
      <p className="kicker">PRISM · Release {release.version} · {release.date} · N = {release.n} included launches</p>
      <h1>{H1}</h1>
      <Abstract release={release} />
      {decisions && <Figure id={`fig-${n}`} number={n} figure={decisions} howWeKnow={codedStateRows(release, decisions.rows)} />}
    </>
  )
}
