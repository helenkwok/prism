import { createFileRoute } from '@tanstack/react-router'
import { release as loaded } from '../data'
import { NotReleased } from '../components/figure'
import { Abstract, AppendixA, AppendixB, AppendixC, ExploratorySection, Introduction, LimitationsSection, MethodsSection, ResultsSection, ValidationSection } from '../sections'

export const Route = createFileRoute('/review')({
  head: () => ({ meta: [{ title: 'PRISM review: what AI launches publicly evidence' }] }),
  component: Review,
})

const H1 = 'PRISM review: what AI launches publicly evidence'

// The written review in systematic-review order (06-UI-SPEC "Review page order"). It is the only source of the
// PDF: scripts/render-pdf.mjs prints this page (D-73). No worked case appears here (D-77).
function Review() {
  const release = loaded
  if (!release) return <><h1>{H1}</h1><NotReleased /></>
  return (
    <>
      <p className="kicker">PRISM · Release {release.version} · {release.date} · N = {release.n} included launches</p>
      <h1>{H1}</h1>
      <Abstract release={release} />
      <Introduction release={release} />
      <MethodsSection release={release} />
      <ResultsSection release={release} />
      <ValidationSection release={release} />
      <LimitationsSection release={release} />
      <ExploratorySection />
      <AppendixA release={release} />
      <AppendixB release={release} />
      <AppendixC release={release} />
    </>
  )
}
