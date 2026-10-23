// Findings pages (plan 06-06), called by check.mjs with JavaScript off. A build with no release shows the empty
// state instead of figures, so each assertion runs only where the page has figures.
const hasFigures = async (page, origin, path) => {
  await page.goto(origin + path)
  return (await page.locator('figure').count()) > 0
}

export default async function findings({ page, origin, assert }) {
  const checked = []

  // Protocol section 7: cohorts are separate bars, never a line. No polyline or polygon, and no path taller than
  // one bar (a path spanning two quarter rows would be a connecting line).
  if (await hasFigures(page, origin, '/findings/cohorts')) {
    const marks = await page.locator('figure svg').evaluateAll(svgs => svgs.map(svg => ({
      lines: svg.querySelectorAll('polyline, polygon').length,
      tallest: Math.max(0, ...[...svg.querySelectorAll('path')].map(p => p.getBBox().height)),
    })))
    for (const m of marks) {
      assert.equal(m.lines, 0, 'a polyline or polygon on the cohorts page')
      assert(m.tallest <= 12, `a path ${m.tallest}px tall on the cohorts page connects quarters`)
    }
    assert((await page.locator('[data-cohort-banner]').count()) === 1, 'the cohort banner')
    checked.push('/findings/cohorts bars only, no line, banner shown')
  }

  // D-75: the GitHub-only group is absent from the synthetic release and must read as words.
  if (await hasFigures(page, origin, '/findings/sources')) {
    const absent = await page.locator('figure svg g[data-row-state="absent"]').evaluateAll(gs => gs.map(g => g.textContent))
    assert(absent.length > 0 && absent.every(t => t.includes('GitHub-only') && t.includes('not in this release')), 'GitHub-only row as "not in this release"')
    assert((await page.locator('[data-h2-status]').count()) === 1, 'the H2 status line')
    checked.push('/findings/sources GitHub-only not in this release, H2 status line')
  }

  // Claims chart: two series identified by a legend and direct labels, not by colour alone.
  if (await hasFigures(page, origin, '/findings/claims')) {
    const legend = await page.locator('figure svg [data-legend]').allTextContents()
    assert.equal(legend.length, 2, 'two legend entries')
    // Drawn text only (not <title>/<desc>): each series name appears in the legend and again on the first pair.
    const drawn = await page.locator('figure svg text').allTextContents()
    for (const series of legend) assert(drawn.filter(t => t.startsWith(series)).length >= 2, `direct label for "${series}"`)
    checked.push('/findings/claims legend and direct labels')
  }

  return checked
}
