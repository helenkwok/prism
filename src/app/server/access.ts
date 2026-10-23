// D-81 / APP-01: the one access rule and the guards every handler calls first.
// decideAccess is pure and this module imports nothing at the top, so the rule
// table-tests with no database; auth, db and the request context are loaded
// inside the functions that need them. Erasable TypeScript only.
import type { Kysely } from "kysely";

export type Role = "admin" | "judge" | "company";
export type View = "identifiable" | "deidentified";
export type Basis = "own" | "opt-in" | "well-known";
export interface ProjectAccess {
  projectId: string;
  basis: Basis | null;
  sponsorHold: boolean;
  inSample: boolean;
}

/**
 * Route-file classes, keyed by file name under src/app/routes. A file of a
 * role class opens every handler with requireRole(exactly these roles); a file
 * of a view class with requireProjectAccess(view). The source-scan test applies
 * these to route files later plans add. Company does not open /method
 * (07-UI-SPEC open question 3, default hidden).
 */
export const PATH_CLASSES: readonly {
  name: string;
  pattern: RegExp;
  roles?: readonly Role[];
  view?: View;
}[] = [
  { name: "review", pattern: /^review\./, roles: ["admin"] },
  { name: "run", pattern: /^run/, roles: ["admin"] },
  { name: "method", pattern: /^method\./, roles: ["admin", "judge"] },
  { name: "p", pattern: /^p\./, view: "identifiable" },
  { name: "j", pattern: /^j\./, view: "deidentified" },
];

/**
 * One message per status. A missing project and a forbidden one both raise
 * 403 "forbidden", so no refusal reveals whether a record exists.
 */
export class AccessError extends Error {
  status: 401 | 403;
  constructor(status: 401 | 403) {
    super(status === 401 ? "unauthenticated" : "forbidden");
    this.name = "AccessError";
    this.status = status;
  }
}

/** Pure: the whole rule. */
export function decideAccess(
  role: string | null | undefined,
  grants: readonly string[],
  project: ProjectAccess,
  view: View,
): boolean {
  if (role === "admin") return true;
  if (role === "judge") {
    if (view === "deidentified") return project.inSample;
    return project.basis !== null && !project.sponsorHold;
  }
  // A company never gets the de-identified view and never a live run (D-80).
  if (role === "company") return view === "identifiable" && grants.includes(project.projectId);
  return false;
}

async function sessionOf(headers: Headers) {
  const { getAuth } = await import("./auth.ts");
  const session = await getAuth().api.getSession({ headers });
  if (!session) throw new AccessError(401);
  return session;
}

/** Headers in, so tests can pass a cookie header. Throws 401 with no session, 403 otherwise. */
export async function checkRole({ headers, roles }: { headers: Headers; roles: readonly Role[] }) {
  const session = await sessionOf(headers);
  if (!roles.includes(session.user.role as Role)) throw new AccessError(403);
  return session;
}

export async function checkAccess({
  headers,
  db,
  view,
  projectId,
  pseudonym,
}: {
  headers: Headers;
  db: Kysely<any>;
  view: View;
  projectId?: string;
  pseudonym?: string;
}) {
  const session = await sessionOf(headers);
  const store = await import("./access-store.ts");
  // The identifiable view is addressed by project id, the de-identified one by pseudonym only.
  const project =
    view === "identifiable"
      ? projectId
        ? await store.loadProjectAccess(db, projectId)
        : null
      : pseudonym
        ? await store.loadProjectAccessByPseudonym(db, pseudonym)
        : null;
  const grants = session.user.role === "company" ? await store.grantsOf(db, session.user.id) : [];
  if (!project || !decideAccess(session.user.role, grants, project, view)) throw new AccessError(403);
  return { session, project };
}

async function requestContext() {
  const { getRequestHeaders } = await import("@tanstack/react-start/server");
  return getRequestHeaders() as unknown as Headers;
}

/** First awaited call of every admin- or role-only handler. */
export async function requireRole(...roles: Role[]) {
  return checkRole({ headers: await requestContext(), roles });
}

/** First awaited call of every per-project handler. ref is a project id (identifiable) or a pseudonym (de-identified). */
export async function requireProjectAccess(view: View, ref: string) {
  const headers = await requestContext();
  const { getDb } = await import("./db.ts");
  return checkAccess(
    view === "identifiable"
      ? { headers, db: getDb(), view, projectId: ref }
      : { headers, db: getDb(), view, pseudonym: ref },
  );
}
