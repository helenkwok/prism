// Overview hypothesis tile (06-UI-SPEC StatTile): the hero share or an explicit state, then the release's own
// test-result sentence. A finding sentence is marked for the PUB-04 lint; method text (the H2 descriptive line) is not.
import type { Row, Statement } from '../data'
import { stateText } from '../data'
import { StatementText } from './figure'

export function StatTile({ name, title, row, statement }: { name: string; title: string; row?: Row; statement?: Statement }) {
  const explicit = row ? stateText(row) : null
  return (
    <div className="stat-tile flex flex-col gap-2 rounded-xl border border-border bg-card p-4" data-stat-tile={name}>
      <p className="text-[0.8125rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{name}</p>
      <h3>{title}</h3>
      {row && (explicit === null
        ? <p><span className="block text-[2rem] font-semibold leading-[1.15]">{row.pct}%</span><span className="text-[0.8125rem] text-muted-foreground">{row.c} of {row.n} · 95% CI {row.ci![0]}–{row.ci![1]}%</span></p>
        : <p className="font-semibold" data-state-text>{explicit}</p>)}
      {statement && (statement.kind === 'finding'
        ? <p className="text-[0.8125rem]" data-finding><StatementText text={statement.text} /></p>
        : <p className="text-[0.8125rem]">{statement.text}</p>)}
    </div>
  )
}
