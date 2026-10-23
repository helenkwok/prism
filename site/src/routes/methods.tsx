import { createFileRoute } from '@tanstack/react-router'
import { release as loaded } from '../data'
import { MethodsSection } from '../sections'
import { useExisting } from '../pages'

export const Route = createFileRoute('/methods')({
  head: () => ({ meta: [{ title: 'Methods · PRISM' }] }),
  component: Methods,
})

// The review's methods section on its own page. With no release yet the methods text (which lives in the release)
// is not available, and the page says so instead of linking to itself.
function Methods() {
  const release = loaded
  const appendix = useExisting([['Appendix A of the review', '/review']] as const)
  return (
    <>
      {release && <p className="kicker">PRISM · Release {release.version}</p>}
      <h1>Methods</h1>
      {release
        ? <>
            <MethodsSection release={release} top />
            {appendix.length > 0 && <p>The codebook and its crosswalk to the standards are in <a href="/review#appendix-a">Appendix A of the review</a>.</p>}
          </>
        : <p>The methods are published with the first release. Until then the pre-registered protocol in the repository is the reference.</p>}
    </>
  )
}
