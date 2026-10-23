import { createFileRoute } from '@tanstack/react-router'
import { release } from '../data'
import { FINDINGS_NAV, MAIN_NAV, useExisting } from '../pages'

export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: 'What AI launches publicly evidence · PRISM' }] }),
  component: Home,
})

function Home() {
  const links = useExisting([...FINDINGS_NAV, ...MAIN_NAV.filter(([, href]) => href !== '/findings/checks')] as const)
  return (
    <>
      {release && <p className="kicker">PRISM · Release {release.version}</p>}
      <h1>What AI launches publicly evidence</h1>
      <p><span className="release-badge">{release ? `Release ${release.version} · ${release.date} · ${release.n} included launches` : 'No release yet'}</span></p>
      <section>
        <h2>Reading the figures</h2>
        <p>Every check on every launch is in one of four states: publicly evidenced (artefact linked), claimed with no artefact linked, no public evidence found, or the launch's own page shows the check is not met. Not publicly evidenced does not mean not done.</p>
      </section>
      <section>
        <h2>Pages</h2>
        <ul className="findings-list">{links.map(([label, href]) => <li key={href}><a href={href}>{label}</a></li>)}</ul>
      </section>
    </>
  )
}
