import { createFileRoute } from '@tanstack/react-router'
import { release as loaded, statementText } from '../data'
import { figureNumber, NotReleased } from '../components/figure'
import { PrismaFigure } from '../charts/prisma-flow'

export const Route = createFileRoute('/prisma')({
  head: () => ({ meta: [{ title: 'How launches were selected · PRISM' }] }),
  component: Prisma,
})

const H1 = 'How launches were selected'

function Prisma() {
  const release = loaded
  if (!release?.prisma) return <><h1>{H1}</h1><NotReleased /></>
  const n = figureNumber(release, 'prisma')
  return (
    <>
      <p className="kicker">PRISM · Release {release.version}</p>
      <h1>{H1}</h1>
      <p>{statementText('method:eligibility')}</p>
      <PrismaFigure release={release} id={`fig-${n}`} number={n} />
    </>
  )
}
