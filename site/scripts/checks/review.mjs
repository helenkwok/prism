// Review pages (plan 06-07), called by check.mjs with JavaScript off. A build with no release shows the empty
// state, so each assertion runs only where the release is present.
const released = async (page, origin, path) => {
  await page.goto(origin + path)
  return (await page.locator('[data-empty-state]').count()) === 0
}

export default async function review({ page, origin, assert }) {
  const checked = []

  if (await released(page, origin, '/review')) {
    // D-76 / PUB-05: every required limitation is listed.
    const limitations = await page.locator('[data-limitations] > li').count()
    assert(limitations >= 9, `${limitations} limitations on /review, at least 9 required`)
    checked.push(`/review lists ${limitations} limitations`)

    // 06-UI-SPEC item 1: a 150-250 word structured abstract.
    const words = (await page.locator('[data-abstract]').textContent()).replace(/^\s*Abstract/, '').trim().split(/\s+/).length
    assert(words >= 150 && words <= 250, `abstract has ${words} words`)
    checked.push(`/review abstract ${words} words`)

    // D-77: no worked case anywhere in the review.
    assert(!/worked case|ArtCraft/i.test(await page.locator('main').textContent()), 'a worked case on /review')
    checked.push('/review has no worked case')
  }

  // D-83: the validation page names the addendum the process figures are published under (from the manifest).
  if (await released(page, origin, '/validation')) {
    const text = await page.locator('[data-process-figures]').textContent()
    const addendum = /addendum (A\d+)/.exec(text)?.[1]
    assert(addendum, '/validation names the process-figure addendum')
    assert.equal(await page.locator('[data-process-figures] > div').count(), 4, 'four process figures')
    checked.push(`/validation names ${addendum} for 4 process figures`)
  }

  return checked
}
