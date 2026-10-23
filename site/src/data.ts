// Reads the release through @public-data only, checks the keys the pages use, and fails the build with the
// UI-SPEC error message on any problem. No page renders partial data.
import raw from '@public-data/release.json'

export type RowState = 'released' | 'lt10' | 'suppressed' | 'withheld' | 'absent' | 'not-estimable'
export interface Row { id: string; label: string; state: RowState; c?: number; n?: number; pct?: number; ci?: [number, number]; reason?: string; note?: string }
export interface Figure { id: string; title: string; measure: string; rows: Row[] }
export interface Statement { id: string; kind: string; text: string }
interface Agent { modelId: string; host: string }
export interface Hypothesis {
  row?: Row
  test: { tested?: boolean; reason?: string; pAdjusted?: number; supported?: boolean }
  statementId: string
}
export interface Release {
  schema: 1
  kind: 'fixture' | 'findings'
  version: string
  date: string
  n: number
  figures: Record<string, Figure>
  howWeKnow: {
    n: number
    labeller: Agent
    confirmer: Agent
    agreement: Record<string, { ac1: number | null; ac1CI: [number, number] | null; precision: Row }>
    confirmation: { total: { changed: number; proposed: number; pct: number }; rejected: Row; downgraded: Row }
    personEdits: { count: number; total: number }
  }
  methods: { codebook: { checkId: string; shortTitle: string; decisionId: string }[] }
  hypotheses: { h1: Hypothesis; h2: Hypothesis; h3: Hypothesis }
  sensitivity: { excluded: number; rows: Record<string, Row> }
  validation?: {
    screeningAudit: { errors: number; audited: number; pct: number; ci: [number, number]; bar: number }
    collectionRecall: { supportedFound: number; supported: number; recall: number; rawFound: number; raw: number; rawRecall: number }
  }
  statements: Statement[]
}

const STATES = new Set(['released', 'lt10', 'suppressed', 'withheld', 'absent', 'not-estimable'])
const fail = (problem: string): never => { throw new Error(`public-data/release.json: ${problem}. Re-run the export and rebuild.`) }
const obj = (v: unknown, where: string) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`${where} is not an object`))
const str = (v: unknown, where: string) => (typeof v === 'string' && v ? v : fail(`${where} is not a string`))
const num = (v: unknown, where: string) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(`${where} is not a number`))
const arr = (v: unknown, where: string) => (Array.isArray(v) ? v : fail(`${where} is not an array`))

function checkRow(v: unknown, where: string) {
  const r = obj(v, where)
  str(r.id, `${where}.id`); str(r.label, `${where}.label`)
  if (!STATES.has(r.state as string)) fail(`${where}.state "${String(r.state)}" is unknown`)
  if (r.state === 'released') {
    for (const k of ['c', 'n', 'pct']) num(r[k], `${where}.${k}`)
    const ci = arr(r.ci, `${where}.ci`); if (ci.length !== 2) fail(`${where}.ci needs two bounds`); ci.forEach((b, i) => num(b, `${where}.ci[${i}]`))
  }
  if (r.state === 'withheld' || r.state === 'absent' || r.state === 'not-estimable') str(r.reason, `${where}.reason`)
}

export function parseRelease(input: unknown): Release | null {
  const r = obj(input, 'the file')
  if (r.schema !== 1) fail(`schema ${String(r.schema)} is not 1`)
  if (r.kind === 'none') return null
  if (r.kind !== 'fixture' && r.kind !== 'findings') fail(`kind "${String(r.kind)}" is unknown`)
  str(r.version, 'version'); str(r.date, 'date'); num(r.n, 'n')
  for (const [key, f] of Object.entries(obj(r.figures, 'figures'))) {
    const fig = obj(f, `figures.${key}`)
    str(fig.title, `figures.${key}.title`); str(fig.measure, `figures.${key}.measure`)
    arr(fig.rows, `figures.${key}.rows`).forEach((row, i) => checkRow(row, `figures.${key}.rows[${i}]`))
  }
  const h = obj(r.howWeKnow, 'howWeKnow')
  num(h.n, 'howWeKnow.n')
  for (const who of ['labeller', 'confirmer']) { const a = obj(h[who], `howWeKnow.${who}`); str(a.modelId, `howWeKnow.${who}.modelId`); str(a.host, `howWeKnow.${who}.host`) }
  for (const [check, a] of Object.entries(obj(h.agreement, 'howWeKnow.agreement'))) checkRow(obj(a, `howWeKnow.agreement.${check}`).precision, `howWeKnow.agreement.${check}.precision`)
  const c = obj(h.confirmation, 'howWeKnow.confirmation')
  num(obj(c.total, 'howWeKnow.confirmation.total').pct, 'howWeKnow.confirmation.total.pct')
  checkRow(c.rejected, 'howWeKnow.confirmation.rejected'); checkRow(c.downgraded, 'howWeKnow.confirmation.downgraded')
  const p = obj(h.personEdits, 'howWeKnow.personEdits'); num(p.count, 'howWeKnow.personEdits.count'); num(p.total, 'howWeKnow.personEdits.total')
  for (const k of ['h1', 'h2', 'h3']) {
    const hy = obj(obj(r.hypotheses, 'hypotheses')[k], `hypotheses.${k}`)
    str(hy.statementId, `hypotheses.${k}.statementId`); obj(hy.test, `hypotheses.${k}.test`)
    if (hy.row !== undefined) checkRow(hy.row, `hypotheses.${k}.row`)
  }
  const sens = obj(r.sensitivity, 'sensitivity')
  num(sens.excluded, 'sensitivity.excluded')
  for (const [id, row] of Object.entries(obj(sens.rows, 'sensitivity.rows'))) checkRow(row, `sensitivity.rows.${id}`)
  if (r.validation !== undefined) {
    const v = obj(r.validation, 'validation')
    const s = obj(v.screeningAudit, 'validation.screeningAudit')
    for (const k of ['errors', 'audited', 'pct', 'bar']) num(s[k], `validation.screeningAudit.${k}`)
    arr(s.ci, 'validation.screeningAudit.ci').forEach((b, i) => num(b, `validation.screeningAudit.ci[${i}]`))
    const c = obj(v.collectionRecall, 'validation.collectionRecall')
    for (const k of ['supportedFound', 'supported', 'recall', 'rawFound', 'raw', 'rawRecall']) num(c[k], `validation.collectionRecall.${k}`)
  }
  arr(obj(r.methods, 'methods').codebook, 'methods.codebook').forEach((e, i) => { const x = obj(e, `methods.codebook[${i}]`); str(x.checkId, `methods.codebook[${i}].checkId`); str(x.shortTitle, `methods.codebook[${i}].shortTitle`) })
  arr(r.statements, 'statements').forEach((s, i) => { const x = obj(s, `statements[${i}]`); str(x.id, `statements[${i}].id`); str(x.kind, `statements[${i}].kind`); str(x.text, `statements[${i}].text`) })
  return r as unknown as Release
}

export const release = parseRelease(raw)

/** A statement's text by id, or undefined. */
export const statementText = (id: string) => release?.statements.find(s => s.id === id)?.text

/** "X of N (p%, 95% CI a–b%)" for a released row, else its explicit-state text. */
export const shareText = (r: Row) => (r.state === 'released' ? `${r.c} of ${r.n} (${r.pct}%, 95% CI ${r.ci![0]}–${r.ci![1]}%)` : stateText(r)!)

/** "chk|<checkId>|pass|all" -> "<checkId>". */
export const checkIdOf = (rowId: string) => rowId.split('|')[1] ?? rowId

/** Display text of a row that carries no number (06-UI-SPEC, explicit non-number rows), or null for a released row. */
export function stateText(r: Row): string | null {
  switch (r.state) {
    case 'released': return null
    case 'lt10': return '<10'
    case 'suppressed': return 'suppressed (disclosure control)'
    case 'withheld': return `withheld: ${r.reason}`
    case 'absent': return `not in this release: ${r.reason}`
    case 'not-estimable': return `not estimable: ${r.reason}`
  }
}

/** The table-cell form of the same state. */
export function stateCell(r: Row): string {
  switch (r.state) {
    case 'released': return `${r.c} of ${r.n}`
    case 'lt10': return '<10'
    case 'suppressed': return 'suppressed'
    case 'withheld': return `withheld: ${r.reason}`
    case 'absent': return 'not in this release'
    case 'not-estimable': return 'not estimable'
  }
}

/** One sentence per row, for the chart's <desc>, each row's <title> and the share text. */
export function rowSentence(r: Row): string {
  return `${r.label}: ${shareText(r)}`
}
