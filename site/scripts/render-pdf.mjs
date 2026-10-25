// D-73 / PUB-05: the review PDF is the prerendered /review page printed by Chromium. Run after `npm run build`.
// Writes dist/client/prism-review-<version>-<date>.pdf (deployed with the site, never into public-data/) and
// prints `PDF: <path> <bytes> pages=<n>`.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { serve } from './serve.mjs'

const site = resolve(import.meta.dirname, '..')
const client = resolve(site, 'dist/client')
if (!existsSync(resolve(client, 'review/index.html'))) throw new Error('No built /review: run `npm run build` first.')

// The release the build read (written by csp.mjs), not whatever PUBLIC_DATA_DIR says now.
const { releaseDir } = JSON.parse(await readFile(resolve(site, 'dist/data-source.json'), 'utf8'))
const release = releaseDir && existsSync(resolve(releaseDir, 'release.json')) ? JSON.parse(await readFile(resolve(releaseDir, 'release.json'), 'utf8')) : { kind: 'none' }
if (release.kind === 'none') { console.log('PDF REFUSED: no release, nothing to print'); process.exit(1) }

/** T-06-22: data strings are escaped before they enter the footer template. */
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Header and footer templates do not see page styles: inline style and an explicit size (Playwright docs).
const fixture = release.kind === 'fixture' ? 'Synthetic test data, not findings · ' : ''
const footer = `<div style="font-family:system-ui,-apple-system,Helvetica,Arial,sans-serif;font-size:9px;color:#52514e;width:100%;text-align:center">${escapeHtml(fixture)}PRISM review · Release ${escapeHtml(release.version)} · ${escapeHtml(release.date)} · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`
for (const k of ['version', 'date']) if (!/^[\w.-]+$/.test(release[k])) throw new Error(`release ${k} "${release[k]}" cannot name a file`)
const path = resolve(client, `prism-review-${release.version}-${release.date}.pdf`)

const { server, origin } = await serve(client)
const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
try {
  const page = await browser.newPage()
  await page.emulateMedia({ media: 'print', colorScheme: 'light' })
  const response = await page.goto(origin + '/review', { waitUntil: 'networkidle' })
  assert.equal(response.status(), 200, '/review status')
  await page.pdf({
    path, format: 'A4', printBackground: true, preferCSSPageSize: true,
    margin: { top: '14mm', right: '14mm', bottom: '18mm', left: '14mm' },
    displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: footer, tagged: true, outline: true,
  })
  // Print layout: the header navigation is not printed.
  const nav = await page.evaluate(() => { const n = document.querySelector('.site-header nav'); return n ? getComputedStyle(n).display : 'none' })
  assert.equal(nav, 'none', 'header navigation hidden in print')
} finally {
  await browser.close()
  await new Promise(done => server.close(done))
}

const bytes = await readFile(path)
const pages = bytes.toString('latin1').match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0
console.log(`PDF: ${relative(site, path)} ${bytes.length} pages=${pages}`)
