// VAL-05 / D-47 / A7.10: independent blind re-screen of seeded exclusions.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "../../app/server/db.ts";
import { withStageCache, defaultCacheDir } from "../cache/stage-cache.ts";
import { QuotaStop } from "../coding/nebius-client.ts";
import { MIN_STAGE2_CHARS, type FramePost, type PreflightResult } from "../select/draw.ts";
import { makeScreeners } from "../select/draw-pilot.ts";
import {
  MODEL_REASON_CODES,
  SCREENER_MODEL,
  screenCandidate,
  screenMessages,
  type ModelReasonCode,
  type ScreenDecision,
} from "../select/screen-model.ts";
import { wilson } from "./agreement.ts";
import { assertIndependent, roleClient, ROLE_CONFIG, type RoleSpec } from "./providers.ts";

const STAGE2_TEXT_CAP = 12000;
const AUDIT_BAR = 0.1;
const CONTENT_CODES = new Set<string>(MODEL_REASON_CODES);
const OPERATIONAL_CODES = new Set(["duplicate", "unreachable-at-screening"]);

const hash = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");

export type AuditLogRecord = {
  id: string;
  outcome: {
    kind: string;
    stage?: 1 | 2;
    reasonCode?: string;
  };
};

export type AuditRecord = {
  id: string;
  originalStage: 1 | 2 | null;
  originalReasonCode: string | null;
  assessable: boolean;
  auditorInclude: boolean | null;
  auditorReasonCode: ModelReasonCode | null;
  provider: string;
  model: string;
  textSource: "html" | "rendered" | "none";
  textChars: number;
  auditedAt: string;
};

export type AuditFigure = {
  n: number;
  assessable: number;
  notAssessable: number;
  errors: number;
  errorRate: number;
  wilson95: [number, number];
  bar: number;
  withinThreshold: boolean;
  byOriginalReason: Record<string, number>;
  operationalExcluded: Record<string, number>;
};

type Screeners = ReturnType<typeof makeScreeners>;

function logById(log: AuditLogRecord[]): Map<string, AuditLogRecord> {
  const m = new Map<string, AuditLogRecord>();
  for (const r of log) m.set(r.id, r);
  return m;
}

function postsById(posts: FramePost[]): Map<string, FramePost> {
  const m = new Map<string, FramePost>();
  for (const p of posts) m.set(p.id, p);
  return m;
}

/** Count operational exclusions in the screening log (never in the audit set). */
export function operationalExcludedCounts(log: AuditLogRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of log) {
    if (r.outcome.kind !== "excluded") continue;
    const code = r.outcome.reasonCode;
    if (!code || !OPERATIONAL_CODES.has(code)) continue;
    out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

export function auditFigure(records: AuditRecord[], log: AuditLogRecord[] = []): AuditFigure {
  const assessableRecs = records.filter((r) => r.assessable);
  const errors = assessableRecs.filter((r) => r.auditorInclude === true).length;
  const assessable = assessableRecs.length;
  const notAssessable = records.length - assessable;
  const errorRate = assessable === 0 ? 0 : errors / assessable;
  const wilson95 = wilson(errors, assessable);
  const byOriginalReason: Record<string, number> = {};
  for (const r of records) {
    const k = r.originalReasonCode ?? "unknown";
    byOriginalReason[k] = (byOriginalReason[k] ?? 0) + 1;
  }
  return {
    n: records.length,
    assessable,
    notAssessable,
    errors,
    errorRate,
    wilson95,
    bar: AUDIT_BAR,
    withinThreshold: errorRate <= AUDIT_BAR,
    byOriginalReason,
    operationalExcluded: operationalExcludedCounts(log),
  };
}

async function resolveText(
  post: FramePost,
  screeners: Screeners,
): Promise<{ text: string; finalUrl: string; textSource: "html" | "rendered" | "none"; pref: PreflightResult | null }> {
  const pref = await screeners.preflight(post);
  if (!pref) {
    return { text: "", finalUrl: post.url, textSource: "none", pref: null };
  }
  let text = pref.page_text ?? "";
  let textSource: "html" | "rendered" | "none" = text ? "html" : "none";
  if (text.length < MIN_STAGE2_CHARS) {
    const rendered = await screeners.render(pref.final_url);
    if (rendered.length > text.length) {
      text = rendered;
      textSource = "rendered";
    }
  }
  if (!text) textSource = "none";
  return { text, finalUrl: pref.final_url, textSource, pref };
}

export async function auditExclusions({
  subsets,
  log,
  posts,
  screeners,
  client,
  role,
  cacheDir,
}: {
  subsets: { audit: string[] };
  log: AuditLogRecord[];
  posts: FramePost[];
  screeners: Screeners;
  client: { request: (p: string, init: { method: string; body: unknown }) => Promise<{ ok: boolean; status: number; json: unknown }> };
  role: RoleSpec;
  cacheDir: string;
}): Promise<{ records: AuditRecord[]; figure: AuditFigure; stopped: boolean }> {
  assertIndependent("auditor", role.model);
  const byLog = logById(log);
  const byPost = postsById(posts);
  const records: AuditRecord[] = [];
  let stopped = false;

  for (const id of subsets.audit) {
    const post = byPost.get(id);
    if (!post) throw new Error(`audit: post ${id} missing from frame`);
    const orig = byLog.get(id);
    const originalStage = (orig?.outcome.stage ?? null) as 1 | 2 | null;
    const originalReasonCode = orig?.outcome.reasonCode ?? null;
    if (originalReasonCode && OPERATIONAL_CODES.has(originalReasonCode)) {
      throw new Error(`audit: operational exclusion ${id} (${originalReasonCode}) must not be in the audit set`);
    }
    if (originalReasonCode && !CONTENT_CODES.has(originalReasonCode)) {
      throw new Error(`audit: non-content reason ${id} (${originalReasonCode})`);
    }

    try {
      const { text, finalUrl, textSource } = await resolveText(post, screeners);
      const textChars = text.length;
      if (textChars < MIN_STAGE2_CHARS) {
        records.push({
          id,
          originalStage,
          originalReasonCode,
          assessable: false,
          auditorInclude: null,
          auditorReasonCode: null,
          provider: role.provider,
          model: role.model,
          textSource,
          textChars,
          auditedAt: new Date().toISOString(),
        });
        continue;
      }

      const candidate = { title: post.title, url: finalUrl, text: text.slice(0, STAGE2_TEXT_CAP) };
      const messages = screenMessages(2, candidate);
      const thinking = role.reasoning === true;
      const { value: decision } = await withStageCache(
        cacheDir,
        id,
        "audit2",
        { provider: role.provider, model: role.model, thinking, req: hash(messages) },
        async () =>
          screenCandidate(client as any, 2, candidate, {
            model: role.model,
            thinking,
          }),
      );

      records.push({
        id,
        originalStage,
        originalReasonCode,
        assessable: true,
        auditorInclude: (decision as ScreenDecision).include,
        auditorReasonCode: (decision as ScreenDecision).reasonCode,
        provider: role.provider,
        model: role.model,
        textSource,
        textChars,
        auditedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof QuotaStop || (err as Error)?.name === "QuotaStop") {
        stopped = true;
        break;
      }
      throw err;
    }
  }

  return { records, figure: auditFigure(records, log), stopped };
}

function writeAuditJson(dataDir: string, payload: unknown): string {
  const dir = path.join(dataDir, "validation");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "screening-audit.json");
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return file;
}

export async function runScreeningAuditCli(argv = process.argv.slice(2)): Promise<void> {
  const dataDir = resolveDataDir();
  const cacheDir = defaultCacheDir();
  const subsets = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "sample-subsets.json"), "utf8"));
  const screeningLog = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "sample-screening-log.json"), "utf8"));
  const frame = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "frame.json"), "utf8"));
  const role = ROLE_CONFIG.auditor;
  const client = roleClient("auditor");
  // Screener client only for preflight/render cache sharing (v2); auditor never uses it for decisions.
  const screeners = makeScreeners({
    client: client as any,
    cacheDir,
    preflightVersion: 2,
  });

  const { records, figure, stopped } = await auditExclusions({
    subsets,
    log: screeningLog.log,
    posts: frame.posts,
    screeners,
    client: client as any,
    role,
    cacheDir,
  });

  const payload = {
    ...figure,
    provider: role.provider,
    model: role.model,
    screenerModel: SCREENER_MODEL,
    seed: subsets.seeds?.screeningAudit,
    auditIds: subsets.audit,
    records,
    stopped,
  };
  writeAuditJson(dataDir, payload);
  const line = { ...figure, provider: role.provider, model: role.model, ...(stopped ? { stopped: true } : {}) };
  console.log(`AUDIT: ${JSON.stringify(line)}`);
  if (stopped) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runScreeningAuditCli().catch((err) => {
    console.error(err?.stack ?? err);
    process.exitCode = 1;
  });
}
