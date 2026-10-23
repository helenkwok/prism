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

/** The full title, the title without "Show HN:", and the name before the first separator. */
function titleForms(title: string): string[] {
  const bare = title.replace(/^\s*show hn\s*:\s*/i, "");
  return [title, bare, bare.split(/\s[–—-]\s|:\s/)[0]!].map((t) => t.trim().toLowerCase()).filter((t) => t.length >= MIN_TITLE);
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

// ponytail: substring scan per identifier, O(identifiers x text); index with Aho-Corasick if a full-site scan gets slow.
function rulesIn(text: string, set: IdentifierSet): Rule[] {
  const t = text.toLowerCase();
  const out: Rule[] = [];
  const any = (s: Set<string>) => {
    for (const v of s) if (t.includes(v)) return true;
    return false;
  };
  if (any(set.titles)) out.push("title");
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
  const i = argv.indexOf("--store");
  const storePath = i >= 0 ? argv[i + 1] : undefined;
  const paths = argv.filter((_, j) => i < 0 || (j !== i && j !== i + 1));
  if (!storePath || !paths.length) {
    console.error("usage: node src/publish/identifiers.ts --store <store.json> <path>...");
    return 2;
  }
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const set = buildIdentifierSet({ projects: store.projects ?? [], frame: store.frame ?? [], extra: store.extra ?? [] });
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
