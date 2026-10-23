#!/usr/bin/env node
// D-78 (a): the live run's CPU per project, at $0. One synthetic project goes
// through screen -> collect -> code -> filter -> gate -> confirm -> report view,
// with every model and network reply injected and the REAL gate (PRISM_PYTHON).
//
//   PRISM_PYTHON=<gate venv python> node scripts/measure-live-run.mjs --label <name>
//
// Before anything else is imported, global fetch is replaced by a stub that
// throws and DNS lookups by a stub that answers only *.example hosts, so a
// mocked measurement can never reach the network (T-07-42). The 1 rps host
// throttle of the own-site collector is real wall time, not CPU; it is
// reported separately as throttle_wall_ms (an estimate: one second per own-site
// request after the first). The Python gate runs as child processes: their CPU
// is not in cpu_ms; run this under /usr/bin/time to count it.
import dnsPromises from "node:dns/promises";

const blocked = { fetch: 0, dns: 0 };
globalThis.fetch = async (url) => {
  blocked.fetch += 1;
  throw new Error(`measure-live-run: real fetch attempted (${String(url).slice(0, 60)})`);
};
const realLookup = dnsPromises.lookup;
dnsPromises.lookup = async (hostname, opts) => {
  if (!String(hostname).endsWith(".example")) {
    blocked.dns += 1;
    throw new Error("measure-live-run: real DNS lookup attempted");
  }
  // Never contacted: every request to the host is answered by the injected fetch.
  const address = "93.184.215.14";
  return opts?.all ? [{ address, family: 4 }] : { address, family: 4 };
};
void realLookup;

const cpuAtStart = process.cpuUsage();
const { parseArgs } = await import("node:util");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { default: Database } = await import("better-sqlite3");
const { Kysely, SqliteDialect } = await import("kysely");
const { runPipeline } = await import("../src/pipeline/run.ts");
const { screenCandidate } = await import("../src/pipeline/select/screen-model.ts");
const { createClient, PINNED_BASE_URL } = await import("../src/pipeline/coding/nebius-client.ts");
const { loadGateFile, resolveGatesPath } = await import("../src/pipeline/coding/contract.ts");
const { loadCodebook } = await import("../src/pipeline/coding/codebook-prompt.ts");
const conf = await import("../src/pipeline/confirm/confirm.ts");
const { runGate } = await import("../src/pipeline/gate/run-gate.ts");
const { sourceFromStore } = await import("../src/report/source-from-store.ts");
const { buildReportView, loadGapText } = await import("../src/report/view.ts");

const { values } = parseArgs({ options: { label: { type: "string", default: "unlabelled" } } });
const python = process.env.PRISM_PYTHON;
if (!python) {
  console.error("measure-live-run: set PRISM_PYTHON to the gate venv's python (the real gate runs)");
  process.exit(2);
}

const HOST = "prism-measure.example";
const ORIGIN = `https://${HOST}`;
const PAGES = 20;

// ---- the synthetic site: robots.txt, sitemap.xml and 20 pages of about 9 KB with block structure ----
const TOPICS = ["model card", "evaluation", "data handling", "security", "pricing", "deployment", "support", "changelog", "privacy", "terms"];
function pagePath(i) {
  return i === 0 ? "/" : `/docs/page-${i}`;
}
function pageHtml(i) {
  const topic = TOPICS[i % TOPICS.length];
  const links = Array.from({ length: PAGES }, (_, j) => `<li><a href="${pagePath(j)}">Page ${j}</a></li>`).join("");
  const sections = [];
  for (let s = 0; sections.join("").length < 8500; s += 1) {
    sections.push(
      `<section><h2>${topic} section ${s} of page ${i}</h2>` +
        `<p>Synthetic product page ${i}, section ${s}. The assistant answers questions about ${topic} and records each answer with its source. ` +
        `Release ${s}.${i} added a test suite of ${100 + s * 7} cases that runs on every change, and the results are published on this page.</p>` +
        `<ul><li>Intended use: drafting replies for support staff, case ${s}.</li><li>Known limit ${s}: it does not handle images.</li>` +
        `<li>Acceptance criterion ${s}: answer accuracy above ${80 + (s % 15)} percent on the held-out set.</li></ul>` +
        `<p>Owners review failures weekly; incident ${s} on page ${i} was fixed within two days and the fix is described in the changelog.</p></section>`,
    );
  }
  return `<!doctype html><html><head><title>Measure page ${i}</title></head><body><header><nav><ul>${links}</ul></nav></header><main><h1>${topic} (page ${i})</h1>${sections.join("")}</main><footer><p>Synthetic fixture for a CPU measurement.</p></footer></body></html>`;
}
const SITE = new Map();
SITE.set("/robots.txt", { type: "text/plain", body: "User-agent: *\nAllow: /\n" });
SITE.set("/sitemap.xml", {
  type: "application/xml",
  body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: PAGES }, (_, i) => `<url><loc>${ORIGIN}${pagePath(i)}</loc></url>`).join("")}</urlset>`,
});
for (let i = 0; i < PAGES; i += 1) SITE.set(pagePath(i), { type: "text/html; charset=utf-8", body: pageHtml(i) });

const counts = { ownSite: 0, github: 0, nebius: 0 };
const ownSiteFetchImpl = async (url) => {
  counts.ownSite += 1;
  const u = new URL(url);
  const hit = u.host === HOST ? SITE.get(u.pathname) : undefined;
  return hit ? new Response(hit.body, { status: 200, headers: { "content-type": hit.type } }) : new Response("not found", { status: 404 });
};
const githubFetchImpl = async () => {
  counts.github += 1;
  return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
};

// ---- model replies: screen include, coding with five positives per chunk, confirmer confirms ----
const gateFile = loadGateFile(resolveGatesPath());
const POSITIVE_CHECKS = gateFile.checkIds.slice(0, 5);
const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
const nebiusFetchImpl = async (_url, init) => {
  counts.nebius += 1;
  const body = JSON.parse(init.body);
  const name = body.response_format?.json_schema?.name;
  if (name === "screen") return reply({ include: true, reasonCode: null });
  if (name === "confirm") return reply({ decision: "confirmed", reason: "The quoted span shows it." });
  // Coding: cite the first span ids of this chunk for five checks; everything else unknown.
  const user = body.messages.find((m) => m.role === "user").content;
  const ids = [...user.matchAll(/^(p\d+-[^:\s]+):/gm)].map((m) => m[1]);
  const checks = gateFile.checkIds.map((checkId) => {
    const k = POSITIVE_CHECKS.indexOf(checkId);
    return k >= 0 && ids[k] ? { checkId, proposedState: "pass", spanIds: [ids[k]] } : { checkId, proposedState: "unknown", spanIds: [] };
  });
  return reply({ checks });
};
const client = createClient({ baseUrl: PINNED_BASE_URL, apiKey: "measure-no-key", fetchImpl: nebiusFetchImpl, skipBudgetGate: true });

// ---- run ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), "prism-measure-"));
const dataDir = path.join(work, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(path.join(work, "measure.sqlite")) }) });
const project = { n: 1, hn_id: "measure-1", title: "Show HN: Measurely – a synthetic assistant", final_url: `${ORIGIN}/` };
const slice = path.join(work, "slice.json");
fs.writeFileSync(slice, JSON.stringify([project]));

const cpu0 = process.cpuUsage();
const t0 = performance.now();

// The screener goes through a bare client: spend-guards has no list price for the
// screener model, so the priced Token Factory client refuses it (see the 07-11 SUMMARY).
const screenClient = {
  request: async (p, init) => {
    const res = await nebiusFetchImpl(`${PINNED_BASE_URL}${p}`, { body: JSON.stringify(init.body) });
    return { ok: res.ok, status: res.status, json: await res.json() };
  },
};
const screen = await screenCandidate(screenClient, 1, { title: project.title, url: project.final_url });
if (!screen.include) throw new Error("screen did not include the synthetic project");

const accounting = await runPipeline({
  sliceProjectsPath: slice,
  apiKeys: { tavily: "measure-no-key", nebius: "measure-no-key", github: "measure-no-key" },
  concurrency: 1,
  cacheDir: path.join(work, "cache"),
  dataDir,
  db,
  overrides: { ownSiteFetchImpl, githubFetchImpl, nebiusFetchImpl, renderImpl: async () => "", pythonPath: python },
});
if (!accounting.ok) throw new Error(`pipeline did not complete: ${JSON.stringify(accounting.outcomes.map((o) => o.error ?? o.status))}`);

// Confirm every positive (what plan 07-13's runner does after the gate).
const codebook = loadCodebook(path.join(process.cwd(), "codebook.md"));
await conf.ensureConfirmationSchema(db);
await conf.ensureEditsSchema(db);
const spanText = new Map(conf.projectSpans(dataDir, project.n).map((s) => [s.id, s.text]));
const rows = await db.selectFrom("pipeline_check_states").selectAll().where("project_n", "=", project.n).execute();
const positives = rows
  .filter((r) => r.filtered_state === "pass" || r.filtered_state === "claimed")
  .map((r) => ({ projectN: project.n, checkId: r.check_id, state: r.filtered_state, spans: JSON.parse(r.span_ids_json).map((id) => ({ id, text: spanText.get(id) ?? "" })) }));
for (const p of positives) {
  const v = await conf.confirmWithModel(client, codebook, p);
  await conf.recordConfirmation(db, {
    projectN: p.projectN,
    checkId: p.checkId,
    decision: v.decision,
    confirmedState: conf.confirmedStateFor(v.decision, p.state),
    reason: v.reason,
    confirmerId: `agent:${conf.CONFIRMER_MODEL}`,
    confirmerKind: "agent",
    modelId: conf.CONFIRMER_MODEL,
    decidedAt: new Date().toISOString(),
    inputDigest: conf.inputDigest(codebook, p),
    spanIds: p.spans.map((s) => s.id),
  });
}

// The report view the app stores (07-13 materialises it the same way).
const source = await sourceFromStore(db, dataDir, codebook, project.n, {
  projectId: "M01",
  title: project.title,
  hnId: null,
  collectedAt: new Date().toISOString(),
  generatedAt: new Date().toISOString(),
  renderAvailable: false,
  roles: { coding: { role: "coder", modelId: "fake", host: null }, confirmation: { role: "confirmer", modelId: "fake", host: null }, humanEdits: "none" },
  fixture: true,
});
const view = await buildReportView(source, {
  codebook,
  gatesPath: resolveGatesPath(),
  runGate: (record) => runGate(record, { pythonPath: python }),
  gapText: loadGapText({ codebook }),
});

const wallMs = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
const importCpu = process.cpuUsage(cpuAtStart);
await db.destroy();
fs.rmSync(work, { recursive: true, force: true });

if (blocked.fetch || blocked.dns) throw new Error(`blocked real network attempts: fetch=${blocked.fetch} dns=${blocked.dns}`);
const ms = (u) => Math.round((u.user + u.system) / 1000);
console.log(
  `MEASURE live-run label=${values.label} cpu_ms=${ms(cpu)} wall_ms=${Math.round(wallMs)} max_rss_mb=${Math.round(process.resourceUsage().maxRSS / 1024)} ` +
    `pages=${view.collection.pages} positives=${positives.length} throttle_wall_ms=${Math.max(0, counts.ownSite - 1) * 1000} ` +
    `process_cpu_ms=${ms(importCpu)} own_site_requests=${counts.ownSite} model_replies=${counts.nebius} github_requests=${counts.github} blocked_fetch=${blocked.fetch} blocked_dns=${blocked.dns} decisions=${view.decisions.length}`,
);
