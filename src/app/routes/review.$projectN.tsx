// VAL-04 / D-58: signed-in person review page — trail, edit, decide, blind label.
// Semantic HTML only; plan 13 moves controls onto shadcn/Base UI (D-63).
import { useEffect, useState } from "react";
import { createFileRoute, redirect, useSearch } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireRole } from "../server/access.ts";
import { getDb, resolveDataDir } from "../server/db.ts";
import { getSessionUser } from "../server/session.ts";
import { loadGateFile, resolveGatesPath, PROPOSED_STATES } from "../../pipeline/coding/contract.ts";
import { loadCodebook } from "../../pipeline/coding/codebook-prompt.ts";
import {
  readTrail,
  recordEdit,
  recordPersonDecision,
  recordPersonGold,
} from "../../pipeline/review/trail.ts";

const gateCheckIds = () => loadGateFile(resolveGatesPath()).checkIds as [string, ...string[]];

const projectNSchema = z.number().int().min(1).max(400);
const stateSchema = z.enum(PROPOSED_STATES);
const reasonSchema = z.string().max(2000);

export const getTrail = createServerFn({ method: "GET" })
  .validator((d: { projectN: number; blind?: boolean }) => {
    const projectN = projectNSchema.parse(d.projectN);
    return { projectN, blind: Boolean(d.blind) };
  })
  .handler(async ({ data }) => {
    const session = await requireRole("admin");
    return readTrail(getDb(), resolveDataDir(), data.projectN, { blind: data.blind });
  });

export const submitEdit = createServerFn({ method: "POST" })
  .validator((d: { projectN: number; checkId: string; state: string; spanIds: string[]; reason?: string }) => {
    const checkIds = gateCheckIds();
    return z
      .object({
        projectN: projectNSchema,
        checkId: z.enum(checkIds),
        state: stateSchema,
        spanIds: z.array(z.string()),
        reason: reasonSchema.optional(),
      })
      .parse(d);
  })
  .handler(async ({ data }) => {
    const session = await requireRole("admin");
    return recordEdit(getDb(), resolveDataDir(), {
      projectN: data.projectN,
      checkId: data.checkId,
      state: data.state,
      spanIds: data.spanIds,
      reason: data.reason,
      actorId: `person:${session.user.email}`,
    });
  });

export const submitDecision = createServerFn({ method: "POST" })
  .validator((d: { projectN: number; checkId: string; decision: string; reason: string }) => {
    const checkIds = gateCheckIds();
    return z
      .object({
        projectN: projectNSchema,
        checkId: z.enum(checkIds),
        decision: z.enum(["confirmed", "rejected", "downgraded"]),
        reason: reasonSchema,
      })
      .parse(d);
  })
  .handler(async ({ data }) => {
    const session = await requireRole("admin");
    await recordPersonDecision(getDb(), resolveDataDir(), {
      projectN: data.projectN,
      checkId: data.checkId,
      decision: data.decision,
      reason: data.reason,
      actorId: `person:${session.user.email}`,
    });
    return { ok: true };
  });

export const submitGold = createServerFn({ method: "POST" })
  .validator(
    (d: {
      projectN: number;
      labels: { checkId: string; state: string; spanIds: string[]; reason?: string }[];
    }) => {
      const checkIds = gateCheckIds();
      return z
        .object({
          projectN: projectNSchema,
          labels: z
            .array(
              z.object({
                checkId: z.enum(checkIds),
                state: stateSchema,
                spanIds: z.array(z.string()),
                reason: reasonSchema.optional(),
              }),
            )
            .length(checkIds.length),
        })
        .parse(d);
    },
  )
  .handler(async ({ data }) => {
    const session = await requireRole("admin");
    const codebook = loadCodebook();
    await recordPersonGold(getDb(), resolveDataDir(), {
      projectN: data.projectN,
      labels: data.labels,
      actorId: `person:${session.user.email}`,
      codebookVersion: codebook.codebookVersion,
    });
    return { ok: true };
  });

// The page guard: the 403 for other roles is raised on the server, where it
// also sets the document's HTTP status (plan 07-07, Pitfall 3).
export const reviewAccess = createServerFn({ method: "GET" }).handler(async () => {
  await requireRole("admin");
  return true;
});

type ReviewSearch = { blind?: string };

export const Route = createFileRoute("/review/$projectN")({
  validateSearch: (s: Record<string, unknown>): ReviewSearch => ({
    blind: typeof s.blind === "string" ? s.blind : undefined,
  }),
  beforeLoad: async ({ location }) => {
    const user = await getSessionUser();
    if (!user) throw redirect({ to: "/sign-in", search: { next: location.href } });
    await reviewAccess();
    return { user };
  },
  component: ReviewPage,
});

function ReviewPage() {
  const { projectN } = Route.useParams();
  const search = useSearch({ from: "/review/$projectN" });
  const blind = search.blind === "1";
  const n = Number(projectN);
  const [trail, setTrail] = useState<Awaited<ReturnType<typeof readTrail>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void getTrail({ data: { projectN: n, blind } })
      .then(setTrail)
      .catch((e: Error) => setError(e.message));
  }, [n, blind]);

  async function onEdit(checkId: string, form: HTMLFormElement) {
    setError(null);
    setStatus(null);
    const fd = new FormData(form);
    const state = String(fd.get("state") ?? "");
    const reason = String(fd.get("reason") ?? "");
    const spanRaw = String(fd.get("spanIds") ?? "").trim();
    const spanIds = spanRaw ? spanRaw.split(/[\s,]+/).filter(Boolean) : [];
    try {
      const r = await submitEdit({ data: { projectN: n, checkId, state, spanIds, reason } });
      setStatus(`Edited ${checkId}: filtered=${r.filteredState}`);
      setTrail(await getTrail({ data: { projectN: n, blind } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onDecision(checkId: string, decision: "confirmed" | "rejected" | "downgraded", form: HTMLFormElement) {
    setError(null);
    setStatus(null);
    const reason = String(new FormData(form).get("reason") ?? "");
    try {
      await submitDecision({ data: { projectN: n, checkId, decision, reason } });
      setStatus(`${decision} ${checkId}`);
      setTrail(await getTrail({ data: { projectN: n, blind } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onGold(form: HTMLFormElement) {
    setError(null);
    setStatus(null);
    if (!trail) return;
    const fd = new FormData(form);
    const labels = trail.checks.map((c) => {
      const state = String(fd.get(`state-${c.checkId}`) ?? "unknown");
      const spanRaw = String(fd.get(`spans-${c.checkId}`) ?? "").trim();
      return {
        checkId: c.checkId,
        state,
        spanIds: spanRaw ? spanRaw.split(/[\s,]+/).filter(Boolean) : [],
      };
    });
    try {
      await submitGold({ data: { projectN: n, labels } });
      setStatus("Gold labels saved");
      setTrail(await getTrail({ data: { projectN: n, blind } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main>
      <h1>
        Review project {projectN}
        {blind ? " (blind)" : ""}
      </h1>
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p>{status}</p> : null}
      {!trail ? (
        <p>Loading…</p>
      ) : (
        <>
          {trail.checks.map((check) => (
            <details key={check.checkId} open>
              <summary>
                {check.checkId}
                {"model" in check && check.model ? ` — model ${check.model.filtered}` : ""}
              </summary>
              <pre>{check.rule}</pre>
              {check.spans.map((s) => (
                <blockquote key={s.id}>
                  <cite>{s.id}</cite>
                  {s.text}
                </blockquote>
              ))}
              {"model" in check && check.model ? (
                <p>
                  Model: {check.model.proposed} → filter {check.model.filtered}
                  {check.second ? `; second ${check.second.filtered}` : ""}
                  {check.gold ? `; gold ${check.gold.filteredState}` : ""}
                  {check.published ? `; published ${check.published.published ?? "null"} (${check.published.basis})` : ""}
                </p>
              ) : null}
              {"confirmations" in check && check.confirmations?.length ? (
                <ul>
                  {check.confirmations.map((c, i) => (
                    <li key={i}>
                      {c.kind} {c.actor}: {c.decision} — {c.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              {!blind ? (
                <>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void onEdit(check.checkId, e.currentTarget);
                    }}
                  >
                    <label>
                      Edit state{" "}
                      <select name="state" defaultValue="unknown">
                        {PROPOSED_STATES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>{" "}
                    <label>
                      Span ids <input name="spanIds" type="text" placeholder="p1-s1" />
                    </label>{" "}
                    <label>
                      Reason <textarea name="reason" rows={2} maxLength={2000} />
                    </label>{" "}
                    <button type="submit">Save edit</button>
                  </form>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                    }}
                  >
                    <label>
                      Decision reason <textarea name="reason" rows={2} maxLength={2000} required />
                    </label>{" "}
                    <button
                      type="button"
                      onClick={(e) => {
                        const form = (e.currentTarget as HTMLButtonElement).form!;
                        void onDecision(check.checkId, "confirmed", form);
                      }}
                    >
                      Confirm
                    </button>{" "}
                    <button
                      type="button"
                      onClick={(e) => {
                        const form = (e.currentTarget as HTMLButtonElement).form!;
                        void onDecision(check.checkId, "rejected", form);
                      }}
                    >
                      Reject
                    </button>{" "}
                    <button
                      type="button"
                      onClick={(e) => {
                        const form = (e.currentTarget as HTMLButtonElement).form!;
                        void onDecision(check.checkId, "downgraded", form);
                      }}
                    >
                      Downgrade
                    </button>
                  </form>
                </>
              ) : null}
            </details>
          ))}
          {blind ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void onGold(e.currentTarget);
              }}
            >
              <h2>Blind labelling</h2>
              {trail.checks.map((c) => (
                <fieldset key={c.checkId}>
                  <legend>{c.checkId}</legend>
                  <label>
                    State{" "}
                    <select name={`state-${c.checkId}`} defaultValue="unknown">
                      {PROPOSED_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>{" "}
                  <label>
                    Span ids <input name={`spans-${c.checkId}`} type="text" />
                  </label>
                </fieldset>
              ))}
              <button type="submit">Save gold labels</button>
            </form>
          ) : null}
        </>
      )}
    </main>
  );
}
