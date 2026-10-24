#!/usr/bin/env node
// Video frames for the submission video (plan 08-01).
//
//   node scripts/video/capture.mjs --cards <script.json> --out <dir>
//
// Card mode writes, for every beat, <dir>/<id>/card.png (a full-frame title or
// storyboard card) and, for beats that are not cards, <dir>/<id>/caption.png (the caption strip on a
// transparent 1920x1080 frame). build.sh uses card.png when a beat has no
// captured frames, so the animatic always builds. Placeholders show as
// [NAME] until real values exist. Output belongs outside the repository.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const W = 1920;
const H = 1080;
const FONT = `-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const screenText = (s) => s.replace(/\{\{([A-Z0-9_]+)\}\}/g, "[$1]");

/** Beats whose frames show synthetic fixture data carry this label on every frame. */
export const FIXTURE_CAPTION = "Synthetic fixture";
const badge = (beat) => (beat.fixtureData ? `<div class="fixture">${FIXTURE_CAPTION}</div>` : "");
const BADGE_CSS = `.fixture{position:absolute;top:40px;left:40px;padding:14px 28px;border:4px solid #ffd166;background:rgba(8,10,14,.9);color:#ffd166;font-size:40px;font-weight:700;border-radius:12px}`;

export function cardHtml(beat) {
  const body =
    beat.method === "card"
      ? `<h1>${esc(screenText(beat.onScreen))}</h1>`
      : `<p class="kicker">${esc(beat.id)} · storyboard card, not final footage</p>
         <h1>${esc(beat.title)}</h1>
         <p class="shot">Shot: ${esc(beat.source)}</p>
         <p class="meta">${esc(beat.criterion.join(" · "))}</p>
         ${beat.pending ? `<p class="pending">PLACEHOLDER: ${esc(beat.pending)}</p>` : ""}`;
  return `<!doctype html><html><head><style>
    html,body{margin:0;width:${W}px;height:${H}px;background:#0b0d12;color:#f5f7fa;font-family:${FONT}}
    main{box-sizing:border-box;width:100%;height:100%;padding:140px 160px;display:flex;flex-direction:column;justify-content:center;gap:28px}
    h1{font-size:76px;line-height:1.15;margin:0;font-weight:700;max-width:1500px}
    .kicker{font-size:30px;margin:0;color:#9aa4b2;letter-spacing:.04em;text-transform:uppercase}
    .shot{font-size:34px;margin:0;color:#d6dbe3;max-width:1500px;line-height:1.35}
    .meta{font-size:28px;margin:0;color:#9aa4b2}
    .pending{font-size:28px;margin:0;color:#ffd166;max-width:1500px;line-height:1.35}
    ${BADGE_CSS}
  </style></head><body>${badge(beat)}<main>${body}</main></body></html>`;
}

export function captionHtml(beat) {
  return `<!doctype html><html><head><style>
    html,body{margin:0;width:${W}px;height:${H}px;background:transparent;font-family:${FONT}}
    .strip{position:absolute;left:0;right:0;bottom:0;height:150px;display:flex;align-items:center;justify-content:center;
      background:rgba(8,10,14,.82);color:#fff;font-size:42px;font-weight:600;padding:0 80px;box-sizing:border-box;text-align:center}
    ${BADGE_CSS}
  </style></head><body>${badge(beat)}<div class="strip">${esc(screenText(beat.onScreen))}</div></body></html>`;
}

async function renderCards(scriptPath, outDir) {
  const { beats } = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    for (const beat of beats) {
      const dir = path.join(outDir, beat.id);
      fs.mkdirSync(dir, { recursive: true });
      await page.setContent(cardHtml(beat));
      await page.screenshot({ path: path.join(dir, "card.png") });
      // A card beat's card already carries its on-screen text, so it gets no strip.
      fs.rmSync(path.join(dir, "caption.png"), { force: true });
      if (beat.method !== "card") {
        await page.setContent(captionHtml(beat));
        await page.screenshot({ path: path.join(dir, "caption.png"), omitBackground: true });
      }
      console.log(`CARD ${beat.id}`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { cards: { type: "string" }, out: { type: "string" } } });
  if (!values.cards || !values.out) {
    console.error("usage: capture.mjs --cards <script.json> --out <dir>");
    process.exit(2);
  }
  await renderCards(values.cards, values.out);
}
