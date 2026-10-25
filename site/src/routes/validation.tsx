import { createFileRoute } from '@tanstack/react-router'
import { release as loaded } from '../data'
import { NotReleased } from '../components/figure'
import { ExploratorySection, LimitationsSection, ValidationSection } from '../sections'

export const Route = createFileRoute('/validation')({
  head: () => ({ meta: [{ title: 'How the coding was checked, and its limits · PRISM' }] }),
  component: Validation,
})

const H1 = 'How the coding was checked, and its limits'

// The review's validation, limitations and exploratory sections (06-UI-SPEC Page Inventory).
function Validation() {
  const release = loaded
  if (!release) return <><h1>{H1}</h1><NotReleased /></>
  return (
    <>
      <p className="kicker">PRISM · Release {release.version}</p>
      <h1>{H1}</h1>
      <ValidationSection release={release} />
      <LimitationsSection release={release} />
      <ExploratorySection />
    </>
  )
}
