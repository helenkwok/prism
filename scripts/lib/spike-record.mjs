// Spike record contract (decisions D-15, D-16, D-17, D-21).
//
// A spike record is a markdown file under spikes/ whose FIRST fenced json block
// is the machine-readable record. Prose after it is numbers-only commentary.
// Public spike records hold numbers only: no project URL, no key, no email, no
// raw page text.

const FENCE_RE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m;

/** Parse the first fenced json block. Throws when there is none or it is not valid JSON. */
export function extractJsonBlock(md) {
  const m = FENCE_RE.exec(md);
  if (!m) throw new Error("no fenced json block found");
  try {
    return JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`the first fenced json block is not valid JSON: ${err.message}`);
  }
}

/** Replace the first fenced json block with `obj`, preserving all surrounding prose. */
export function replaceJsonBlock(md, obj) {
  const m = FENCE_RE.exec(md);
  if (!m) throw new Error("no fenced json block found");
  const block = "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
  return md.slice(0, m.index) + block + md.slice(m.index + m[0].length);
}

// ---- numbers-only guard ----------------------------------------------------

export const ALLOWED_URL_HOSTS = [
  "docs.tavily.com",
  "api.tavily.com",
  "docs.tokenfactory.nebius.com",
  "api.tokenfactory.nebius.com",
  "api.tokenfactory.us-central1.nebius.com",
  "hn.algolia.com",
];

const URL_RE = /https?:\/\/[^\s"'<>)\]}\\]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/;
const KEY_ASSIGN_RE = /\b(?:NEBIUS_API_KEY|TAVILY_API_KEY)\b["']?\s*[:=]\s*["']?[^\s"',;]+/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const KEY_SHAPE_RE = /\btvly-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns an array of { rule, line } violations. The offending text is never
 * included, so lint output cannot itself leak what it found.
 */
export function numbersOnlyViolations(md) {
  const found = [];
  const lines = md.split(/\r?\n/);
  lines.forEach((text, i) => {
    const line = i + 1;
    for (const url of text.match(URL_RE) ?? []) {
      const host = hostOf(url);
      if (host === null || !ALLOWED_URL_HOSTS.includes(host)) {
        found.push({ rule: "url-not-on-provider-allow-list", line });
      }
    }
    if (EMAIL_RE.test(text)) found.push({ rule: "email-address", line });
    if (KEY_ASSIGN_RE.test(text)) found.push({ rule: "api-key-assignment", line });
    if (BEARER_RE.test(text)) found.push({ rule: "bearer-token", line });
    if (KEY_SHAPE_RE.test(text)) found.push({ rule: "key-or-token-shape", line });
  });
  return found;
}

/** Throws (with .violations) when the record text carries anything but numbers. */
export function assertNumbersOnly(md) {
  const violations = numbersOnlyViolations(md);
  if (violations.length > 0) {
    const err = new Error(
      "numbers-only guard: " + violations.map((v) => `${v.rule} (line ${v.line})`).join(", "),
    );
    err.violations = violations;
    throw err;
  }
}

// ---- record contract -------------------------------------------------------

export const RECORD_NAMES = ["nebius", "tavily", "docker-app"];

const OUTPUT_MODES = ["json_schema", "json_object"];
const ON_OFF = ["on", "off"];
const BATCH_STATUSES = ["completed", "failed", "cancelled", "expired", "rejected"];
const ZDR_STATUSES = ["on", "off", "unavailable"];
const COVERAGE = ["yes", "no", "unknown"];
const FALLBACK_STATES = ["not-needed", "triggered"];
const TYPE_CLASSES = ["own-domain", "shared-host", "repo-only", "spa", "redirect"];
const CRITERION_IDS = ["A", "B", "C"];
const CRITERION_OUTCOMES = ["met", "missed"];
const VERIFIER_KINDS = ["ci", "local"];
const SMOKE_KEYS = [
  "sign_in_200",
  "seeded_sign_in",
  "session_page",
  "pdf_magic",
  "sign_up_disabled",
  "gate_in_image",
  "non_root",
  "boot_fails_without_secret",
];
const MAX_STRING = 200; // a longer string in the json block looks like pasted page text

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
const isRate = (v) => isNum(v) && v >= 0 && v <= 1;

class Check {
  constructor() {
    this.out = [];
  }
  add(msg) {
    this.out.push(msg);
  }
  str(obj, key, at) {
    if (!isStr(obj?.[key])) this.add(`${at}.${key}: must be a non-empty string`);
  }
  num(obj, key, at) {
    if (!isNum(obj?.[key])) this.add(`${at}.${key}: must be a number`);
  }
  int(obj, key, at) {
    if (!Number.isInteger(obj?.[key]) || obj[key] < 0) this.add(`${at}.${key}: must be a non-negative integer`);
  }
  bool(obj, key, at) {
    if (typeof obj?.[key] !== "boolean") this.add(`${at}.${key}: must be a boolean`);
  }
  oneOf(obj, key, allowed, at) {
    if (!allowed.includes(obj?.[key])) this.add(`${at}.${key}: must be one of ${allowed.join(", ")}`);
  }
  date(obj, key, at) {
    if (!isDate(obj?.[key])) this.add(`${at}.${key}: must be an ISO date`);
  }
  obj(obj, key, at) {
    if (!isObj(obj?.[key])) {
      this.add(`${at === key ? key : `${at}.${key}`}: must be an object`);
      return false;
    }
    return true;
  }
  arr(obj, key, at) {
    if (!Array.isArray(obj?.[key])) {
      this.add(`${at === key ? key : `${at}.${key}`}: must be an array`);
      return false;
    }
    return true;
  }
}

function longStrings(value, at, c) {
  if (typeof value === "string") {
    if (value.length > MAX_STRING) c.add(`${at}: string longer than ${MAX_STRING} characters (raw text is not allowed in a public record)`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => longStrings(v, `${at}[${i}]`, c));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) longStrings(v, `${at}.${k}`, c);
  }
}

function validateNebius(o, c) {
  if (c.arr(o, "catalogue", "catalogue")) {
    if (o.catalogue.length < 1) c.add("catalogue: must have at least one entry");
    if (!o.catalogue.some((e) => typeof e?.id === "string" && e.id.startsWith("nvidia/"))) {
      c.add("catalogue: must contain at least one entry whose id starts with nvidia/");
    }
    o.catalogue.forEach((e, i) => {
      const at = `catalogue[${i}]`;
      if (!isObj(e)) return c.add(`${at}: must be an object`);
      c.str(e, "id", at);
      c.str(e, "host", at);
      c.num(e, "context_length", at);
      if (!(isStr(e.quantization) || e.quantization === null)) c.add(`${at}.quantization: must be a string or null`);
      if (!(isObj(e.pricing) || isNum(e.pricing))) c.add(`${at}.pricing: must be an object or a number`);
      c.arr(e, "supported_features", at);
      c.arr(e, "regions", at);
      c.str(e, "status", at);
    });
  }

  if (c.arr(o, "matrix", "matrix")) {
    if (o.matrix.length !== 12) c.add(`matrix: must contain exactly 12 entries (found ${o.matrix.length})`);
    const seen = new Set();
    o.matrix.forEach((e, i) => {
      const at = `matrix[${i}]`;
      if (!isObj(e)) return c.add(`${at}: must be an object`);
      c.str(e, "model", at);
      c.oneOf(e, "output_mode", OUTPUT_MODES, at);
      c.oneOf(e, "thinking", ON_OFF, at);
      c.int(e, "n", at);
      for (const k of ["json_parse_rate", "zod_valid_rate", "span_resolve_rate", "schema_valid_rate", "retry_rate"]) {
        if (e.n === 0 && e[k] === null) continue; // a configuration that could not run
        if (!isRate(e[k])) c.add(`${at}.${k}: must be a number between 0 and 1`);
      }
      c.obj(e, "finish_reasons", at);
      if (c.obj(e, "latency_ms", at)) {
        c.num(e.latency_ms, "p50", `${at}.latency_ms`);
        c.num(e.latency_ms, "p95", `${at}.latency_ms`);
      }
      if (c.obj(e, "tokens", at)) {
        c.num(e.tokens, "in", `${at}.tokens`);
        c.num(e.tokens, "out", `${at}.tokens`);
      }
      c.num(e, "cost_usd", at);
      const key = `${e.model}|${e.output_mode}|${e.thinking}`;
      if (seen.has(key)) c.add(`${at}: duplicates another entry with the same model, output_mode and thinking`);
      seen.add(key);
    });
  }

  if (c.arr(o, "escape_probe", "escape_probe") && o.escape_probe.length < 1) {
    c.add("escape_probe: must have at least one entry");
  }

  if (c.obj(o, "batch", "batch")) {
    c.str(o.batch, "submitted_at", "batch");
    if (!(o.batch.completed_at === null || isStr(o.batch.completed_at))) {
      c.add("batch.completed_at: must be a string or null");
    }
    c.oneOf(o.batch, "final_status", BATCH_STATUSES, "batch");
    c.obj(o.batch, "per_model", "batch");
    if (!(o.batch.price_ratio === null || isNum(o.batch.price_ratio))) {
      c.add("batch.price_ratio: must be a number or null");
    }
  }

  if (c.obj(o, "zdr", "zdr")) {
    c.oneOf(o.zdr, "status", ZDR_STATUSES, "zdr");
    c.date(o.zdr, "checked_on", "zdr");
  }
  if (c.obj(o, "credits", "credits")) {
    c.oneOf(o.credits, "ai_cloud_coverage", COVERAGE, "credits");
    c.date(o.credits, "checked_on", "credits");
  }
  c.obj(o, "rate_limits", "rate_limits");

  if (c.obj(o, "pinned", "pinned")) {
    const p = o.pinned;
    c.str(p, "model", "pinned");
    c.oneOf(p, "output_mode", OUTPUT_MODES, "pinned");
    c.oneOf(p, "thinking", ON_OFF, "pinned");
    c.str(p, "base_url", "pinned");
    c.str(p, "mode", "pinned");
    if (!isRate(p.retry_rate)) c.add("pinned.retry_rate: must be a number between 0 and 1");
    if (c.obj(p, "streak", "pinned")) {
      c.int(p.streak, "n", "pinned.streak");
      c.int(p.streak, "max_consecutive_valid", "pinned.streak");
    }
    if (Array.isArray(o.matrix) && isStr(p.model) && !o.matrix.some((e) => e?.model === p.model)) {
      c.add("pinned.model: must equal the model of a matrix entry");
    }
  }

  if (c.obj(o, "fallbacks", "fallbacks")) {
    c.oneOf(o.fallbacks, "batch", FALLBACK_STATES, "fallbacks");
    c.oneOf(o.fallbacks, "zdr", FALLBACK_STATES, "fallbacks");
  }
}

function validateTavily(o, c) {
  if (c.obj(o, "credit_balance_checked", "credit_balance_checked")) {
    c.date(o.credit_balance_checked, "checked_on", "credit_balance_checked");
    c.num(o.credit_balance_checked, "credits_or_usd", "credit_balance_checked");
  }
  if (c.obj(o, "criterion", "criterion")) {
    c.oneOf(o.criterion, "id", CRITERION_IDS, "criterion");
    c.oneOf(o.criterion, "outcome", CRITERION_OUTCOMES, "criterion");
  }

  let anyLeakAfterFilter = false;
  if (c.arr(o, "projects", "projects")) {
    if (o.projects.length !== 5) c.add(`projects: must contain exactly 5 entries (found ${o.projects.length})`);
    const classes = new Set();
    o.projects.forEach((p, i) => {
      const at = `projects[${i}]`;
      if (!isObj(p)) return c.add(`${at}: must be an object`);
      c.oneOf(p, "type_class", TYPE_CLASSES, at);
      if (classes.has(p.type_class)) c.add(`${at}.type_class: duplicates another project; each class appears once`);
      classes.add(p.type_class);
      if (c.obj(p, "preflight", at)) {
        c.bool(p.preflight, "robots_blocked", `${at}.preflight`);
        c.num(p.preflight, "redirect_hops", `${at}.preflight`);
        c.bool(p.preflight, "boundary_ok", `${at}.preflight`);
      }
      if (c.obj(p, "map", at)) c.num(p.map, "urls_returned", `${at}.map`);
      if (c.obj(p, "extract", at)) {
        for (const k of ["results", "failed", "empty", "advanced_retries"]) c.num(p.extract, k, `${at}.extract`);
      }
      if (c.obj(p, "leakage", at)) {
        for (const k of ["raw_offsite_in_map", "raw_offsite_in_results", "after_filter"]) c.num(p.leakage, k, `${at}.leakage`);
        if (isNum(p.leakage.after_filter) && p.leakage.after_filter > 0) anyLeakAfterFilter = true;
      }
      if (c.obj(p, "credits", at)) {
        c.num(p.credits, "per_call", `${at}.credits`);
        c.num(p.credits, "formula", `${at}.credits`);
        if (!(p.credits.account_delta === null || isNum(p.credits.account_delta))) {
          c.add(`${at}.credits.account_delta: must be a number or null`);
        }
        c.num(p.credits, "total", `${at}.credits`);
      }
      c.num(p, "wall_ms", at);
    });
  }

  if (c.obj(o, "controls", "controls")) {
    if (!("allow_external_true" in o.controls)) c.add("controls.allow_external_true: is required");
    if (!("search_fallback" in o.controls)) c.add("controls.search_fallback: is required");
  }
  if (c.obj(o, "aggregate", "aggregate")) {
    for (const k of ["median_credits", "p95_credits", "max_credits"]) c.num(o.aggregate, k, "aggregate");
  }
  c.bool(o, "blocks_phase2_collector", "");
  c.int(o, "corpus_pages", "");

  if (anyLeakAfterFilter && o.blocks_phase2_collector === false) {
    c.add("blocks_phase2_collector: must be true when any project has leakage.after_filter above 0 (D-16 stop condition)");
  }
}

function validateDocker(o, c) {
  if (c.obj(o, "base_image", "base_image")) {
    c.str(o.base_image, "tag", "base_image");
    c.str(o.base_image, "digest", "base_image");
  }
  c.num(o, "image_bytes", "");
  c.num(o, "build_seconds", "");
  if (c.obj(o, "smoke", "smoke")) {
    for (const k of SMOKE_KEYS) c.bool(o.smoke, k, "smoke");
  }
  if (c.obj(o, "verifier", "verifier")) {
    c.oneOf(o.verifier, "kind", VERIFIER_KINDS, "verifier");
    if (!(isStr(o.verifier.run_id) || isNum(o.verifier.run_id))) c.add("verifier.run_id: must be a string or number");
  }
  if (c.obj(o, "versions", "versions")) {
    c.str(o.versions, "node", "versions");
    c.str(o.versions, "python", "versions");
  }
  c.bool(o, "takumi_fallback_needed", "");
}

const FINAL_VALIDATORS = { nebius: validateNebius, tavily: validateTavily, "docker-app": validateDocker };

/**
 * Returns an array of violation strings (empty when valid). Each names the
 * offending key path or rule.
 */
export function validateRecord(name, obj, { requireFinal = false } = {}) {
  const c = new Check();
  if (!RECORD_NAMES.includes(name)) {
    c.add(`record: unknown record name (expected one of ${RECORD_NAMES.join(", ")})`);
    return c.out;
  }
  if (!isObj(obj)) {
    c.add("record: the json block must be an object");
    return c.out;
  }
  if (obj.record !== name) c.add(`record: must equal "${name}"`);
  c.oneOf(obj, "status", ["pending", "final"], "");
  c.date(obj, "updated", "");

  if (requireFinal && obj.status !== "final") c.add("status: must be final");
  if (obj.status === "final") FINAL_VALIDATORS[name](obj, c);
  longStrings(obj, "record", c); // raw text has no place in a record of any status
  // Tidy the leading dot produced by top-level keys.
  return c.out.map((m) => m.replace(/^\./, ""));
}
