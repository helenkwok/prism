import type { ReactNode } from 'react'
import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router'
// Rsbuild path (TanStack Start's Tailwind guide): Start links the generated stylesheet in the head.
import '../styles.css'
import { release } from '../data'
import { FINDINGS_NAV, MAIN_NAV, useExisting } from '../pages'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'PRISM' }],
  }),
  component: () => <Document><Outlet /></Document>,
  notFoundComponent: NotFound,
})

function Document({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: s => s.location.pathname })
  const current = (href: string) => (path === href || path === `${href}/` ? 'page' : undefined)
  const main = useExisting(MAIN_NAV)
  const findings = useExisting(FINDINGS_NAV)
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        <a className="skip-link" href="#content">Skip to content</a>
        <header className="site-header">
          <a className="brand" href="/" aria-current={current('/')}>PRISM</a>
          <nav aria-label="Main">{main.map(([label, href]) => <a key={href} href={href} aria-current={current(href) ?? (href === '/findings/checks' && path.startsWith('/findings/') ? 'page' : undefined)}>{label}</a>)}</nav>
        </header>
        <main id="content">
          {path.startsWith('/findings/') && findings.length > 1 && <nav className="subnav" aria-label="Findings">{findings.map(([label, href]) => <a key={href} href={href} aria-current={current(href)}>{label}</a>)}</nav>}
          {release?.kind === 'fixture' && <p className="fixture-banner" data-fixture-banner>Synthetic test data. These figures are invented to test the pages and are not findings.</p>}
          {children}
        </main>
        <footer className="site-footer">
          {release ? `Release ${release.version} · ${release.date} · aggregate figures only · Data: public-data/ · Licence: Apache-2.0` : 'No release yet · aggregate figures only · Data: public-data/ · Licence: Apache-2.0'}
        </footer>
        <Scripts />
      </body>
    </html>
  )
}

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>This page does not exist. PRISM publishes aggregate figures only, so there are no pages for individual projects.</p>
      <p><a href="/">Go to the overview</a></p>
    </>
  )
}
