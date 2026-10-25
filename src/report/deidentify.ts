// APP-03 / D-81 de-identified evidence for judges (research Pattern 7). Built at
// materialisation from the identifiable ReportViews of every sampled project,
// because document-frequency masking needs the whole corpus. Per quote, in
// order: PII redaction (redactText, EVD-07), URLs -> [url], the project's
// dictionary (product, domains, hostnames, GitHub owner/repo) -> placeholders,
// words found in fewer than K sampled projects -> ▇▇, then unique 6-word runs
// are broken and the quote is cut to 40 words. Identifying fields are dropped
// and the ref becomes a keyed pseudonym (HMAC, key outside the repo, §6.8).
// scanDeidentified is the hard gate (§6.6): it reports hits by pseudonym and
// term index only, never the term text, so a refusal log leaks nothing.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDomain, getDomainWithoutSuffix } from "tldts";

import { redactText } from "../pipeline/evidence/redact.ts";
import type { CheckView, ReportView } from "./view.ts";

export const PRODUCT_PLACEHOLDER = "[product]";
export const DOMAIN_PLACEHOLDER = "[domain]";
export const REPO_PLACEHOLDER = "[repo]";
export const URL_PLACEHOLDER = "[url]";
export const WORD_MASK = "▇▇";
export const DF_K = 3;
export const NGRAM = 6;
export const QUOTE_WORDS = 40;
/** A term is vocabulary when every word of it occurs in the quotes of at least this many sampled projects. */
export const VOCAB_DF = 10;

// Function words carry no identity, and a small corpus can leave some of them
// below K; masking them would make every quote unreadable for no privacy gain.
// Kept short on purpose: anything not here must earn its place by DF >= K.
export const COMMON_WORDS = new Set(
  ("a an the and or but nor of to in on at by for from with without into onto over under about as is are was were be been being " +
    "it its this that these those there here we our us you your they their them he she his her i my me not no yes do does did " +
    "can could will would should may might must has have had if then than so too also only just each every all any some more most " +
    "when where which who whom what how why while after before up down out off per via").split(" "),
);

// Hosts shared by many projects: the owner/repo path identifies, the host does not.
const PLATFORM_HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org", "huggingface.co"]);

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'\])]+/gi;
const PLACEHOLDER_RE_SRC = String.raw`\[(?:product|domain|repo|url|email redacted|phone redacted|handle redacted)\]|▇▇`;
const TOKEN_RE = new RegExp(`(${PLACEHOLDER_RE_SRC})|([\\p{L}\\p{M}\\p{N}]+(?:['’.\\-][\\p{L}\\p{M}\\p{N}]+)*)`, "gu");
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’.\-][\p{L}\p{M}\p{N}]+)*/gu;

export interface DictTerm {
  text: string;
  placeholder: string;
}
/** One project's identifiers, longest first (so "x.example" is masked before "x"). */
export interface Dictionary {
  projectRef: string;
  terms: DictTerm[];
}

export interface DeidQuote {
  spanId: string;
  text: string;
  injectionFlagged: boolean;
}
export type DeidCheckView = Omit<CheckView, "quotes"> & { quotes: DeidQuote[] };
export interface DeidentifiedView {
  version: 1;
  view: "deidentified";
  /** The pseudonym, never the project id. */
  projectRef: string;
  fixture: boolean;
  generatedAt: string;
  codebookVersion: string;
  gateSha: string;
  collection: Omit<ReportView["collection"], "urls">;
  decisions: ReportView["decisions"];
  checks: DeidCheckView[];
  howMade: ReportView["howMade"];
}

export interface DeidCounts {
  maskedTerms: number;
  dfMasked: number;
  ngramBreaks: number;
  cut: number;
  redacted: number;
}

export interface Corpus {
  /** Normalised word -> number of sampled projects whose quotes contain it. */
  df: Map<string, number>;
  /** Normalised 6-word run -> projects whose quotes contain it. */
  grams: Map<string, Set<string>>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** First 5 Crockford base32 characters (25 bits) of HMAC-SHA256(key, projectId). */
export function pseudonymOf(key: string, projectId: string): string {
  if (!key) throw new Error("pseudonym key is empty");
  const d = crypto.createHmac("sha256", key).update(projectId).digest();
  const bits = d.readUInt32BE(0) >>> 7; // top 25 bits
  let out = "";
  for (let i = 4; i >= 0; i--) out += CROCKFORD[(bits >>> (i * 5)) & 31];
  return out;
}

const norm = (w: string) => w.normalize("NFC").toLowerCase();
const words = (t: string) => (t.match(WORD_RE) ?? []).map(norm);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRe = (t: string, flags = "giu") => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{M}\\p{N}])`, flags);

/** The term plus its space-, hyphen-, underscore- and un-joined forms (camel case splits too). */
function variants(t: string): string[] {
  const parts = t.split(/[\s_-]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
  return parts.length < 2 ? [t] : [t, parts.join(" "), parts.join("-"), parts.join("_"), parts.join("")];
}

function quoteUrls(view: ReportView): string[] {
  return view.checks.flatMap((c) => c.quotes.map((q) => q.url).filter((u): u is string => !!u));
}

/** The identifiers of one project, read from its identifiable view. */
export function dictionaryOf(view: ReportView): Dictionary {
  const terms: DictTerm[] = [];
  const seen = new Set<string>();
  // ponytail: terms under 3 characters are skipped (an "ai" label would mask every "ai"); DF masking still covers them.
  const add = (text: string, placeholder: string) => {
    for (const v of variants(text.trim())) {
      const k = norm(v);
      if (k.length < 3 || seen.has(k)) continue;
      seen.add(k);
      terms.push({ text: v, placeholder });
    }
  };
  if (view.title) add(view.title, PRODUCT_PLACEHOLDER);
  for (const raw of [...view.collection.urls, ...quoteUrls(view)]) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (PLATFORM_HOSTS.has(host)) {
      let segs = u.pathname.split("/").filter(Boolean);
      if (host === "huggingface.co" && ["spaces", "datasets", "models"].includes(segs[0])) segs = segs.slice(1);
      if (segs[0]) add(segs[0], REPO_PLACEHOLDER);
      if (segs[1]) add(segs[1].replace(/\.git$/, ""), REPO_PLACEHOLDER);
      continue;
    }
    add(host, DOMAIN_PLACEHOLDER);
    const reg = getDomain(host, { allowPrivateDomains: true });
    if (reg) add(reg, DOMAIN_PLACEHOLDER);
    const label = getDomainWithoutSuffix(host, { allowPrivateDomains: true });
    if (label) add(label, DOMAIN_PLACEHOLDER);
  }
  terms.sort((a, b) => b.text.length - a.text.length);
  return { projectRef: view.projectRef, terms };
}

function quoteTexts(view: ReportView): string[] {
  const byId = new Map<string, string>();
  for (const c of view.checks) for (const q of c.quotes) byId.set(q.spanId, q.text);
  return [...byId.values()];
}

/** Document frequency and 6-word runs over every sampled project's quotes. */
export function buildDocumentFrequency(views: ReportView[]): Corpus {
  const df = new Map<string, number>();
  const grams = new Map<string, Set<string>>();
  for (const v of views) {
    const seen = new Set<string>();
    for (const t of quoteTexts(v)) {
      const ws = words(t);
      for (const w of ws) seen.add(w);
      for (let i = 0; i + NGRAM <= ws.length; i++) {
        const g = ws.slice(i, i + NGRAM).join(" ");
        if (!grams.has(g)) grams.set(g, new Set());
        grams.get(g)!.add(v.projectRef);
      }
    }
    for (const w of seen) df.set(w, (df.get(w) ?? 0) + 1);
  }
  return { df, grams };
}

type Tok = { kind: "sep" | "ph" | "word"; text: string };

function tokenize(t: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  for (const m of t.matchAll(TOKEN_RE)) {
    if (m.index! > last) out.push({ kind: "sep", text: t.slice(last, m.index) });
    out.push({ kind: m[1] ? "ph" : "word", text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < t.length) out.push({ kind: "sep", text: t.slice(last) });
  return out;
}

/** True when every word of the term occurs in the quotes of VOCAB_DF or more sampled projects (real-sample rule). */
export function isVocabulary(term: string, corpus: Corpus, v = VOCAB_DF): boolean {
  const ws = term.toLowerCase().normalize("NFC").split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  return ws.length > 0 && ws.every((w) => (corpus.df.get(w) ?? 0) >= v);
}

/** Mask one quote's text; counts are added to `c`. */
export function maskText(text: string, self: string, dictionary: Dictionary, corpus: Corpus, c: DeidCounts, k = DF_K): string {
  const r = redactText(text.normalize("NFC"));
  c.redacted += r.counts.emails + r.counts.phones + r.counts.handles;
  let t = r.text.replace(URL_RE, () => {
    c.maskedTerms++;
    return URL_PLACEHOLDER;
  });
  for (const term of dictionary.terms) {
    t = t.replace(termRe(term.text), () => {
      c.maskedTerms++;
      return term.placeholder;
    });
  }

  const toks = tokenize(t);
  const dfOf = (w: string) => corpus.df.get(norm(w)) ?? 0;
  for (const tok of toks) {
    if (tok.kind === "word" && !COMMON_WORDS.has(norm(tok.text)) && dfOf(tok.text) < k) {
      tok.kind = "ph";
      tok.text = WORD_MASK;
      c.dfMasked++;
    }
  }

  // Break every 6-word run of unmasked words that no other sampled project's quotes contain.
  // Placeholders and masks end a run; spaces and punctuation do not.
  const uniqueWindow = (): number[] | null => {
    const runs: number[][] = [[]];
    toks.forEach((tok, i) => {
      if (tok.kind === "word") runs[runs.length - 1].push(i);
      else if (tok.kind === "ph") runs.push([]);
    });
    for (const r of runs) {
      for (let i = 0; i + NGRAM <= r.length; i++) {
        const win = r.slice(i, i + NGRAM);
        const owners = corpus.grams.get(win.map((j) => norm(toks[j].text)).join(" "));
        if (!owners || ![...owners].some((o) => o !== self)) return win;
      }
    }
    return null;
  };
  for (let win = uniqueWindow(); win; win = uniqueWindow()) {
    // ponytail: masks the rarest word (lowest DF, first on ties); a smarter pick only matters if quotes read worse than needed.
    const rarest = win.reduce((a, b) => (dfOf(toks[b].text) < dfOf(toks[a].text) ? b : a));
    toks[rarest] = { kind: "ph", text: WORD_MASK };
    c.ngramBreaks++;
  }

  const ws = toks.map((x) => x.text).join("").trim().split(/\s+/).filter(Boolean);
  if (ws.length <= QUOTE_WORDS) return ws.join(" ");
  c.cut++;
  return ws.slice(0, QUOTE_WORDS).join(" ") + "…";
}

/** The judge-facing variant of one identifiable view. */
export function deidentifyView(
  view: ReportView,
  { dictionary, corpus, key, k = DF_K }: { dictionary: Dictionary; corpus: Corpus; key: string; k?: number },
): { view: DeidentifiedView; counts: DeidCounts } {
  const counts: DeidCounts = { maskedTerms: 0, dfMasked: 0, ngramBreaks: 0, cut: 0, redacted: 0 };
  const masked = new Map<string, string>();
  const maskOnce = (spanId: string, text: string) => {
    if (!masked.has(spanId)) masked.set(spanId, maskText(text, view.projectRef, dictionary, corpus, counts, k));
    return masked.get(spanId)!;
  };
  const { urls: _urls, ...collection } = view.collection;
  return {
    view: {
      version: 1,
      view: "deidentified",
      projectRef: pseudonymOf(key, view.projectRef),
      fixture: view.fixture,
      generatedAt: view.generatedAt,
      codebookVersion: view.codebookVersion,
      gateSha: view.gateSha,
      collection,
      decisions: view.decisions,
      checks: view.checks.map(({ quotes, ...c }) => ({
        ...c,
        quotes: quotes.map((q) => ({ spanId: q.spanId, text: maskOnce(q.spanId, q.text), injectionFlagged: q.injectionFlagged })),
      })),
      howMade: view.howMade,
    },
    counts,
  };
}

/** A scan hit: in view `pseudonym`, term `termIndex` of `termOf`'s dictionary (-1 = a URL). Never the term text. */
export interface ScanHit {
  pseudonym: string;
  termOf: string;
  termIndex: number;
}

function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x.normalize("NFC"));
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) strings(v, out);
  return out;
}

/**
 * The public shared sources (Helen, 2026-10-23): the codebook, the gap text and
 * the report builder's fixed copy, NFC-normalised. Read on each call, relative to
 * this module, never at import. The gap text is optional; the others must exist.
 */
export function publicSharedText(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const gap = path.join(root, "protocol/gap-text.json");
  return [read("codebook.md"), fs.existsSync(gap) ? read("protocol/gap-text.json") : "", read("src/report/view.ts")].join("\n").normalize("NFC");
}

/**
 * Strings exempt from the scan: identical in every view (two or more) AND found
 * verbatim in the public shared text. A string shared by every view but found in
 * no public source (a quote, say) is still scanned, so it fails safe.
 */
export function sharedStrings(views: unknown[], publicText: string): Set<string> {
  if (views.length < 2) return new Set();
  const [first, ...rest] = views.map((v) => new Set(strings(v)));
  return new Set([...first].filter((s) => rest.every((r) => r.has(s)) && publicText.includes(s)));
}

/**
 * The hard gate (§6.6): every string of every de-identified view, except the
 * shared public text above, is searched, whole-word and case-insensitive, for its
 * own project's dictionary, every other sampled project's dictionary, and any URL.
 * One hit refuses the export.
 */
export function scanDeidentified(
  entries: { view: DeidentifiedView; dictionary: Dictionary }[],
  publicText: string = publicSharedText(),
): ScanHit[] {
  const dicts = entries.map((e) => ({ termOf: e.view.projectRef, res: e.dictionary.terms.map((t) => termRe(t.text, "iu")) }));
  const url = new RegExp(URL_RE.source, "i");
  const exempt = sharedStrings(
    entries.map((e) => e.view),
    publicText,
  );
  const hits: ScanHit[] = [];
  for (const { view } of entries) {
    const text = strings(view)
      .filter((s) => !exempt.has(s))
      .join("\n");
    if (url.test(text)) hits.push({ pseudonym: view.projectRef, termOf: view.projectRef, termIndex: -1 });
    for (const d of dicts) d.res.forEach((re, i) => re.test(text) && hits.push({ pseudonym: view.projectRef, termOf: d.termOf, termIndex: i }));
  }
  return hits;
}
