// codebook.md's structural validator (CDB-01, CDB-02, CDB-04, D-35). Reuses
// spike-record.mjs's fenced-JSON parsing — never duplicates the regex.

import fs from "node:fs";

import { extractJsonBlock } from "./spike-record.mjs";

export const RELATION_TYPES = ["addresses", "supports", "partial"];
const CROSSWALK_STANDARDS = ["iso42001", "gaicc", "nistAiRmf", "euAiAct", "oecd"];
const CHECK_STRING_FIELDS = ["decision", "label", "operationalDefinition", "passRule", "failRule", "claimedRule", "notApplicableNote"];
const EDGE_STRING_FIELDS = ["source_id", "title", "locator", "source_version", "qualification"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isStrArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isStr);

/**
 * Read decision-gates.json directly and flatten its 24 check ids, in file
 * order, deduplicated — the same traversal as coding/contract.ts's
 * loadGateFile, re-implemented here in plain JS since scripts/ stays
 * dependency-free of the TypeScript pipeline tree.
 */
export function loadCheckIds(gatesPath) {
  const json = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  const ids = [];
  const seen = new Set();
  for (const decision of Object.values(json.decisions ?? {})) {
    for (const check of decision.requiredChecks ?? []) {
      if (typeof check?.id === "string" && !seen.has(check.id)) {
        seen.add(check.id);
        ids.push(check.id);
      }
    }
  }
  return ids;
}

/** One crosswalk edge: required fields, and relation_type one of the three D-35 values (no per-standard branch). */
function validateEdge(edge, at, out) {
  if (!isObj(edge)) {
    out.push(`${at}: must be an object`);
    return;
  }
  for (const field of EDGE_STRING_FIELDS) {
    if (!isStr(edge[field])) out.push(`${at}.${field}: must be a non-empty string`);
  }
  if (!RELATION_TYPES.includes(edge.relation_type)) {
    out.push(`${at}.relation_type: must be one of ${RELATION_TYPES.join(", ")}`);
  }
}

/**
 * Returns an array of violation strings (empty when valid): relationTypes
 * deep-equals the three D-35 values, checks has exactly one key per
 * checkIds (every missing/extra id named individually), and each check
 * entry's required fields, anchors and 5-standard crosswalk are present
 * and well-formed (CDB-04).
 */
export function validateCodebook(obj, checkIds) {
  const out = [];
  if (!isObj(obj)) {
    out.push("codebook: the json block must be an object");
    return out;
  }
  if (JSON.stringify(obj.relationTypes) !== JSON.stringify(RELATION_TYPES)) {
    out.push(`relationTypes: must deep-equal ${JSON.stringify(RELATION_TYPES)}`);
  }

  if (!isObj(obj.checks)) {
    out.push("checks: must be an object");
    return out;
  }
  const checks = obj.checks;
  const idSet = new Set(checkIds);
  const keySet = new Set(Object.keys(checks));
  for (const id of checkIds) {
    if (!keySet.has(id)) out.push(`checks: missing required check "${id}"`);
  }
  for (const key of keySet) {
    if (!idSet.has(key)) out.push(`checks: unexpected extra check "${key}"`);
  }

  for (const [id, entry] of Object.entries(checks)) {
    const at = `checks.${id}`;
    if (!isObj(entry)) {
      out.push(`${at}: must be an object`);
      continue;
    }
    for (const field of CHECK_STRING_FIELDS) {
      if (!isStr(entry[field])) out.push(`${at}.${field}: must be a non-empty string`);
    }
    if (!isObj(entry.anchors)) {
      out.push(`${at}.anchors: must be an object`);
    } else {
      if (!isStrArray(entry.anchors.positive)) out.push(`${at}.anchors.positive: must be a non-empty string array`);
      if (!isStrArray(entry.anchors.negative)) out.push(`${at}.anchors.negative: must be a non-empty string array`);
    }
    if (!isObj(entry.crosswalk)) {
      out.push(`${at}.crosswalk: must be an object`);
      continue;
    }
    for (const standard of CROSSWALK_STANDARDS) {
      const edges = entry.crosswalk[standard];
      if (!Array.isArray(edges) || edges.length === 0) {
        out.push(`${at}.crosswalk.${standard}: must be a non-empty array`);
        continue;
      }
      edges.forEach((edge, i) => validateEdge(edge, `${at}.crosswalk.${standard}[${i}]`, out));
    }
    for (const key of Object.keys(entry.crosswalk)) {
      if (!CROSSWALK_STANDARDS.includes(key)) out.push(`${at}.crosswalk: unexpected extra standard key "${key}"`);
    }
  }

  return out;
}

/**
 * Parse codebook.md's fenced json block and validate it. Returns the
 * violations array (or a single parse-error element), matching
 * check-spike-records.mjs's lintRecordText return shape.
 */
export function lintCodebookText(md, checkIds) {
  let obj;
  try {
    obj = extractJsonBlock(md);
  } catch (err) {
    return [err.message];
  }
  return validateCodebook(obj, checkIds);
}
