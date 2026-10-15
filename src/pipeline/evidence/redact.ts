// Redaction used before any fetched page is stored or sent to a model
// (EVD-07). Promoted from scripts/spikes/lib/redact.mjs verbatim, extended
// with the handle pattern approved in plan 02-01's checkpoint: a conservative
// @handle regex scoped to prose, excluding tokens inside fenced/inline
// Markdown code blocks and npm-scope-shaped @name/ tokens. A skipped near-miss
// (one that would have matched but for either exclusion) is counted in a
// separate nearMissHandles field, never silently dropped.
//
// Also exports scrubSecrets, which removes known secret values (and anything
// shaped like a Tavily or bearer token) from text that is about to be logged.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// Phone-like: an optional +country code, then digit groups joined by space,
// dot, dash or parentheses, with 9 to 15 digits in total. A bare run of digits
// (an id, a year range) is left alone unless it has a separator or a leading +.
const PHONE_RE = /(?<![\w./-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])(?:\d{2,4}[\s.-]?){1,4}\d{2,4}(?![\w-])/g;

// A conservative @handle: 2-30 word chars after the @. Matched globally so
// every candidate can be classified (prose / fenced-code / inline-code /
// npm-scope) before deciding whether to redact it.
const HANDLE_RE = /@[A-Za-z0-9_]{2,30}/g;

export const EMAIL_PLACEHOLDER = "[email redacted]";
export const PHONE_PLACEHOLDER = "[phone redacted]";
export const HANDLE_PLACEHOLDER = "[handle redacted]";

export interface RedactCounts {
  emails: number;
  phones: number;
  handles: number;
  nearMissHandles: number;
}

export interface RedactResult {
  text: string;
  counts: RedactCounts;
}

function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

/**
 * Spans of text that sit inside a fenced (``` ``` ```) or inline (single
 * backtick) Markdown code block. Fences are matched first and removed from
 * consideration so an inline backtick inside a fence does not confuse the
 * inline-span scan.
 */
function codeBlockRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const fenceRe = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  const insideFence = (i: number) => ranges.some((r) => i >= r.start && i < r.end);
  const inlineRe = /`[^`\n]+`/g;
  while ((m = inlineRe.exec(text))) {
    if (!insideFence(m.index)) ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

/** Returns { text, counts: { emails, phones, handles, nearMissHandles } }. */
export function redactText(text: string): RedactResult {
  const input = String(text);
  if (input.trim() === "") {
    return { text: input, counts: { emails: 0, phones: 0, handles: 0, nearMissHandles: 0 } };
  }

  let emails = 0;
  let phones = 0;
  let out = input.replace(EMAIL_RE, () => {
    emails += 1;
    return EMAIL_PLACEHOLDER;
  });
  out = out.replace(PHONE_RE, (m) => {
    const n = digitCount(m);
    // 9 to 15 digits, and not a date or a version-like pattern such as 2026-09-20.
    if (n < 9 || n > 15) return m;
    if (/^\d{4}-\d{2}-\d{2}$/.test(m.trim())) return m;
    phones += 1;
    return PHONE_PLACEHOLDER;
  });

  // Handles are resolved on the text as it stands after email/phone redaction,
  // so code-block ranges are computed against that same text.
  const ranges = codeBlockRanges(out);
  const insideCode = (i: number) => ranges.some((r) => i >= r.start && i < r.end);

  let handles = 0;
  let nearMissHandles = 0;
  let cursor = 0;
  let result = "";
  const handleRe = new RegExp(HANDLE_RE);
  let m: RegExpExecArray | null;
  while ((m = handleRe.exec(out))) {
    const idx = m.index;
    const token = m[0];
    const followedBySlash = out[idx + token.length] === "/";
    const inCode = insideCode(idx);
    result += out.slice(cursor, idx);
    if (followedBySlash) {
      // npm-scope-shaped token (@octokit/rest): never redacted, never counted
      // as a near-miss (excluded by the trailing-/ rule, not the code-fence rule).
      result += token;
    } else if (inCode) {
      // Skipped because it sits in a fenced/inline code block: left alone,
      // but counted as a visible near-miss, never silently dropped.
      nearMissHandles += 1;
      result += token;
    } else {
      handles += 1;
      result += HANDLE_PLACEHOLDER;
    }
    cursor = idx + token.length;
  }
  result += out.slice(cursor);

  return { text: result, counts: { emails, phones, handles, nearMissHandles } };
}

const TOKEN_SHAPES = [/\btvly-[A-Za-z0-9_-]{6,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi];

/** Remove exact secret values and token-shaped strings from text bound for a log. */
export function scrubSecrets(text: string, secrets: string[] = []): string {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 6) out = out.split(s).join("[secret]");
  }
  for (const re of TOKEN_SHAPES) out = out.replace(re, "[secret]");
  return out;
}
