// Redaction used before any fetched page is stored or sent to a model
// (research Pitfall 10, EVD-07 groundwork). Third-party page text can carry
// email addresses and phone numbers of individuals; PRISM keeps neither.
//
// Also exports scrubSecrets, which removes known secret values (and anything
// shaped like a Tavily or bearer token) from text that is about to be logged.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// Phone-like: an optional +country code, then digit groups joined by space,
// dot, dash or parentheses, with 9 to 15 digits in total. A bare run of digits
// (an id, a year range) is left alone unless it has a separator or a leading +.
const PHONE_RE = /(?<![\w./-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])(?:\d{2,4}[\s.-]?){1,4}\d{2,4}(?![\w-])/g;

export const EMAIL_PLACEHOLDER = "[email redacted]";
export const PHONE_PLACEHOLDER = "[phone redacted]";

function digitCount(s) {
  return (s.match(/\d/g) ?? []).length;
}

/** Returns { text, counts: { emails, phones } }. */
export function redactText(text) {
  let emails = 0;
  let phones = 0;
  let out = String(text).replace(EMAIL_RE, () => {
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
  return { text: out, counts: { emails, phones } };
}

const TOKEN_SHAPES = [/\btvly-[A-Za-z0-9_-]{6,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi];

/** Remove exact secret values and token-shaped strings from text bound for a log. */
export function scrubSecrets(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 6) out = out.split(s).join("[secret]");
  }
  for (const re of TOKEN_SHAPES) out = out.replace(re, "[secret]");
  return out;
}
