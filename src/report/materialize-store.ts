// Plan 07-14 Task 1: the real sample -> identifiable and de-identified judge views, the method view and the
// §11 / sponsor candidates, written to one local database only (the --db target). Sources come in through
// sourceOf so the same code runs on the real store and on synthetic ones in tests. Every row is written in one
// transaction, and only after the identifier scan passes; a refusal throws and writes nothing.

import type { Kysely } from "kysely";

import { ensureAccessSchema, upsertProjectAccess } from "../app/server/access-store.ts";
import type { Codebook } from "../pipeline/coding/codebook-prompt.ts";
import { buildDocumentFrequency, deidentifyView, dictionaryOf, isVocabulary, scanDeidentified, WORD_MASK } from "./deidentify.ts";
import { buildMethodView, decisionLabelsOf, type MethodInput } from "./method-view.ts";
import { ensureReportViewSchema, upsertMethodView, upsertReportView, upsertSnapshot } from "./store.ts";
import { buildReportView, type GapTextFn, type ReportSource } from "./view.ts";
import { sponsorMentions, wellKnownCandidates, type OwnSpan, type SponsorMention, type WellKnownCandidate } from "./well-known-candidates.ts";

export interface SampleEntry {
  projectId: string;
  hnId: number | null;
}

export interface LoadedProject {
  source: ReportSource;
  /** snapshot hash -> archived (redacted) text */
  snapshots: Record<string, string>;
  /** every stored own-site span of the project, for the candidate pass */
  spans: OwnSpan[];
}

export class MaterializeRefusal extends Error {
  readonly reason: string;
  /** Aggregate categories of the scan hits (never a term or a name), for tuning k or the common words. */
  readonly diagnosis: Record<string, number>;
  constructor(reason: string, diagnosis: Record<string, number> = {}) {
    super(`DEID REFUSED ${reason}`);
    this.reason = reason;
    this.diagnosis = diagnosis;
  }
}

/** Where each scan hit sits and what kind of term it is, as counts only. */
function diagnose(deids: { view: any; dictionary: { projectRef: string; terms: { text: string; placeholder: string }[] } }[], hits: { pseudonym: string; termOf: string; termIndex: number }[], corpus: { df: Map<string, number> }): Record<string, number> {
  const out: Record<string, number> = {};
  const bump = (k: string) => (out[k] = (out[k] ?? 0) + 1);
  const dictOf = new Map(deids.map((d) => [d.view.projectRef, d.dictionary]));
  const viewOf = new Map(deids.map((d) => [d.view.projectRef, d.view]));
  const paths = (x: unknown, p: string, acc: [string, string][]) => {
    if (typeof x === "string") acc.push([p, x]);
    else if (Array.isArray(x)) x.forEach((v) => paths(v, `${p}[]`, acc));
    else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) paths(v, p ? `${p}.${k}` : k, acc);
    return acc;
  };
  for (const h of hits) {
    if (h.termIndex < 0) { bump("url"); continue; }
    // the hit's own pseudonym is the view; termOf is whose dictionary the term came from
    const term = dictOf.get(h.termOf)!.terms[h.termIndex]!;
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${term.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{M}\\p{N}])`, "iu");
    const where = paths(viewOf.get(h.pseudonym), "", []).filter(([, v]) => re.test(v)).map(([k]) => k.replace(/\[\]/g, ""));
    const words = term.text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const df = words.length === 1 ? (corpus.df.get(words[0]!) ?? 0) : -1;
    bump(`${h.pseudonym === h.termOf ? "self" : "cross"} kind=${term.placeholder} words=${Math.min(words.length, 3)} df=${df < 0 ? "multi" : df >= 10 ? ">=10" : df >= 3 ? "3-9" : "<3"} in=${[...new Set(where)].join("|") || "?"}`);
  }
  return out;
}

export interface MaterializeResult {
  reportRows: number;
  deidViews: number;
  snapshots: number;
  candidates: WellKnownCandidate[];
  sponsors: SponsorMention[];
  excludedWorkedCase: number;
}

export async function materializeStore(o: {
  entries: SampleEntry[];
  sourceOf: (e: SampleEntry) => Promise<LoadedProject>;
  /** A3 worked cases (HN ids): not sampled projects, so they get no rows here (D-77). */
  workedCaseHnIds: number[];
  key: string;
  codebook: Codebook;
  gatesPath: string;
  runGate: (record: object) => Promise<any>;
  gapText: GapTextFn;
  method: MethodInput;
  db: Kysely<any>;
  publicText?: string;
}): Promise<MaterializeResult> {
  const sampled = o.entries.filter((e) => e.hnId === null || !o.workedCaseHnIds.includes(e.hnId));
  const built: { e: SampleEntry; p: LoadedProject; view: Awaited<ReturnType<typeof buildReportView>> }[] = [];
  for (const e of sampled) {
    const p = await o.sourceOf(e);
    built.push({ e, p, view: await buildReportView(p.source, { codebook: o.codebook, gatesPath: o.gatesPath, runGate: o.runGate as any, gapText: o.gapText }) });
  }

  const corpus = buildDocumentFrequency(built.map((b) => b.view));
  // Real-sample rule (Helen, 2026-10-25): another project's name that is vocabulary (every word in the quotes of
  // VOCAB_DF or more sampled projects) cannot single out a launch, so the scan skips it; every other project's
  // rarer names are masked in every view, so the scan stays fail-closed for them.
  const dicts = built.map((b) => dictionaryOf(b.view));
  const rare = dicts.flatMap((d) => d.terms.filter((t) => !isVocabulary(t.text, corpus)));
  const deids = built.map((b, i) => {
    const own = dicts[i]!;
    // Another project's name is masked as a plain word mask, never as this project's [product]/[repo]/[domain].
    const others = rare.filter((t) => !own.terms.some((x) => x.text.toLowerCase() === t.text.toLowerCase())).map((t) => ({ text: t.text, placeholder: WORD_MASK }));
    const terms = [...own.terms, ...others].sort((a, b) => b.text.length - a.text.length);
    const { view, counts } = deidentifyView(b.view, { dictionary: { projectRef: own.projectRef, terms }, corpus, key: o.key });
    return { view, counts, dictionary: { projectRef: own.projectRef, terms: own.terms.filter((t) => !isVocabulary(t.text, corpus)) } };
  });
  if (new Set(deids.map((d) => d.view.projectRef)).size !== deids.length) throw new MaterializeRefusal("pseudonym-collision");
  const hits = scanDeidentified(deids, o.publicText);
  if (hits.length > 0) throw new MaterializeRefusal("identifier-scan", diagnose(deids, hits, corpus));

  const method = buildMethodView({
    method: o.method,
    codebook: o.codebook,
    gapText: o.gapText,
    decisionLabels: decisionLabelsOf(o.gatesPath),
    projects: built.map((b, i) => ({ view: b.view, pseudonym: deids[i]!.view.projectRef })),
  });

  const spans = built.flatMap((b) => b.p.spans);
  const candidates = wellKnownCandidates(spans);
  const sponsors = sponsorMentions(spans);
  const held = new Set(sponsors.map((s) => s.projectId));

  await ensureReportViewSchema(o.db);
  await ensureAccessSchema(o.db);
  let reportRows = 0;
  let snapshots = 0;
  await o.db.transaction().execute(async (trx) => {
    for (const [i, b] of built.entries()) {
      await upsertReportView(trx, b.view);
      await upsertReportView(trx, deids[i]!.view);
      reportRows += 2;
      for (const page of b.p.source.pages) {
        const text = b.p.snapshots[page.snapshotHash];
        if (typeof text !== "string") continue;
        await upsertSnapshot(trx, { projectRef: b.view.projectRef, hash: page.snapshotHash, url: page.url, archivedAt: b.p.source.collectedAt, text, fixture: false });
        snapshots++;
      }
      // No basis yet: Task 2's decisions add own, opt-in or well-known. A sponsor mention holds by default (D-81).
      await upsertProjectAccess(trx, {
        projectId: b.e.projectId,
        title: b.view.title,
        basis: null,
        sponsorHold: held.has(b.e.projectId),
        inSample: true,
        pseudonym: deids[i]!.view.projectRef,
        liveBoundaryJson: null,
        fixture: false,
      });
    }
    await upsertMethodView(trx, method);
  });
  return { reportRows, deidViews: deids.length, snapshots, candidates, sponsors, excludedWorkedCase: o.entries.length - sampled.length };
}
