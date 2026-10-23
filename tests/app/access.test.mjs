// APP-01 / D-81: role × route matrix. Every outcome is computed through
// decideAccess and the PATH_CLASSES role sets, then compared with a table in
// which every cell is written out: allow, 401 or 403.
import assert from "node:assert/strict";
import { test } from "node:test";

import { AccessError, PATH_CLASSES, decideAccess } from "../../src/app/server/access.ts";

const GRANTS = ["P-granted"];
const PROJECTS = {
  own: { projectId: "P-own", basis: "own", sponsorHold: false, inSample: true },
  "opt-in": { projectId: "P-opt", basis: "opt-in", sponsorHold: false, inSample: true },
  "well-known": { projectId: "P-wk", basis: "well-known", sponsorHold: false, inSample: true },
  "well-known+hold": { projectId: "P-wkh", basis: "well-known", sponsorHold: true, inSample: true },
  "out-of-rule sampled": { projectId: "P-oor", basis: null, sponsorHold: false, inSample: true },
  granted: { projectId: "P-granted", basis: null, sponsorHold: false, inSample: true },
  "not granted": { projectId: "P-other", basis: null, sponsorHold: false, inSample: true },
};
const ROLES = ["admin", "judge", "company", "none"];

/** The outcome a request gets, from the same pieces the guards use. */
function outcome(role, cls, project) {
  if (role === "none") return "401";
  if (cls.view) return decideAccess(role, role === "company" ? GRANTS : [], project, cls.view) ? "allow" : "403";
  return cls.roles.includes(role) ? "allow" : "403";
}

const A = "allow";
// Role-only classes: one cell per role (the project does not enter).
// Per-project classes: one cell per role per project class, in PROJECTS order:
// own, opt-in, well-known, well-known+hold, out-of-rule sampled, granted, not granted.
const EXPECTED = {
  review: { admin: A, judge: "403", company: "403", none: "401" },
  run: { admin: A, judge: "403", company: "403", none: "401" },
  method: { admin: A, judge: A, company: "403", none: "401" },
  p: {
    admin: [A, A, A, A, A, A, A],
    judge: [A, A, A, "403", "403", "403", "403"],
    company: ["403", "403", "403", "403", "403", A, "403"],
    none: ["401", "401", "401", "401", "401", "401", "401"],
  },
  j: {
    admin: [A, A, A, A, A, A, A],
    judge: [A, A, A, A, A, A, A],
    company: ["403", "403", "403", "403", "403", "403", "403"],
    none: ["401", "401", "401", "401", "401", "401", "401"],
  },
};

test("PATH_CLASSES lists exactly review, run, method, p and j", () => {
  assert.deepEqual(PATH_CLASSES.map((c) => c.name), ["review", "run", "method", "p", "j"]);
  assert.deepEqual(Object.keys(EXPECTED), ["review", "run", "method", "p", "j"]);
});

for (const cls of PATH_CLASSES) {
  for (const role of ROLES) {
    const expected = EXPECTED[cls.name][role];
    if (Array.isArray(expected)) {
      Object.entries(PROJECTS).forEach(([name, project], i) => {
        test(`${role} × ${cls.name} × ${name} → ${expected[i]}`, () => {
          assert.equal(outcome(role, cls, project), expected[i]);
        });
      });
    } else {
      test(`${role} × ${cls.name} → ${expected}`, () => {
        for (const project of Object.values(PROJECTS)) assert.equal(outcome(role, cls, project), expected);
      });
    }
  }
}

test("every role × path class cell is written out", () => {
  for (const cls of PATH_CLASSES) {
    for (const role of ROLES) {
      const cell = EXPECTED[cls.name][role];
      assert.ok(cell !== undefined, `${cls.name} × ${role}`);
      if (Array.isArray(cell)) assert.equal(cell.length, Object.keys(PROJECTS).length);
    }
  }
});

test("AccessError carries one fixed message per status", () => {
  assert.equal(new AccessError(401).message, "unauthenticated");
  assert.equal(new AccessError(403).message, "forbidden");
  assert.equal(new AccessError(403).status, 403);
});
