// Matrices remain ordinary JSON, reviewed separately and bound into the final manifest.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const FORMAT = "signed-matrix-manifest-v1";
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const fail = (reason: string): never => { throw new Error(`gate review bundle: ${reason}`); };
const MATRIX_NAMES = ["published", "second-vs-gold", "second-vs-primary"] as const;
type MatrixName = typeof MATRIX_NAMES[number] | "revalidation";
const INLINE_METRICS = new Set(["n", "ac1", "precision", "goldPasses", "estimable"]);
const METRICS = ["n", "pa", "ac1", "kappa", "precision", "recall", "goldPasses", "coderPasses", "fourStateAc1", "fourStatePa", "fourStateKappa", "estimable",
  "ac1CI", "precisionCI", "recallCI", "kappaCI", "paCI", "fourStateAc1CI", "fourStatePaCI", "fourStateKappaCI"];
const itemFor = (name: string) => `VAL-07 gate matrix (${name})`;
const object = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v);
function exactKeys(value: any, keys: string[]): boolean {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function jsonCopy(value: any): any {
  let copy: any;
  try { copy = JSON.parse(JSON.stringify(value)); } catch { return fail("document is not JSON"); }
  if (!isDeepStrictEqual(value, copy)) fail("document contains values JSON cannot preserve");
  return copy;
}
function metric(row: any, allowExtra = false): void {
  if (!object(row) || typeof row.checkId !== "string" || !row.checkId || METRICS.some(k => !Object.hasOwn(row, k)) ||
      (!allowExtra && !exactKeys(row, ["checkId", ...METRICS]))) fail("incomplete or unknown metric fields");
  for (const key of METRICS) {
    const value = row[key];
    if (key === "estimable") { if (typeof value !== "boolean") fail("invalid estimability flag"); }
    else if (key.endsWith("CI")) {
      if (value !== null && (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== "number" || !Number.isFinite(v)))) fail("invalid metric interval");
    } else if (["n", "goldPasses", "coderPasses"].includes(key)) {
      if (!Number.isInteger(value) || value < 0) fail("invalid metric count");
    } else if (!(value === null && ["kappa", "precision", "recall", "fourStateKappa"].includes(key)) &&
        (typeof value !== "number" || !Number.isFinite(value))) fail("invalid metric value");
  }
}
function primaryShape(gate: any): string[] {
  if (!object(gate) || !Array.isArray(gate.checks) || !gate.checks.length || !object(gate.secondModel)) fail("missing primary gate or second-model metadata");
  const ids: string[] = [];
  for (const row of gate.checks) {
    metric(row, true);
    if (typeof row.status !== "string" || !row.status || ids.includes(row.checkId)) fail("invalid primary check status or duplicate check");
    ids.push(row.checkId);
  }
  metric(gate.pooled);
  return ids;
}
function matrixShape(matrix: any, ids: string[]): void {
  if (!exactKeys(matrix, ["checks", "pooled"]) || !Array.isArray(matrix.checks) || matrix.checks.length !== ids.length) fail("missing or unknown matrix fields");
  matrix.checks.forEach((row: any, i: number) => {
    metric(row);
    if (row.checkId !== ids[i]) fail("matrix check IDs differ from primary order");
  });
  metric(matrix.pooled);
}
function matrixAt(gate: any, name: MatrixName): any {
  if (name === "revalidation") return gate.recomputedRevalidation;
  return name === "published" ? gate.published : gate.secondModel[name === "second-vs-gold" ? "vsGold" : "vsPrimary"];
}
function replaceMatrix(gate: any, name: MatrixName, value: any): void {
  if (name === "revalidation") { gate.recomputedRevalidation = value; return; }
  if (name === "published") gate.published = value;
  else gate.secondModel[name === "second-vs-gold" ? "vsGold" : "vsPrimary"] = value;
}
function validationDir(dir: string): string {
  const real = fs.realpathSync(dir);
  if (path.basename(real) !== "validation" || real.split(path.sep).some(p => ["backups", "archives"].includes(p))) fail("components require a current validation directory");
  return real;
}

export type GateReviewComponent = { name: string; basename: string; path: string; doc: string; docDigest: string; item: string };
function primaryInline(matrix: any): any {
  const row = (value: any) => Object.fromEntries(Object.entries(value).filter(([key]) => !METRICS.includes(key) || INLINE_METRICS.has(key)));
  return { checks: matrix.checks.map(row), pooled: row(matrix.pooled) };
}

/** Writes complete content-addressed matrices without changing any gate value. Existing files are immutable. */
export function prepareGateReviewBundle(gate: any, dir: string, options: { primaryMetrics?: boolean } = {}): { manifest: any; manifestText: string; components: GateReviewComponent[] } {
  const manifest = jsonCopy(gate);
  if (["reviewFormat", "completeGateDigest", "primaryMetrics"].some(key => Object.hasOwn(manifest, key))) fail("reserved manifest fields already exist");
  const ids = primaryShape(manifest);
  const names: MatrixName[] = [...MATRIX_NAMES, ...(Object.hasOwn(manifest, "recomputedRevalidation") ? ["revalidation" as const] : [])];
  for (const name of names) matrixShape(matrixAt(manifest, name), ids);
  const root = validationDir(dir);
  const components: GateReviewComponent[] = [];
  const write = (name: string, matrix: any) => {
    const doc = JSON.stringify(matrix) + "\n";
    const docDigest = sha(doc);
    const basename = `gate-review-${name}-${docDigest}.json`;
    const file = path.join(root, basename);
    try { fs.writeFileSync(file, doc, { flag: "wx", mode: 0o600 }); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file || fs.readFileSync(file, "utf8") !== doc) fail("immutable component already differs");
    }
    const item = itemFor(name);
    components.push({ name, basename, path: file, doc, docDigest, item });
    return { $ref: basename, docDigest, item };
  };
  for (const name of names) replaceMatrix(manifest, name, write(name, matrixAt(manifest, name)));
  if (options.primaryMetrics) {
    const matrix = { checks: manifest.checks, pooled: manifest.pooled };
    manifest.primaryMetrics = write("primary", matrix);
    Object.assign(manifest, primaryInline(matrix));
  }
  manifest.reviewFormat = FORMAT;
  manifest.completeGateDigest = sha(JSON.stringify(gate));
  return { manifest, manifestText: JSON.stringify(manifest) + "\n", components };
}

/** Caller first verifies the exact final manifest approval. This verifies every attached approval and full reconstruction. */
export function expandGateReviewBundle(manifest: any, dir: string, signoffPath?: string): any {
  if (!object(manifest)) return fail("invalid gate document");
  if (!Object.hasOwn(manifest, "reviewFormat")) return manifest;
  if (manifest.reviewFormat !== FORMAT || typeof manifest.completeGateDigest !== "string" || !/^[a-f0-9]{64}$/.test(manifest.completeGateDigest)) fail("unknown format or complete gate digest");
  if (typeof signoffPath !== "string" || !signoffPath) return fail("an explicit component approval ledger is required");
  const expanded = jsonCopy(manifest);
  const root = validationDir(dir);
  const records = fs.readFileSync(signoffPath, "utf8").split(/\r?\n/).filter(Boolean).map((line, order) => ({ ...JSON.parse(line), order }));
  const read = (name: string, ref: any) => {
    if (!exactKeys(ref, ["$ref", "docDigest", "item"]) || typeof ref.docDigest !== "string" || !/^[a-f0-9]{64}$/.test(ref.docDigest) ||
        ref.$ref !== `gate-review-${name}-${ref.docDigest}.json` || ref.item !== itemFor(name)) fail("invalid component reference fields or path");
    const file = path.join(root, ref.$ref);
    if (fs.realpathSync(file) !== file || fs.lstatSync(file).isSymbolicLink()) fail("component is outside its validation containment");
    const text = fs.readFileSync(file, "utf8");
    if (sha(text) !== ref.docDigest) fail("component digest mismatch");
    const approvals = records.filter(row => row.item === ref.item && row.docDigest === ref.docDigest);
    if (approvals.some(row => !Number.isFinite(Date.parse(row.decidedAt)))) fail("component approval timestamp is invalid");
    approvals.sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt) || b.order - a.order);
    if (approvals[0]?.decision !== "approved") fail("component approval missing or rejected");
    return JSON.parse(text);
  };
  if (Object.hasOwn(expanded, "primaryMetrics")) {
    const primary = read("primary", expanded.primaryMetrics);
    if (!exactKeys(primary, ["checks", "pooled"]) || !Array.isArray(primary.checks)) fail("invalid primary component");
    if (!isDeepStrictEqual(primaryInline(primary), { checks: expanded.checks, pooled: expanded.pooled })) fail("inline primary decisions or metrics conflict with component");
    Object.assign(expanded, primary);
    delete expanded.primaryMetrics;
  }
  const ids = primaryShape(expanded);
  const names: MatrixName[] = [...MATRIX_NAMES, ...(Object.hasOwn(expanded, "recomputedRevalidation") ? ["revalidation" as const] : [])];
  for (const name of names) {
    const matrix = read(name, matrixAt(expanded, name));
    matrixShape(matrix, ids);
    replaceMatrix(expanded, name, matrix);
  }
  delete expanded.reviewFormat;
  delete expanded.completeGateDigest;
  if (sha(JSON.stringify(expanded)) !== manifest.completeGateDigest) fail("complete gate digest mismatch");
  return expanded;
}
