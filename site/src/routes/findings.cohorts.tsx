import { createFileRoute } from '@tanstack/react-router'
import { release as loaded, statementText } from '../data'
import { Figure, figureNumber, GroupTable, NotReleased } from '../components/figure'
import { codedStateRows } from '../components/how-we-know'

export const Route = createFileRoute('/findings/cohorts')({
  head: () => ({ meta: [{ title: 'Evidence by launch cohort · PRISM' }] }),
  component: Cohorts,
})

// Protocol section 7: bars per quarter in the export's calendar order, never a line, slope, delta or change figure.
function Cohorts() {
  const release = loaded
  const keys = release ? Object.keys(release.figures).filter(k => k.startsWith('cohorts:')) : []
  if (!release || !keys.length) return <><h1>Evidence by launch cohort</h1><NotReleased /></>
  const banner = statementText('method:cohort-banner')
  const table = release.figures.checksByCohort
  return (
    <>
      <p className="kicker">PRISM · Release {release.version}</p>
      <h1>Evidence by launch cohort</h1>
      {banner && <p className="rounded-lg bg-muted p-4" data-cohort-banner>{banner}</p>}
      {keys.map(key => {
        const f = release.figures[key]!
        // "quarter 1" -> "Launched in quarter 1, as evidenced today" (the release's own cohort title).
        const rows = f.rows.map(r => ({ ...r, label: statementText(`cohort:${r.label}`)?.replace(/\.$/, '') ?? r.label }))
        const n = figureNumber(release, key)
        return <Figure key={key} id={`fig-${n}`} number={n} figure={{ ...f, rows }} howWeKnow={codedStateRows(release, f.rows)} />
      })}
      {table && <section><h2>Checks by launch cohort</h2><GroupTable figure={table} /></section>}
    </>
  )
}
