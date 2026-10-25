import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { releaseDir } from '../release-dir.mjs'

// Review pages (plan 06-07), called by check.mjs with JavaScript off. A build with no release shows the empty
// state, so each assertion runs only where the release is present.
const released = async (page, origin, path) => {
  await page.goto(origin + path)
  return (await page.locator('[data-empty-state]').count()) === 0
}

export default async function review({ page, origin, assert }) {
  const checked = []
  const directory = releaseDir()
  const release = directory ? JSON.parse(await readFile(resolve(directory, 'release.json'), 'utf8')) : null
  const rare = Object.values(release?.howWeKnow?.agreement ?? {}).filter(a => a.status === 'not-estimable')

  if (await released(page, origin, '/review')) {
    // D-76 / PUB-05: every required limitation is listed.
    const limitations = await page.locator('[data-limitations] > li').count()
    assert(limitations >= 9, `${limitations} limitations on /review, at least 9 required`)
    checked.push(`/review lists ${limitations} limitations`)

    // 06-UI-SPEC item 1: a 150-250 word structured abstract.
    const words = (await page.locator('[data-abstract]').textContent()).replace(/^\s*Abstract/, '').trim().split(/\s+/).length
    assert(words >= 150 && words <= 250, `abstract has ${words} words`)
    checked.push(`/review abstract ${words} words`)

    // 06-UI-SPEC "Review page order": the h2 sections in systematic-review order.
    const ORDER = ['Abstract', 'Introduction', 'Methods', 'Results', 'Validation', 'Limitations', 'Exploratory analyses', 'Appendix A', 'Appendix B', 'Appendix C']
    const h2 = (await page.locator('main h2').allTextContents()).map(t => t.trim())
    assert.equal(h2.length, ORDER.length, `h2 headings: ${h2.join(' | ')}`)
    ORDER.forEach((want, i) => assert(h2[i].startsWith(want), `h2 ${i + 1} is "${h2[i]}", expected "${want}"`))
    checked.push('/review h2 order Introduction, Methods, Results, Validation, Limitations, Exploratory analyses, Appendix A-C')

    // Appendix B prints every numbered figure's table, open (not inside a closed <details>). A long figure is
    // printed in parts under one number, so compare the sets of figure numbers.
    const numbers = async sel => [...new Set((await page.locator(sel).allTextContents()).map(t => /^\s*Figure (\d+)\./.exec(t)?.[1]))].join(',')
    const figures = await numbers('main figure > figcaption')
    assert.equal(await numbers('#appendix-b caption'), figures, 'Appendix B figure numbers')
    checked.push(`/review Appendix B has the tables of figures ${figures}`)

    // D-77: no worked case anywhere in the review.
    assert(!/worked case|ArtCraft/i.test(await page.locator('main').textContent()), 'a worked case on /review')
    checked.push('/review has no worked case')
  }

  // PrismaFlow: the chart's <desc> names every box in its table, and its panel carries the selection row.
  if (await released(page, origin, '/prisma')) {
    const desc = await page.locator('figure svg desc').textContent()
    const labels = await page.locator('figure table tbody th').allTextContents()
    for (const label of labels) assert(desc.includes(label), `PRISMA <desc> misses "${label}"`)
    assert(/Screening error/.test(await page.locator('figure aside.how-we-know').textContent()), 'PRISMA selection row')
    checked.push(`/prisma flow describes all ${labels.length} boxes, selection row shown`)
  }

  // D-83: the validation page names the addendum the process figures are published under (from the manifest).
  if (await released(page, origin, '/validation')) {
    const text = await page.locator('[data-process-figures]').textContent()
    const addendum = /addendum (A\d+)/.exec(text)?.[1]
    assert(addendum, '/validation names the process-figure addendum')
    assert.equal(await page.locator('[data-process-figures] > div').count(), 4, 'four process figures')
    checked.push(`/validation names ${addendum} for 4 process figures`)
    const limited = page.locator('[data-agreement-status="not-estimable"]')
    assert.equal(await limited.count(), rare.length, 'every rare check has an explicit agreement limitation')
    const labels = await limited.allTextContents()
    for (const text of labels) {
      assert(/agreement not estimable: fewer than ten gold passes/i.test(text), 'rare agreement limitation is visible')
      assert(!/validated/i.test(text), 'rare agreement is never called validated')
    }
    if (rare.some(a => a.ac1 !== null)) assert(labels.some(text => /Descriptive AC1:/.test(text)), 'rare numeric figures remain explicitly descriptive')
    checked.push(`/validation labels ${rare.length} rare checks without validation claims`)

  }

  if (rare.length && await released(page, origin, '/findings/checks')) {
    const panels = await page.locator('aside.how-we-know').allTextContents()
    assert(panels.some(text => /Agreement not estimable/i.test(text) && /descriptive/i.test(text)), 'How we know labels rare agreement as not estimable and descriptive')
    checked.push('/findings/checks carries the rare-agreement limitation in How we know')
  }

  return checked
}
