// Protocol §11 / APP-03 / D-81 (plan 07-14): a $0 pattern pass over the stored own-site spans.
// A candidate is only a suggestion with its quote and URL; a role decides it (A6) before it
// becomes an identifiable basis. Only span text from the project's own collected pages is read,
// never a founder or any field outside the spans.

export interface OwnSpan {
  projectId: string;
  spanId: string;
  text: string;
  url: string | null;
}

export type CandidatePattern = "employees" | "funding" | "listed";

export interface WellKnownCandidate {
  projectId: string;
  spanId: string;
  url: string | null;
  pattern: CandidatePattern;
  /** The matched words with a little context, cut from the span. */
  quote: string;
}

export interface SponsorMention {
  projectId: string;
  spanId: string;
  url: string | null;
  sponsor: string;
}

/** D-81: the hackathon's sponsor ecosystem. */
export const SPONSORS: { name: string; re: RegExp }[] = [
  { name: "Nebius", re: /\bnebius\b/i },
  { name: "Tavily", re: /\btavily\b/i },
  { name: "NVIDIA", re: /\bnvidia\b|\bnemotron\b/i },
  { name: "LangSmith", re: /\blangsmith\b/i },
  { name: "Toloka", re: /\btoloka\b/i },
  { name: "Tandem", re: /\btandem\b/i },
];

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand)?\+?`;
const EMPLOYEES = new RegExp(String.raw`${NUM}\s*(?:full[- ]time\s+)?(?:employees|staff|people on (?:our|the) team|team members)\b`, "gi");
const MONEY = String.raw`(?:\$|USD\s?|US\$)\s?(\d+(?:\.\d+)?)\s*(m|mm|million|b|bn|billion)\b`;
const FUNDING = [
  new RegExp(String.raw`\b(?:raised|raising|funding of|backed (?:with|by))\b[^.]{0,40}?${MONEY}`, "gi"),
  new RegExp(String.raw`${MONEY}[^.]{0,30}?\b(?:seed|series [a-e]|funding|round|investment)\b`, "gi"),
];
const LISTED = /\b(?:NASDAQ|NYSE|LSE|TSX|ASX|HKEX|Euronext)\s*:\s*[A-Z]{1,5}\b|\bpublicly (?:traded|listed)\b/g;

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function employees(m: RegExpExecArray): number {
  const n = Number(m[1]!.replace(/,/g, ""));
  return m[2] ? n * 1000 : n;
}

function millions(amount: string, unit: string): number {
  return Number(amount) * (/^b/i.test(unit) ? 1000 : 1);
}

/** §11 candidates: 50 or more employees, $10M or more raised, or a stock listing, on the project's own pages. */
export function wellKnownCandidates(spans: OwnSpan[]): WellKnownCandidate[] {
  const out: WellKnownCandidate[] = [];
  for (const s of spans) {
    // One candidate per span and pattern: a decision reads the quote, not a count of matches.
    const seen = new Set<CandidatePattern>();
    const add = (pattern: CandidatePattern, m: RegExpExecArray) => {
      if (seen.has(pattern)) return;
      seen.add(pattern);
      out.push({ projectId: s.projectId, spanId: s.spanId, url: s.url, pattern, quote: quoteAround(s.text, m.index, m[0].length) });
    };
    for (const m of s.text.matchAll(EMPLOYEES)) if (employees(m) >= 50) add("employees", m);
    for (const re of FUNDING) for (const m of s.text.matchAll(re)) if (millions(m[1]!, m[2]!) >= 10) add("funding", m);
    for (const m of s.text.matchAll(LISTED)) add("listed", m);
  }
  return out;
}

/** D-81: spans naming a sponsor; a flagged project stays de-identified (sponsor hold) until Helen decides. */
export function sponsorMentions(spans: OwnSpan[]): SponsorMention[] {
  const out: SponsorMention[] = [];
  for (const s of spans) for (const sp of SPONSORS) if (sp.re.test(s.text)) out.push({ projectId: s.projectId, spanId: s.spanId, url: s.url, sponsor: sp.name });
  return out;
}
