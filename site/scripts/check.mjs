// D-70: every route read with JavaScript disabled, after `npm run build`. Asserts status, the UI-SPEC h1, the 404,
// internal links, How-we-know panels, explicit-state text, CSP headers and manifest digests; saves screenshots
// and the finding text for the PUB-04 lint. Route-specific checks live in scripts/checks/*.mjs: each default
// export is called with ({ page, origin, assert, routes }) and returns the paths it checked.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { serve } from './serve.mjs'
import { BASE_PREFIX } from '../../base-path.mjs'

// 06-UI-SPEC Page Inventory: path -> [h1, route file under src/routes].
export const ROUTES = {
  '/': ['What AI launches publicly evidence', 'index.tsx'],
  '/findings/checks': ['Evidence by check', 'findings.checks.tsx'],
  '/findings/decisions': ['Evidence by decision', 'findings.decisions.tsx'],
  '/findings/cohorts': ['Evidence by launch cohort', 'findings.cohorts.tsx'],
  '/findings/sources': ['Evidence by discovery source', 'findings.sources.tsx'],
  '/findings/claims': ['Claims and evidence', 'findings.claims.tsx'],
  '/findings/source-types': ['Where launches put their evidence', 'findings.source-types.tsx'],
  '/prisma': ['How launches were selected', 'prisma.tsx'],
  '/validation': ['How the coding was checked, and its limits', 'validation.tsx'],
  '/methods': ['Methods', 'methods.tsx'],
  '/review': ['PRISM review: what AI launches publicly evidence', 'review.tsx'],
}

const site = resolve(import.meta.dirname, '..')
const shot = path => (path === '/' ? 'home' : path.slice(1).replaceAll('/', '-'))
const failures = []
const stats = { routes: 0, skipped: 0, links: 0, figures: 0 }
async function step(name, fn) {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures.push(`${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`) }
}

const live = Object.keys(ROUTES).filter(path => {
  if (existsSync(resolve(site, 'src/routes', ROUTES[path][1]))) return true
  console.log(`SKIP ${path} (no route file)`)
  stats.skipped++
  return false
})

const { server, origin } = await serve(resolve(site, 'dist/client'))
const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
const findings = []
const internal = new Set()
await mkdir(resolve(site, '_shots'), { recursive: true })
try {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  for (const path of live) {
    await step(`static HTML, JavaScript disabled: ${path}`, async () => {
      const response = await page.goto(origin + path)
      assert.equal(response.status(), 200, 'status')
      const csp = response.headers()['content-security-policy'] ?? ''
      assert(csp.includes("connect-src 'none'"), 'Content-Security-Policy from _headers')
      assert.equal(await page.locator('h1').count(), 1, 'exactly one h1')
      assert.equal((await page.locator('h1').textContent()).trim(), ROUTES[path][0], 'h1')
      const figures = page.locator('figure')
      const n = await figures.count()
      for (let i = 0; i < n; i++) assert.equal(await figures.nth(i).locator('aside.how-we-know').count(), 1, `figure ${i + 1} has a How we know panel`)
      stats.figures += n
      for (const text of await page.locator('[data-state-text]').allTextContents()) assert(!/\d/.test(text.replaceAll('<10', '')), `explicit-state text with a digit: "${text}"`)
      for (const href of await page.locator('a[href^="/"]').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')))) internal.add(href)
      const items = await page.locator('[data-finding]').evaluateAll(nodes => nodes.map(n => {
        const copy = n.cloneNode(true)
        copy.querySelectorAll('[data-check-id], code, cite').forEach(e => e.remove())
        return copy.textContent.replace(/\s+/g, ' ').trim()
      }))
      items.forEach((text, i) => findings.push({ id: `${path}#${i}`, kind: 'finding', text }))
      // A fresh context per width: resizing a page before a full-page capture repeats tiles in Chrome.
      for (const width of [1280, 360]) {
        const sized = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } })
        const p = await sized.newPage()
        await p.goto(origin + path)
        await p.screenshot({ path: resolve(site, '_shots', `${shot(path)}-${width}.png`), fullPage: true })
        await sized.close()
      }
      stats.routes++
    })
  }
  await step('404 for a missing page', async () => assert.equal((await page.goto(origin + '/not-a-page')).status(), 404))
  await step(`internal links (${internal.size})`, async () => {
    for (const href of internal) {
      const { pathname } = new URL(href, origin)
      // The private app on the same host (../base-path.mjs) is not a site route; app-smoke checks it.
      if (pathname.startsWith(`${BASE_PREFIX}/`)) continue
      const route = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname
      assert(route in ROUTES, `${href} is not a UI-SPEC route`)
      assert(!/\/\d+(\/|$)/.test(pathname) && !/review\/\d/.test(pathname) && !/[$:]/.test(pathname), `${href} looks like a per-item page`)
      assert.equal((await page.goto(origin + href)).status(), 200, href)
      stats.links++
    }
  })
  await step('manifest digests match the data', async () => {
    const { releaseDir: dir } = JSON.parse(await readFile(resolve(site, 'dist/data-source.json'), 'utf8'))
    if (!dir || !existsSync(resolve(dir, 'manifest.json'))) { console.log('manifest: no release, nothing to compare'); return }
    const manifest = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8'))
    for (const [file, digest] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(resolve(dir, file))).digest('hex'), digest, file)
    assert((await readFile(resolve(site, 'dist/client/index.html'), 'utf8')).includes(`Release ${manifest.version}`), 'the build shows the manifest version')
    console.log('PASS manifest')
  })
  await writeFile(resolve(site, '_shots/findings-text.json'), JSON.stringify(findings, null, 2) + '\n')
  console.log(`FINDINGS-TEXT: ${findings.length} items`)
  const dir = resolve(import.meta.dirname, 'checks')
  for (const file of readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) {
    const name = file.replace(/\.mjs$/, '')
    try {
      const { default: run } = await import(pathToFileURL(resolve(dir, file)).href)
      for (const path of (await run({ page, origin, assert, routes: ROUTES })) ?? []) console.log(`PASS ${name}: ${path}`)
    } catch (error) { failures.push(`${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`) }
  }
  await context.close()
} finally {
  await browser.close()
  await new Promise(done => server.close(done))
}
console.log(`CHECK: ${JSON.stringify({ ...stats, failures: failures.length })}`)
if (failures.length) process.exit(1)
