// Publication requires independently approved guidance and recomputed fresh evidence.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import type { Codebook } from "./coding/codebook-prompt.ts";
import { buildContract } from "./coding/contract.ts";
import { PINNED_MODEL } from "./coding/nebius-client.ts";
import { uniqueProjectSpans } from "./coding/span-packing.ts";
import { projectSpans, spansDigest } from "./confirm/confirm.ts";
import { buildCodingMessages, chunkSpans, type CodingGuidance } from "./run.ts";
import { ARTCRAFT_HN_ID, GOLD_SEED, SAMPLING_SEED } from "./select/draw-sample.ts";
import { SIGNOFF_MODEL } from "./signoff/signoff.ts";
import { agreementByCheck, type AgreementRow } from "./validate/agreement.ts";
import { validateFreshSample } from "./validate/fresh-validation.ts";

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const hash = (value: unknown) => sha(JSON.stringify(value));
const fail = (reason: string): never => { throw new Error(`revalidation proof: ${reason}`); };
const states = new Set(["pass", "fail", "unknown", "claimed"]);
export type RevalidationProofOptions = { guidancePath: string; proposalPath: string; samplingSourcePath: string; signoffPath: string };

export async function verifyRevalidationProof(o: {
  db: Kysely<any>; dataDir: string; codebook: Codebook; checkIds: string[]; sampleNs: number[];
  freshNs: number[]; cutoff: number; proof: RevalidationProofOptions;
}) {
  const root = fs.realpathSync(o.dataDir), validation = fs.realpathSync(path.join(root, "validation"));
  const read = (file: string, parent: string) => {
    const absolute = path.resolve(file), real = fs.realpathSync(absolute);
    if (path.dirname(real) !== parent || fs.lstatSync(absolute).isSymbolicLink() || path.extname(real) !== ".json") return fail("invalid retained document path");
    const text = fs.readFileSync(real, "utf8"); return { text, value: JSON.parse(text) };
  };
  const guidanceFile = read(o.proof.guidancePath, validation), proposal = read(o.proof.proposalPath, validation);
  const source = read(o.proof.samplingSourcePath, validation);
  const guidance = guidanceFile.value;
  if (typeof guidance?.version !== "string" || !guidance.version || !guidance.checks || typeof guidance.checks !== "object" || Array.isArray(guidance.checks) ||
      !Object.keys(guidance.checks).length || Object.entries(guidance.checks).some(([id, text]) => !o.checkIds.includes(id) || typeof text !== "string" || !text.trim())) fail("invalid approved guidance");
  const job = proposal.value;
  if (job?.doc !== guidanceFile.text || job.item !== `Codebook correction ${guidance.version}` || typeof job.context !== "string" || !job.context) fail("proposal does not bind exact guidance bytes");
  const journal = path.join(root, "decisions", "release-signoff.jsonl");
  if (path.basename(o.proof.signoffPath) !== "release-signoff.jsonl" || fs.realpathSync(o.proof.signoffPath) !== journal || fs.lstatSync(o.proof.signoffPath).isSymbolicLink()) fail("only the explicit release approval journal is permitted");
  const docDigest = sha(job.doc), inputDigest = hash({ doc: job.doc, context: job.context, item: job.item });
  const approvals = fs.readFileSync(journal, "utf8").split(/\r?\n/).filter(Boolean).map((line, order) => ({ ...JSON.parse(line), order }))
    .filter(row => row.item === job.item && row.docDigest === docDigest);
  if (approvals.some(row => !Number.isFinite(Date.parse(row.decidedAt)))) fail("invalid approval timestamp");
  approvals.sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt) || b.order - a.order);
  const approval = approvals[0], approvedAt = Date.parse(approval?.decidedAt);
  if (approval?.decision !== "approved" || approval.inputDigest !== inputDigest || approvedAt < o.cutoff || approvedAt > Date.now() + 60_000 ||
      approval.reviewer?.kind !== "agent" || approval.reviewer.modelId !== SIGNOFF_MODEL || approval.reviewer.id !== `agent:${SIGNOFF_MODEL}`) fail("current exact guidance lacks independent approval");
  const pipeline = fs.realpathSync(path.join(root, "pipeline"));
  const draw = read(path.join(pipeline, "fresh-projects.json"), pipeline);
  const marker = read(path.join(pipeline, "fresh-validation-sample.json"), pipeline).value;
  const s = source.value;
  if (!Array.isArray(s?.posts) || !Array.isArray(s.previousEntries) || !Array.isArray(s.previousLog) || marker.version !== 1 || marker.seed !== SAMPLING_SEED || marker.perQuarter !== 19 ||
      marker.entriesDigest !== hash(draw.value) || marker.sourceDigest !== hash({ seed: SAMPLING_SEED, perQuarter: 19, posts: s.posts, previousEntries: s.previousEntries, previousLog: s.previousLog })) fail("fresh sampling provenance differs");
  validateFreshSample(draw.value, s.previousEntries, s.previousLog);
  if (draw.value.some((entry: any) => !s.posts.some((post: any) => String(post.id) === String(entry.hn_id) && post.created_at === entry.created_at))) fail("fresh project is absent from the retained frame");
  if (o.sampleNs.length !== 300 || s.previousEntries.some((entry: any, i: number) => entry.n !== i + 1 || !o.sampleNs.includes(entry.n)) ||
      draw.value.length !== o.freshNs.length || draw.value.some((entry: any) => !o.freshNs.includes(entry.n))) fail("fresh sample is not the registered original-sample continuation");
  const ns = [...o.sampleNs, ...o.freshNs];
  const projects = await o.db.selectFrom("pipeline_project_results").selectAll().where("project_n", "in", ns).execute();
  const coding = await o.db.selectFrom("pipeline_check_states").selectAll().where("project_n", "in", o.freshNs).execute();
  const outcomes = await o.db.selectFrom("pipeline_gold_outcomes").selectAll().where("project_n", "in", o.freshNs).execute();
  const labels = await o.db.selectFrom("pipeline_gold_labels").selectAll().where("project_n", "in", o.freshNs).execute();
  const guidanceRuntime: CodingGuidance = { version: guidance.version, byCheck: guidance.checks };
  const applicable = new Set<string>(Object.keys(guidance.checks));
  const rows: AgreementRow[] = [], noGold: number[] = [], excludedA3: number[] = [];
  const bindingRows: unknown[] = [];
  const currentProject = (n: number) => {
    const manifest = read(path.join(pipeline, "manifests", `${n}.json`), path.join(pipeline, "manifests")).value;
    for (const h of manifest.snapshotHashesInCollectionOrder ?? []) {
      if (typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h)) fail("invalid source hash");
      const snapshot = read(path.join(pipeline, "snapshots", `${h}.json`), path.join(pipeline, "snapshots")).value;
      if (typeof snapshot.redactedText !== "string" || sha(snapshot.redactedText) !== h) fail("current source integrity mismatch");
    }
    const spans = projectSpans(root, n), record = projects.find(row => row.project_n === n);
    return { manifest, spans, record };
  };
  const promptHash = (spans: { id: string; text: string }[], ids: string[], g: CodingGuidance) => {
    const schema = buildContract(ids).jsonSchema;
    return hash({ schema, guidance: g, messages: chunkSpans(uniqueProjectSpans(spans)).map(chunk => buildCodingMessages(ids, o.codebook, schema, chunk, g)) });
  };
  for (const entry of draw.value) {
    const { manifest, spans, record } = currentProject(entry.n);
    if (String(manifest.hnId) !== String(entry.hn_id) || String(record?.hn_id) !== String(entry.hn_id)) fail("fresh project identity differs");
    if (String(entry.hn_id) === ARTCRAFT_HN_ID) { excludedA3.push(entry.n); continue; }
    if (!record || record.model_id !== PINNED_MODEL || record.codebook_version !== o.codebook.codebookVersion || !Number.isFinite(Date.parse(record.completed_at)) || Date.parse(record.completed_at) < approvedAt ||
        record.snapshot_hashes_json !== JSON.stringify(manifest.snapshotHashesInCollectionOrder) || record.prompt_hash !== promptHash(spans, o.checkIds, guidanceRuntime) ||
        (spans.length > 0 && record.coding_all_unknown !== 0) || manifest.codingCorrection?.version !== guidance.version ||
        hash(manifest.codingCorrection?.checks) !== hash(Object.keys(guidance.checks))) fail("fresh coding is not the current approved guided request");
    const digest = spansDigest(spans), ids = new Set(spans.map(s => s.id));
    const resolves = (row: any): boolean => {
      try { const cited = JSON.parse(row?.span_ids_json); return states.has(row?.filtered_state) && Array.isArray(cited) && cited.every(id => typeof id === "string" && ids.has(id)) && (row.filtered_state === "unknown" ? cited.length === 0 : cited.length > 0); }
      catch { return false; }
    };
    const primary = coding.filter(row => row.project_n === entry.n);
    if (o.checkIds.some(id => !resolves(primary.find(row => row.check_id === id)))) fail("fresh primary coding is incomplete or stale");
    const outcome = outcomes.find(row => row.project_n === entry.n && row.codebook_version === o.codebook.codebookVersion && row.labeller_id === "agent:ollama:glm-5.3-flash:cloud" && row.input_digest === digest);
    if (!outcome) return fail("fresh gold outcome is incomplete or stale");
    if (!Number.isFinite(Date.parse(outcome.decided_at)) || Date.parse(outcome.decided_at) < approvedAt || !["labelled", "no-gold"].includes(outcome.outcome)) fail("fresh gold outcome is incomplete or stale");
    bindingRows.push({ n: entry.n, digest, record, primary, outcome });
    if (outcome.outcome === "no-gold") { noGold.push(entry.n); continue; }
    const gold = labels.filter(row => row.project_n === entry.n && row.codebook_version === o.codebook.codebookVersion && row.labeller_id === "agent:ollama:glm-5.3-flash:cloud" && row.provider === "ollama" && row.model_id === "glm-5.3-flash:cloud" && row.reasoning === "low" && row.input_digest === digest && Date.parse(row.labelled_at) >= approvedAt && resolves(row));
    if (o.checkIds.some(id => !gold.find(row => row.check_id === id))) fail("fresh gold labels are incomplete or stale");
    bindingRows.push(gold);
    for (const id of o.checkIds) rows.push({ projectN: entry.n, checkId: id, a: primary.find(row => row.check_id === id)!.filtered_state, b: gold.find(row => row.check_id === id)!.filtered_state });
  }
  for (const n of o.sampleNs) {
    const { manifest, spans, record } = currentProject(n);
    if (String(manifest.hnId) === ARTCRAFT_HN_ID) continue;
    const correction = manifest.codingCorrection;
    const ids = correction?.checks;
    const validScope = Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => Object.hasOwn(guidance.checks, id));
    const g = validScope ? { version: guidance.version, byCheck: Object.fromEntries(ids.map(id => [id, guidance.checks[id]])) } : undefined;
    const valid = validScope && correction.version === guidance.version && record?.model_id === PINNED_MODEL && record?.codebook_version === o.codebook.codebookVersion &&
      Number.isFinite(Date.parse(record.completed_at)) && Date.parse(record.completed_at) >= approvedAt && record.snapshot_hashes_json === JSON.stringify(manifest.snapshotHashesInCollectionOrder) && record.prompt_hash === promptHash(spans, ids, g!);
    for (const id of applicable) if (!valid || !ids.includes(id)) applicable.delete(id);
  }
  const metrics = agreementByCheck(rows, o.checkIds, GOLD_SEED, 2000);
  return { metrics, appliedCheckIds: [...applicable], evidence: { guidanceDigest: docDigest, proposalDigest: sha(proposal.text), approvalInputDigest: inputDigest, sourceDigest: marker.sourceDigest,
    sampleDigest: marker.entriesDigest, currentEvidenceDigest: hash(bindingRows), pairedProjects: new Set(rows.map(r => r.projectN)).size, noGoldProjects: noGold.length, excludedA3Projects: excludedA3.length } };
}
