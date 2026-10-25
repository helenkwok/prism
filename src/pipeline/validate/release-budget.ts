// The frozen starting balances already include prior work. Only new release-stage charges enter here.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DollarBudget, type BudgetState } from "../coding/spend-guards.ts";

export type VerifiedBalanceSource = "verified-console" | "verified-api" | "user-verified-balance";
export type ReleaseBalanceSnapshot = {
  tokenFactory: { remainingUsd: number; reserveUsd: 1; observedAt: string; source: VerifiedBalanceSource };
  ollama: { remainingIncludedUsd: number; reserveUsd: .5; observedAt: string; source: VerifiedBalanceSource };
};
type Host = "token-factory" | "ollama";
type StageState = BudgetState & { host: Host };
type Ledger = { version: 1; snapshot: ReleaseBalanceSnapshot; snapshotDigest: string; stages: Record<string, StageState> };
const SOURCES = new Set(["verified-console", "verified-api", "user-verified-balance"]);
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const fail = (message: string): never => { throw new Error(`release budget: ${message}`); };
const validId = (id: string) => /^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(id);
const validAmount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

function verifySnapshot(snapshot: ReleaseBalanceSnapshot): ReleaseBalanceSnapshot {
  if (!snapshot?.tokenFactory || !snapshot?.ollama) fail("incomplete balance snapshot");
  const a = snapshot.tokenFactory, b = snapshot.ollama;
  if (!validAmount(a.remainingUsd) || !validAmount(b.remainingIncludedUsd)) fail("invalid remaining balance");
  if (a.reserveUsd !== 1 || b.reserveUsd !== .5 || a.remainingUsd < 1 || b.remainingIncludedUsd < .5) fail("protected reserve would be eroded");
  for (const observation of [a, b]) {
    if (!SOURCES.has(observation.source)) fail("unverified balance source");
    const time = Date.parse(observation.observedAt);
    if (typeof observation.observedAt !== "string" || !Number.isFinite(time) || time > Date.now() + 60_000 || Date.now() - time > 24 * 3600_000) fail("stale or invalid balance observation");
  }
  return { tokenFactory: { remainingUsd: a.remainingUsd, reserveUsd: 1, observedAt: a.observedAt, source: a.source }, ollama: { remainingIncludedUsd: b.remainingIncludedUsd, reserveUsd: .5, observedAt: b.observedAt, source: b.source } };
}

function acquireLease(file: string): number {
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const before = fs.statSync(file), owner = Number(fs.readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(owner) || owner <= 0) fail("invalid job lease");
    let alive = true; try { process.kill(owner, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; alive = false; }
    if (alive) fail("another release job is active");
    const after = fs.statSync(file);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) fail("job lease changed");
    fs.unlinkSync(file); fd = fs.openSync(file, "wx", 0o600);
  }
  try { fs.writeFileSync(fd, String(process.pid)); } catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  return fd;
}

/** One lease covers both host envelopes and all stage budgets in this release job. */
export function openReleaseBudget(dataDir: string, snapshot: ReleaseBalanceSnapshot) {
  const verified = verifySnapshot(snapshot);
  const snapshotDigest = sha(JSON.stringify(verified));
  const caps: Record<Host, number> = { "token-factory": verified.tokenFactory.remainingUsd - 1, ollama: verified.ollama.remainingIncludedUsd - .5 };
  const dir = path.join(dataDir, "validation"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "release-budget.json"), lockFile = `${file}.lock`;
  const lock = acquireLease(lockFile);
  let active = true;
  try {
    const ledger: Ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, snapshot: verified, snapshotDigest, stages: Object.create(null) };
    if (ledger.version !== 1 || ledger.snapshotDigest !== snapshotDigest || sha(JSON.stringify(verifySnapshot(ledger.snapshot))) !== snapshotDigest) fail("frozen balance snapshot cannot be replaced or reset");
    if (!ledger.stages || typeof ledger.stages !== "object" || Array.isArray(ledger.stages)) fail("invalid retained stages");
    for (const [id, stage] of Object.entries(ledger.stages)) {
      if (!validId(id) || !["token-factory", "ollama"].includes(stage.host) || ![stage.cap, stage.spent, stage.reserved, stage.estimated].every(validAmount) || stage.cap <= 0 || stage.cap > caps[stage.host] + 1e-12 || stage.spent + stage.reserved > stage.cap + 1e-12) fail("invalid retained stage bounds");
      // A lost response may still have been billed. Charge its already-persisted bound once.
      stage.spent += stage.reserved; stage.reserved = 0;
    }
    const total = (host: Host, field: "spent" | "reserved" | "estimated") => Object.values(ledger.stages).filter(stage => stage.host === host).reduce((n, stage) => n + stage[field], 0);
    for (const host of ["token-factory", "ollama"] as const) if (total(host, "spent") > caps[host] + 1e-12) fail("retained spending would erode the protected reserve");
    const ensureActive = () => { if (!active) fail("release job is closed"); verifySnapshot(verified); };
    const parents = new Map<Host, DollarBudget>();
    for (const host of ["token-factory", "ollama"] as const) if (caps[host] > 0) {
      const parent = new DollarBudget(caps[host], { initialSpent: total(host, "spent") }); parent.estimated = total(host, "estimated");
      const allows = parent.allows.bind(parent);
      parent.allows = amount => { ensureActive(); return allows(amount); };
      parents.set(host, parent);
    }
    const live = new Map<string, DollarBudget>();
    const collect = () => { for (const [id, budget] of live) ledger.stages[id] = { host: ledger.stages[id]!.host, ...budget.snapshot(), reserved: budget.reserved }; };
    const persist = () => {
      if (!active) fail("release job is closed");
      collect(); const next = `${file}.next`, fd = fs.openSync(next, "w", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(next, file);
    };
    persist();
    const summary = () => {
      collect();
      const hosts = Object.fromEntries((["token-factory", "ollama"] as const).map(host => {
        const parent = parents.get(host); const spent = parent?.spent ?? 0, reserved = parent?.reserved ?? 0;
        return [host, { cap: caps[host], spent, reserved, estimated: parent?.estimated ?? 0, available: Math.max(0, caps[host] - spent - reserved), protectedReserve: host === "token-factory" ? 1 : .5 }];
      })) as Record<Host, { cap: number; spent: number; reserved: number; estimated: number; available: number; protectedReserve: number }>;
      return { snapshotDigest, hosts, stages: Object.fromEntries(Object.entries(ledger.stages).map(([id, state]) => [id, { ...state }])) };
    };
    return {
      file, summary, budgetLine: () => `BUDGET: ${JSON.stringify(summary())}`,
      stageBudget(host: Host | "tokenFactory", cap: number, id: string): DollarBudget {
        ensureActive(); const key: Host = host === "tokenFactory" ? "token-factory" : host;
        if (!["token-factory", "ollama"].includes(key) || !validId(id) || !validAmount(cap) || cap <= 0) fail("invalid stage host, id or cap");
        const parent = parents.get(key); if (!parent) fail("no host funding above its protected reserve");
        const previous = Object.hasOwn(ledger.stages, id) ? ledger.stages[id] : undefined;
        const current = live.get(id);
        if (previous && previous.host !== key) fail("stage id cannot move to another host");
        if (previous && cap > previous.cap + 1e-12) fail("stage cap cannot increase");
        const charged = current ? current.spent + current.reserved : previous ? previous.spent + previous.reserved : 0;
        const available = Math.max(0, parent!.cap - parent!.spent - parent!.reserved);
        if (cap + 1e-12 < charged || cap > charged + available + 1e-12) fail("stage cap exceeds available host funding or is below existing charges");
        if (current) { current.cap = cap; persist(); return current; }
        ledger.stages[id] = { host: key, cap, spent: previous?.spent ?? 0, reserved: 0, estimated: previous?.estimated ?? 0 };
        const budget = new DollarBudget(cap, { parent, initialSpent: previous?.spent ?? 0, onChange: state => { if (!active) fail("release job is closed"); ledger.stages[id] = { host: key, ...state }; persist(); } });
        budget.estimated = previous?.estimated ?? 0; live.set(id, budget); persist(); return budget;
      },
      release() {
        if (!active) return;
        try { persist(); } finally { active = false; fs.closeSync(lock); fs.unlinkSync(lockFile); }
      },
    };
  } catch (error) { active = false; fs.closeSync(lock); fs.unlinkSync(lockFile); throw error; }
}
