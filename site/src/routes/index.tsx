import { createFileRoute } from '@tanstack/react-router'
import { release as loaded } from '../data'
import { NotReleased } from '../components/figure'
import { HowWeKnow, codedStateRows } from '../components/how-we-know'
import { StatTile } from '../components/stat-tile'
import { buttonVariants } from '../components/ui/button'
import { FINDINGS_NAV, MAIN_NAV, useExisting } from '../pages'

export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: 'What AI launches publicly evidence · PRISM' }] }),
  component: Home,
})

const H2_TITLE = 'Evidence by discovery source'

function Home() {
  const release = loaded
  const links = useExisting([...FINDINGS_NAV, ...MAIN_NAV.filter(([, href]) => href !== '/findings/checks')] as const)
  const statement = (id: string) => release?.statements.find(s => s.id === id)
  const h = release?.hypotheses
  return (
    <>
      {release && <p className="kicker">PRISM · Release {release.version}</p>}
      <h1>What AI launches publicly evidence</h1>
      <p><span className="release-badge">{release ? `Release ${release.version} · ${release.date} · ${release.n} included launches` : 'No release yet'}</span></p>
      {release && h ? (
        <section aria-labelledby="hypotheses" data-hypotheses>
          <h2 id="hypotheses">Hypotheses</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <StatTile name="H1" title={h.h1.row?.label ?? 'H1'} row={h.h1.row} statement={statement(h.h1.statementId)} />
            <StatTile name="H2" title={h.h2.row?.label ?? H2_TITLE} row={h.h2.row} statement={statement(h.h2.statementId)} />
            <StatTile name="H3" title={h.h3.row?.label ?? 'H3'} row={h.h3.row} statement={statement(h.h3.statementId)} />
          </div>
          {/* One panel for all three tiles; the sensitivity row repeats each tile without the unread sites. */}
          <HowWeKnow id="hypotheses" rows={codedStateRows(release, [h.h1.row, h.h2.row, h.h3.row].filter(r => r !== undefined), release.methods.codebook.map(e => e.checkId))} />
          {/* The PDF is printed into the deployed site root next to index.html (plan 07, D-73); the relative href
              keeps it out of the route-link check, which covers pages only. */}
          <p data-print-hide>
            <a className={buttonVariants({ variant: 'outline', size: 'lg', className: 'no-underline' })} href={`prism-review-${release.version}-${release.date}.pdf`} data-pdf-link>Download the review (PDF)</a>
          </p>
        </section>
      ) : <NotReleased />}
      <section>
        <h2>Reading the figures</h2>
        <p>Every check on every launch is in one of four states: “publicly evidenced (artefact linked)”, “claimed, no artefact linked”, “no public evidence found”, or “own page shows the check is not met”. Launches with no public evidence found stay in every share’s denominator. Not publicly evidenced does not mean not done.</p>
      </section>
      <section>
        <h2>Pages</h2>
        <ul className="findings-list">{links.map(([label, href]) => <li key={href}><a href={href}>{label}</a></li>)}</ul>
      </section>
    </>
  )
}
