// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const DEFAULT_PUBLICATION_URL = "https://alreadyopen.github.io/ai-output-to-value/";

const bundledClaimSchema = JSON.parse(
  readFileSync(new URL("../schemas/v1/claim.schema.json", import.meta.url), "utf8")
);
const bundledGates = JSON.parse(
  readFileSync(new URL("../schemas/v1/decision-gates.json", import.meta.url), "utf8")
);
const validatorCache = new WeakMap();

export async function fetchJson(baseUrl, path) {
  const url = new URL(path, baseUrl).href;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

export function loadBundledGates() {
  return bundledGates;
}

export function loadBundledClaimSchema() {
  return bundledClaimSchema;
}

export async function loadGateContract({ liveRules = false, publicationUrl = DEFAULT_PUBLICATION_URL } = {}) {
  if (liveRules) {
    const [gates, claimSchema] = await Promise.all([
      fetchJson(publicationUrl, "api/v1/gates.json"),
      fetchJson(publicationUrl, "schemas/v1/claim.schema.json")
    ]);
    return { gates, claimSchema, rulesSource: "live-publication" };
  }

  return {
    gates: bundledGates,
    claimSchema: bundledClaimSchema,
    rulesSource: "bundled"
  };
}

// The exact characters that make a required text field "blank". Explicit rather
// than String.trim()/str.strip(), whose sets differ. Keep identical to BLANK_CHARS
// in scripts/claim_gate.py; the conformance fixture checks both.
const BLANK_CHARS = new Set(
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006" +
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
);

function isBlank(value) {
  for (const char of value) if (!BLANK_CHARS.has(char)) return false;
  return true;
}

const REQUIRED_TEXT_FIELDS = ["project", "intendedUse", "authority", "accountability", "nextEvidence", "stopRule"];

function validatorFor(claimSchema) {
  if (!claimSchema || typeof claimSchema !== "object") return null;
  let validate = validatorCache.get(claimSchema);
  if (!validate) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validate = ajv.compile(claimSchema);
    validatorCache.set(claimSchema, validate);
  }
  return validate;
}

function schemaErrors(record, claimSchema = bundledClaimSchema) {
  const validate = validatorFor(claimSchema);
  if (!validate) return ["claim.schema.json <root>: claim schema is unavailable"];
  validate(record);
  return (validate.errors ?? []).map((error) => {
    const location = error.instancePath ? error.instancePath.replace(/^\//, "") : "<root>";
    return `claim.schema.json ${location}: ${error.message}`;
  });
}

function resultMetadata(gates) {
  const principle = gates?.principle ?? null;
  return {
    gateVersion: gates?.version ?? null,
    principle,
    rule: principle
  };
}

export function evaluateClaim(record, gates, claimSchema = bundledClaimSchema) {
  const decisionId = record?.targetDecision;
  const rule =
    typeof decisionId === "string" && gates?.decisions && Object.hasOwn(gates.decisions, decisionId)
      ? gates.decisions[decisionId]
      : undefined;
  const structuralErrors = schemaErrors(record, claimSchema);
  const missingFields = [];

  if (!rule) {
    structuralErrors.push(`unknown targetDecision: ${JSON.stringify(decisionId)}`);
    return {
      status: "BLOCKED",
      targetDecision: decisionId ?? null,
      errors: structuralErrors,
      structuralErrors,
      missingFields,
      claimMismatch: false,
      failedChecks: [],
      unknownChecks: [],
      passedChecks: [],
      ...resultMetadata(gates)
    };
  }

  if (record?.requiredClaimLevel !== rule.requiredClaimLevel) {
    const message = `requiredClaimLevel must be ${rule.requiredClaimLevel} for ${decisionId}`;
    if (!structuralErrors.includes(message)) structuralErrors.push(message);
  }

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof record?.[field] === "string" && isBlank(record[field])) missingFields.push(field);
  }
  if (Array.isArray(record?.actors) && record.actors.length === 0) missingFields.push("actors");

  const claimMismatch = record?.assertedClaimLevel !== rule.requiredClaimLevel;
  const checks = record?.gateChecks && typeof record.gateChecks === "object" && !Array.isArray(record.gateChecks)
    ? record.gateChecks
    : {};
  const failedChecks = [];
  const unknownChecks = [];
  const passedChecks = [];

  for (const check of rule.requiredChecks ?? []) {
    const state = checks[check.id] ?? "unknown";
    const result = { id: check.id, label: check.label, state };
    if (state === "fail") failedChecks.push(result);
    else if (state === "pass") passedChecks.push(result);
    else unknownChecks.push(result);
  }

  let status = "PASS";
  if (structuralErrors.length || failedChecks.length) status = "BLOCKED";
  else if (unknownChecks.length || missingFields.length || claimMismatch) status = "INSUFFICIENT_EVIDENCE";

  return {
    status,
    targetDecision: decisionId,
    decisionLabel: rule.label,
    requiredClaimLevel: rule.requiredClaimLevel,
    assertedClaimLevel: record?.assertedClaimLevel ?? null,
    errors: structuralErrors,
    structuralErrors,
    missingFields,
    claimMismatch,
    failedChecks,
    unknownChecks,
    passedChecks,
    ...resultMetadata(gates)
  };
}

export function getStopRule(gates, decisionType) {
  const rule = gates?.decisions?.[decisionType];
  if (!rule) throw new Error(`Unknown decision type: ${decisionType}`);
  return {
    decisionType,
    ...rule,
    gateVersion: gates?.version ?? null,
    principle: gates.principle
  };
}
