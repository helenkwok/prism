// T-07-12: for every synthetic-corpus project, the ReportView statuses from the
// vendored JS evaluator equal those from the pinned Python gate (runGate).
// Gate job only (`npm run test:gate`): needs the .venv-gate interpreter or PRISM_PYTHON.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runGate } from "../../src/pipeline/gate/run-gate.ts";
import { buildReportView, loadGapText, sourceFromFixture } from "../../src/report/view.ts";
import { codebook, corpus, gatesPath, jsRunGate, order, root } from "../report/js-gate.mjs";

const gapText = loadGapText({ repoRoot: root, codebook });
const pyGate = (record) => runGate(record, { repoRoot: root });

describe("ReportView: JS evaluator vs pinned Python gate", () => {
  for (const p of corpus.projects) {
    test(`${p.projectId}: identical decision statuses`, async () => {
      const src = sourceFromFixture(corpus, p, order);
      const js = await buildReportView(src, { codebook, gatesPath, runGate: jsRunGate, gapText });
      const py = await buildReportView(src, { codebook, gatesPath, runGate: pyGate, gapText });
      assert.deepEqual(py.decisions.map((d) => d.status), js.decisions.map((d) => d.status));
      assert.match(py.gateSha, /^[0-9a-f]{64}$/);
    });
  }
});
