// D-45: the minimal confirmation-timing page. It logs a start and an end
// timestamp only — no check-state read, write, or display capability of any
// kind (COD-03) — so the pilot (03-09/03-10) can measure Helen's actual
// seconds-per-confirmation ahead of Phase 4's full labelling/edit UI. This
// route must never grow a check-state control: the no-check-state-capability
// test in confirm-timing.test.mjs asserts this file's own source text never
// mentions one.
import { useEffect, useRef } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { getSessionEmail } from "../server/session.ts";
import { endConfirmation, startConfirmation } from "../../pipeline/store/results.ts";

/** D-45: open the confirmation-timing window for the signed-in user's visit. */
export const logConfirmationStart = createServerFn({ method: "POST" })
  .validator((d: { projectN: number }) => d)
  .handler(async ({ data }) => {
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
    if (!session) throw new Error("unauthenticated");
    await startConfirmation(getDb(), data.projectN);
    return { ok: true };
  });

/** D-45: close the confirmation-timing window on "Done". */
export const logConfirmationEnd = createServerFn({ method: "POST" })
  .validator((d: { projectN: number }) => d)
  .handler(async ({ data }) => {
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
    if (!session) throw new Error("unauthenticated");
    await endConfirmation(getDb(), data.projectN);
    return { ok: true };
  });

export const Route = createFileRoute("/confirm/$projectN")({
  beforeLoad: async () => {
    const user = await getSessionEmail();
    if (!user) throw redirect({ to: "/sign-in" });
    return { user };
  },
  component: ConfirmSession,
});

function ConfirmSession() {
  const { projectN } = Route.useParams();
  // Guards against a second start-row insert on a route re-render; the insert
  // is itself idempotent (replaceInto) either way, so this only avoids a
  // redundant round-trip, not a correctness bug.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void logConfirmationStart({ data: { projectN: Number(projectN) } });
  }, [projectN]);

  return (
    <main>
      <h1>Confirmation session for project {projectN}</h1>
      <button
        type="button"
        onClick={() => void logConfirmationEnd({ data: { projectN: Number(projectN) } })}
      >
        Done
      </button>
    </main>
  );
}
