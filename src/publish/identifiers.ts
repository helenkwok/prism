// PUB-03 / protocol 6.6 / D-77: identifier scan over any output text.
// A hit carries the rule and the file only; the matched value is never printed, logged or returned.
//   node src/publish/identifiers.ts --store <store.json> <path>...
// Prints SCAN HIT <file> <rule> per hit and SCAN: {"files":N,"hits":H}; exits 1 on any hit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDomain, getHostname, getPublicSuffix } from "tldts";

import { ARTCRAFT_HN_ID } from "../pipeline/select/draw-sample.ts";

/** Sample entries (DrawEntry or store style), frame posts and screening-log candidates. */
export interface IdentifierSource {
  hn_id?: string;
  hnId?: string;
  id?: string;
  title?: string;
  entry_url?: string;
  final_url?: string;
  entryUrl?: string;
  finalUrl?: string;
  url?: string;
}

export interface IdentifierSet {
  titles: Set<string>;
  urls: Set<string>;
  hosts: Set<string>;
  hnIds: Set<string>;
}

export type Rule = "title" | "url" | "hostname" | "hn-id";
export interface Hit {
  file: string;
  rule: Rule;
}

const MIN_TITLE = 6;
/** Shared hosts: many projects live under them, so only path-qualified URLs count. */
const GENERIC = new Set(["github.com", "gitlab.com", "huggingface.co", "ycombinator.com", "reddit.com", "redd.it", "youtube.com", "x.com", "twitter.com", "google.com"]);
const PSL = { allowPrivateDomains: true };

const urlKey = (u: string) => u.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

/**
 * Single English dictionary words ("modular", "overflow") cannot identify a launch on their own and occur in
 * ordinary release prose, so a title form that is one such word is not an identifier. Without a word list the
 * scan stays at its stricter behaviour.
 */
const DICT_FILE = "/usr/share/dict/words";
let dict: Set<string> | null | undefined;
function dictionaryWord(t: string): boolean {
  if (dict === undefined) dict = fs.existsSync(DICT_FILE) ? new Set(fs.readFileSync(DICT_FILE, "utf8").toLowerCase().split("\n")) : null;
  return !!dict && /^[a-z]+$/.test(t) && dict.has(t);
}

/** The full title, the title without "Show HN:", and the name before the first separator. */
function titleForms(title: string): string[] {
  const bare = title.replace(/^\s*show hn\s*:\s*/i, "");
  return [title, bare, bare.split(/\s[–—-]\s|:\s/)[0]!].map((t) => t.trim().toLowerCase()).filter((t) => t.length >= MIN_TITLE && !dictionaryWord(t));
}

export function buildIdentifierSet({
  projects,
  frame = [],
  extra = [],
}: {
  projects: IdentifierSource[];
  frame?: IdentifierSource[];
  extra?: IdentifierSource[];
}): IdentifierSet {
  const set: IdentifierSet = { titles: new Set(), urls: new Set(), hosts: new Set(), hnIds: new Set([ARTCRAFT_HN_ID]) };
  for (const e of [...projects, ...frame, ...extra]) {
    const id = e.hn_id ?? e.hnId ?? e.id;
    if (id) set.hnIds.add(String(id));
    if (e.title) for (const t of titleForms(e.title)) set.titles.add(t);
    for (const u of [e.entry_url, e.final_url, e.entryUrl, e.finalUrl, e.url]) {
      if (!u) continue;
      const key = urlKey(u);
      if (key.includes("/")) set.urls.add(key);
      const domain = getDomain(u, PSL);
      if (!domain || GENERIC.has(domain)) continue;
      for (const h of [getHostname(u), domain]) {
        if (h && getPublicSuffix(h, PSL) !== h) set.hosts.add(h.toLowerCase().replace(/^www\./, ""));
      }
    }
  }
  return set;
}

/** Every identifier the private store knows: the sample, the whole screening log, the frame and the worked case (D-77). */
export function buildIdentifierSetFromStore(dataDir: string): IdentifierSet {
  const read = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
  const pipe = path.join(dataDir, "pipeline");
  const frame = read(path.join(pipe, "frame.json"))?.posts ?? [];
  const byId = new Map(frame.map((p: IdentifierSource) => [String(p.id), p]));
  const log = read(path.join(pipe, "sample-screening-log.json"))?.log ?? [];
  const picks = read(path.join(dataDir, "reddit", "picks.json")) ?? [];
  const worked = read(path.join(dataDir, "casework", "artcraft", "data", "pipeline", "slice-projects.json")) ?? [];
  return buildIdentifierSet({
    projects: [...(read(path.join(pipe, "sample-projects.json")) ?? []), ...picks],
    frame: log.map((e: { id: string }) => byId.get(String(e.id)) ?? { id: e.id }),
    // unscreened frame posts give ids, URLs and hosts; their titles ("GitHub", "Baseline") are not used, since
    // PRISM never processed them and their one-word names collide with ordinary release prose
    extra: [...frame.map(({ title: _t, ...rest }: IdentifierSource) => rest), ...(Array.isArray(worked) ? worked : [])],
  });
}

// ponytail: substring scan per identifier, O(identifiers x text); index with Aho-Corasick if a full-site scan gets slow.
/** v occurs in t as whole words (no letter or digit right before or after it). */
function hasWords(t: string, v: string): boolean {
  const word = /[a-z0-9]/;
  for (let i = t.indexOf(v); i >= 0; i = t.indexOf(v, i + 1)) {
    if (!word.test(t[i - 1] ?? "") && !word.test(t[i + v.length] ?? "")) return true;
  }
  return false;
}

function rulesIn(text: string, set: IdentifierSet): Rule[] {
  const t = text.toLowerCase();
  const out: Rule[] = [];
  const any = (s: Set<string>) => {
    for (const v of s) if (t.includes(v)) return true;
    return false;
  };
  const anyWords = (s: Set<string>) => {
    for (const v of s) if (hasWords(t, v)) return true;
    return false;
  };
  // titles match as whole words: "debugg" (a name) is not a hit inside "debugging"
  if (anyWords(set.titles)) out.push("title");
  if (any(set.urls)) out.push("url");
  if (any(set.hosts)) out.push("hostname");
  if ((t.match(/\d+/g) ?? []).some((d) => set.hnIds.has(d))) out.push("hn-id");
  return out;
}

/** One hit per file and rule. A file name that is itself an identifier is withheld. */
export function scanTexts(texts: { file: string; text: string }[], set: IdentifierSet): Hit[] {
  const hits: Hit[] = [];
  for (const { file, text } of texts) {
    const nameHits = rulesIn(file, set);
    const shown = nameHits.length ? "(file name withheld)" : file;
    for (const rule of new Set([...nameHits, ...rulesIn(text, set)])) hits.push({ file: shown, rule });
  }
  return hits;
}

function listFiles(p: string): string[] {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return [p];
  return fs
    .readdirSync(p)
    .sort()
    .flatMap((f) => listFiles(path.join(p, f)));
}

function main(argv: string[]): number {
  const flag = argv.includes("--data-dir") ? "--data-dir" : "--store";
  const i = argv.indexOf(flag);
  const source = i >= 0 ? argv[i + 1] : undefined;
  const paths = argv.filter((_, j) => i < 0 || (j !== i && j !== i + 1));
  if (!source || !paths.length) {
    console.error("usage: node src/publish/identifiers.ts (--store <store.json> | --data-dir <dir>) <path>...");
    return 2;
  }
  let set: IdentifierSet;
  if (flag === "--data-dir") set = buildIdentifierSetFromStore(source);
  else {
    const store = JSON.parse(fs.readFileSync(source, "utf8"));
    set = buildIdentifierSet({ projects: store.projects ?? [], frame: store.frame ?? [], extra: store.extra ?? [] });
  }
  const texts = paths
    .flatMap(listFiles)
    .map((f) => ({ file: path.relative(process.cwd(), f), buf: fs.readFileSync(f) }))
    .filter(({ buf }) => !buf.subarray(0, 8192).includes(0)) // text files only
    .map(({ file, buf }) => ({ file, text: buf.toString("utf8") }));
  const hits = scanTexts(texts, set);
  for (const h of hits) console.log(`SCAN HIT ${h.file} ${h.rule}`);
  console.log(`SCAN: ${JSON.stringify({ files: texts.length, hits: hits.length })}`);
  return hits.length ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
