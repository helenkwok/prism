#!/usr/bin/env node
// build-mleaf.mjs — turn a PRISM public release file into a Milleleaf project.
//
//   node scripts/build-mleaf.mjs <published v1 release.json> <out-dir>
//
// Writes <out-dir>/project.mleaf.json only. The Milleleaf CLI (in development, not
// in this repo) renders it to findings.xlsx, findings-report.docx, findings-deck.pptx
// and findings-pack.pdf; those binaries stay out of git (path guard), and their
// SHA-256 sums are pinned in ../downloads.sha256 for the site and app deploys.
//
// One findings table feeds three outputs: grid::workbook (findings.xlsx),
// word::document (report), deck::deck (deck), and an office::pack bundling all
// three. Structure copied from ref/hello-table/*.mleaf.json; attribute schemas
// from ref/schema/office.mleaf.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

const [, , inputArg, outArg] = process.argv;
if (!inputArg || !outArg) {
  console.error("usage: node scripts/build-mleaf.mjs <release.json> <out-dir>");
  process.exit(2);
}
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

const release = JSON.parse(readFileSync(resolve(inputArg), "utf8"));
console.log("release top-level keys:", Object.keys(release).join(", "));
console.log("n:", release.n, "date:", release.date, "version:", release.version);
console.log("figures:", Object.keys(release.figures ?? {}).join(", "));

// ---- findings table: headline only, from the five checks:* figure groups ---
// Only the rows of checks:explore, checks:rely, checks:operate,
// checks:measure-outcome and checks:scale-renew-stop feed the table; every
// other group is ignored. Released rows carry the counts and the 95% interval;
// lt10 rows are shown as not estimable; withheld rows are not listed one by
// one — one summary row carries their count. Rows are deduped by id.
const CHECK_GROUPS = [
  "checks:explore",
  "checks:rely",
  "checks:operate",
  "checks:measure-outcome",
  "checks:scale-renew-stop",
];

const tableRows = [];
let releasedCount = 0;
let lt10Count = 0;
let withheldCount = 0;
const seenIds = new Set();
for (const key of CHECK_GROUPS) {
  for (const row of release.figures?.[key]?.rows ?? []) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    if (row.state === "released") {
      releasedCount += 1;
      tableRows.push([
        row.label,
        row.c ?? null,
        row.n ?? null,
        row.pct ?? null,
        `${row.ci?.[0]}–${row.ci?.[1]}%`,
        "Released",
      ]);
    } else if (row.state === "lt10") {
      lt10Count += 1;
      tableRows.push([
        row.label,
        "fewer than 10",
        row.n ?? null,
        "",
        "",
        "Not estimable: fewer than ten gold passes",
      ]);
    } else {
      withheldCount += 1;
    }
  }
}
tableRows.push([
  "Withheld (not validated)",
  withheldCount,
  "",
  "",
  "",
  "Withheld under the pre-registered rule",
]);
console.log(
  "findings rows:", tableRows.length,
  "(released:", releasedCount,
  "lt10:", lt10Count,
  "withheld:", withheldCount + ")",
);

const columns = [
  { name: "Check", type: "text" },
  { name: "Launches evidencing", type: "text" },
  { name: "Of", type: "number" },
  { name: "Share %", type: "number" },
  { name: "95% interval", type: "text" },
  { name: "Status", type: "text" },
];

// Spreadsheet refs: header row + one row per entry (A1:F9 for 8 data rows).
const tableRef = `A1:F${tableRows.length + 1}`;

// Number words for the report sentence, computed from the data.
const numberWords = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
];
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const releasedWord = cap(numberWords[releasedCount] ?? String(releasedCount));
const lt10Word = numberWords[lt10Count] ?? String(lt10Count);

// ---- node paths (UUID-like strings, as in the examples) --------------------
const path = () => randomUUID();
const ROOT = path();
const WORKBOOK = path();
const SHEET = path();
const TABLE = path();
const META = path();
const N_VALUE = path();
const DATE_VALUE = path();
const VERSION_VALUE = path();
const REPORT = path();
const HEADING = path();
const SUMMARY = path();
const N_FIELD = path();
const DATE_FIELD = path();
const VERSION_FIELD = path();
const REPORT_TABLE = path();
const DECK = path();
const S_TITLE = path();
const S_TABLE = path();
const S_VERIFY = path();
const F_TITLE_ACCENT = path();
const F_TITLE_TEXT = path();
const F_TITLE_SUB = path();
const F_TABLE_TEXT = path();
const F_TABLE_FRAME = path();
const F_VERIFY_TEXT = path();
const F_VERIFY_BODY = path();
const PROVENANCE = path();
const PACK = path();

// Release meta lives beside the findings table: labels in F3:F6, values in
// G4:G6. The report paragraph links to the three value nodes, live.
const metaRows = [["Launches (n)"], ["Release date"], ["Release version"]];

const deckText = (role, text, sizePt, extra = {}) => ({
  role,
  paragraphs: [
    {
      runs: [
        {
          text,
          bold: role === "title",
          // Any frame flagged onDark sits on the dark title slide: light text.
          color: extra.onDark ? "#ffffff" : "#1d2433",
          font: "Inter",
          sizePt,
        },
      ],
      align: "left",
    },
  ],
});

// Report table layout: the Check column takes about 45% of the text width
// (A4 portrait, 1" margins → 451 pt) so long labels wrap to two short lines
// instead of many, the other columns stay narrow, and every cell is set in
// 9 pt so the whole table fits on page 1. Widths in points.
const REPORT_GRID = [197, 66, 27, 46, 45, 70];
const reportCells = (nRows) =>
  Array.from({ length: nRows }, () =>
    Array.from({ length: REPORT_GRID.length }, () => ({ chr: { size: 9 } })),
  );

// Workbook layout: column A carries the check labels (about 60 characters
// wide); the other columns fit their widest content, since naming any column
// width turns the sheet's auto-fit off. Rows are 28 px so a wrapped label's
// two lines stay inside their row. The sheet prints landscape, fitted to one
// page wide, so the workbook is one PDF page in the pack.
const sheetCol = (size) => ({
  size,
  hidden: false,
  outline: 0,
  collapsed: false,
  style: null,
  custom: false,
});
const sheetCols = { A: sheetCol(430), B: sheetCol(160), C: sheetCol(40), D: sheetCol(70), E: sheetCol(105), F: sheetCol(330) };
const sheetAlign = (wrap) => ({ h: "General", v: "Bottom", wrap, shrink: false, indent: 0, rotation: 0 });
const noBorder = () => ({ style: "None", color: "Auto" });
const sheetStyle = (over = {}) => ({
  font: { name: "Calibri", size: 11, bold: false, italic: false, underline: "None", strike: false, color: "Auto", vert: "Baseline" },
  fill: { pattern: "None", fg: "Auto", bg: "Auto" },
  borders: {
    left: noBorder(), right: noBorder(), top: noBorder(), bottom: noBorder(), diag_down: noBorder(), diag_up: noBorder(),
  },
  align: sheetAlign(false),
  num_fmt: "General",
  protection: { locked: true, hidden: false },
  ...over,
});
// Same looks write_table gives the cells (bold header, #,##0 numbers), plus a
// wrapped-label style — listing any cell styles re-styles the sheet, so the
// table's own looks are re-applied here.
const sheetStyles = [
  sheetStyle({ font: { ...sheetStyle().font, bold: true } }), // 0: header row
  sheetStyle({ num_fmt: "#,##0" }), // 1: number cells
  sheetStyle({ align: sheetAlign(true) }), // 2: wrapped check labels
];
// Data rows: 1 (header) + one per findings row, then the meta cells beside them.
const tableLastRow = tableRows.length + 1;
const sheetCellStyles = {
  "0": ["A1:F1"],
  "1": [`C2:D${tableLastRow}`],
  "2": [`A2:A${tableLastRow}`],
};
const sheetPrint = {
  orientation: "Landscape",
  paper: "A4",
  margins: [0.7, 0.7, 0.75, 0.75, 0.3, 0.3],
  print_area: null,
  title_rows: null,
  title_cols: null,
  scale: 100,
  fit_to: [1, 0],
  gridlines: false,
  headings: false,
  center_h: false,
  center_v: false,
  header: "",
  footer: "",
  row_breaks: [],
  col_breaks: [],
};

const data = [
  // project root
  {
    path: ROOT,
    children: { findings: WORKBOOK, report: REPORT, deck: DECK, pack: PACK },
    order: ["findings", "report", "deck", "pack"],
    attributes: { "office::project": { title: "PRISM findings v1 (CC BY 4.0)" } },
  },

  // ---- workbook -------------------------------------------------------------
  {
    path: WORKBOOK,
    children: { Findings: SHEET },
    order: ["Findings"],
    attributes: { "grid::workbook": { name: "findings.xlsx", styles: sheetStyles } },
  },
  {
    path: SHEET,
    children: {
      "findings-table": TABLE,
      "release-meta": META,
      n: N_VALUE,
      date: DATE_VALUE,
      version: VERSION_VALUE,
    },
    order: ["findings-table", "release-meta", "n", "date", "version"],
    attributes: {
      "grid::sheet": {
        name: "Findings",
        cols: sheetCols,
        defaults: { colWidth: 64, rowHeight: 28 },
        print: sheetPrint,
        cellStyles: sheetCellStyles,
      },
    },
  },
  {
    path: TABLE,
    attributes: {
      "office::data::table": { columns, rows: tableRows },
      "grid::range": { sheet: "Findings", ref: tableRef },
    },
  },
  {
    path: META,
    attributes: {
      "office::data::table": {
        columns: [{ name: "Release", type: "text" }],
        rows: metaRows,
      },
      "grid::range": { sheet: "Findings", ref: "F3:F6" },
    },
  },
  {
    path: N_VALUE,
    attributes: {
      "office::data::value": { value: release.n, format: "number" },
      "grid::range": { sheet: "Findings", ref: "G4" },
    },
  },
  {
    path: DATE_VALUE,
    attributes: {
      "office::data::value": { value: release.date },
      "grid::range": { sheet: "Findings", ref: "G5" },
    },
  },
  {
    path: VERSION_VALUE,
    attributes: {
      "office::data::value": { value: release.version },
      "grid::range": { sheet: "Findings", ref: "G6" },
    },
  },

  // ---- report ---------------------------------------------------------------
  {
    path: REPORT,
    children: { heading: HEADING, summary: SUMMARY, provenance: PROVENANCE, table: REPORT_TABLE },
    order: ["heading", "summary", "provenance", "table"],
    attributes: {
      "word::document": { title: "PRISM findings v1 (CC BY 4.0)", pageSize: "A4" },
    },
  },
  {
    path: HEADING,
    attributes: {
      "word::paragraph": {
        style: "Heading 1",
        runs: [{ text: "PRISM findings v1 (CC BY 4.0)" }],
      },
    },
  },
  {
    path: SUMMARY,
    children: { n: N_FIELD, date: DATE_FIELD, version: VERSION_FIELD },
    attributes: {
      "word::paragraph": {
        style: "Normal",
        runs: [
          { text: `PRISM reviewed ` },
          { field: "n" },
          {
            text: ` AI launches. ${releasedWord} checks are released, ${lt10Word} are shown as not estimable, and the rest are withheld because their coding did not meet the pre-registered accuracy gate.`,
          },
        ],
      },
    },
  },
  {
    path: PROVENANCE,
    children: { date: DATE_FIELD, version: VERSION_FIELD },
    attributes: {
      "word::paragraph": {
        style: "Normal",
        runs: [
          { text: "Release dated " },
          { field: "date" },
          { text: ", version " },
          { field: "version" },
          { text: ". Counts only; CC BY 4.0." },
        ],
      },
    },
  },
  {
    path: N_FIELD,
    inherits: { source: N_VALUE },
    attributes: {
      "mleaf::link": { source: N_VALUE, mode: "live" },
      "word::field": { format: "number" },
    },
  },
  {
    path: DATE_FIELD,
    inherits: { source: DATE_VALUE },
    attributes: {
      "mleaf::link": { source: DATE_VALUE, mode: "live" },
      "word::field": {},
    },
  },
  {
    path: VERSION_FIELD,
    inherits: { source: VERSION_VALUE },
    attributes: {
      "mleaf::link": { source: VERSION_VALUE, mode: "live" },
      "word::field": {},
    },
  },
  {
    path: REPORT_TABLE,
    inherits: { source: TABLE },
    attributes: {
      "mleaf::link": { source: TABLE, mode: "live" },
      "word::table": {
        style: "Grid Table 4",
        caption: "PRISM findings (counts only)",
        grid: REPORT_GRID,
        props: { fixed: true, width: REPORT_GRID.reduce((a, w) => a + w, 0) },
        cells: reportCells(tableRows.length + 1),
      },
    },
  },

  // ---- deck: title slide, findings table slide, how-to-verify slide ---------
  {
    path: DECK,
    children: { title: S_TITLE, findings: S_TABLE, verify: S_VERIFY },
    order: ["title", "findings", "verify"],
    attributes: {
      "deck::deck": { width: 1280, height: 720, unit: "px", title: "PRISM findings v1" },
    },
  },
  {
    path: S_TITLE,
    children: { accent: F_TITLE_ACCENT, text: F_TITLE_TEXT, subtitle: F_TITLE_SUB },
    order: ["accent", "text", "subtitle"],
    attributes: { "deck::slide": { name: "title", background: "#0f3d5e" } },
  },
  {
    path: F_TITLE_ACCENT,
    attributes: {
      "deck::frame": { x: 96, y: 228, w: 120, h: 8, z: 0 },
      "deck::shape": { kind: "roundRect", fill: "#f2b134", radius: 4 },
    },
  },
  {
    path: F_TITLE_TEXT,
    attributes: {
      "deck::frame": { x: 96, y: 250, w: 1000, h: 87, z: 1 },
      "deck::text": deckText("title", "PRISM findings v1", 54, { onDark: true }),
    },
  },
  {
    path: F_TITLE_SUB,
    attributes: {
      "deck::frame": { x: 96, y: 360, w: 1000, h: 34, z: 2 },
      "deck::text": deckText(
        "body",
        `${release.n} launches · ${release.date} · ${release.version} · CC BY 4.0`,
        21,
        { onDark: true },
      ),
    },
  },
  {
    path: S_TABLE,
    children: { text: F_TABLE_TEXT, table: F_TABLE_FRAME },
    order: ["text", "table"],
    attributes: { "deck::slide": { name: "findings", background: "#ffffff" } },
  },
  {
    path: F_TABLE_TEXT,
    attributes: {
      "deck::frame": { x: 80, y: 40, w: 1120, h: 54, z: 0 },
      "deck::text": deckText("title", "PRISM findings v1 (CC BY 4.0)", 33),
    },
  },
  {
    path: F_TABLE_FRAME,
    inherits: { source: TABLE },
    attributes: {
      "deck::frame": { x: 80, y: 110, w: 1120, h: 300, z: 1 },
      "deck::table": {
        // 10 pt and 300 px of rows (a minimum: rows grow only where a label
        // wraps) keep the 9-row table inside the 720 px slide.
        style: { font: "Inter", sizePt: 10 },
        cols: [400, 120, 70, 90, 120, 320],
      },
      "mleaf::link": { source: TABLE, mode: "live" },
    },
  },
  {
    path: S_VERIFY,
    children: { text: F_VERIFY_TEXT, body: F_VERIFY_BODY },
    order: ["text", "body"],
    attributes: { "deck::slide": { name: "how-to-verify", background: "#ffffff" } },
  },
  {
    path: F_VERIFY_TEXT,
    attributes: {
      "deck::frame": { x: 80, y: 40, w: 1120, h: 54, z: 0 },
      "deck::text": deckText("title", "How to verify", 33),
    },
  },
  {
    path: F_VERIFY_BODY,
    attributes: {
      "deck::frame": { x: 80, y: 170, w: 1120, h: 90, z: 1 },
      "deck::text": deckText(
        "body",
        "Every number in the report, workbook and slides comes from one composed source. The last page of the pack lists its layers.",
        21,
      ),
    },
  },

  // ---- pack: report, workbook, deck -----------------------------------------
  {
    path: PACK,
    attributes: {
      "office::pack": {
        title: "PRISM findings v1 (CC BY 4.0)",
        parts: [
          { source: REPORT, title: "PRISM findings v1 report (CC BY 4.0)" },
          { source: WORKBOOK, title: "PRISM findings v1 workbook (CC BY 4.0)" },
          { source: DECK, title: "PRISM findings v1 deck (CC BY 4.0)" },
        ],
      },
    },
  },
];

const project = {
  header: {
    id: "prism/findings-v1",
    mleafVersion: "mleaf_alpha",
    dataVersion: "1.0.0",
    author: "agent",
    timestamp: new Date().toISOString().slice(0, 10),
    kind: "base",
  },
  imports: [{ uri: "../ref/schema/office.mleaf.json" }],
  schemas: {},
  data,
};

const outFile = join(outDir, "project.mleaf.json");
writeFileSync(outFile, JSON.stringify(project, null, 2) + "\n");

console.log("wrote", outFile, `(${data.length} nodes)`);
console.log("node paths:");
console.log("  workbook :", WORKBOOK);
console.log("  report   :", REPORT);
console.log("  deck     :", DECK);
console.log("  pack     :", PACK);
