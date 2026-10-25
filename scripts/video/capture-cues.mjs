#!/usr/bin/env node
// Zoomed shots and cue boxes for the submission video (08-VIDEO-REWORK.md).
//
//   node scripts/video/capture-cues.mjs <script.json> <out dir> [beat id ...]
//
// For every beat with "shots", writes <out>/<id>/shot-<n>.png (1920 px wide) and
// <out>/<id>/shots.json: each shot with its cue boxes measured from the DOM at
// capture time, in output pixels. A shot is { base: "prod"|"local", url, viewport,
// clip, scroll, offset, actions, cues }, its url an app path under the base (base-path.mjs); a { video } shot
// passes through unchanged.
// prod signs in as prism-admin (password from its mode-600 key file, never
// printed); local signs in as the seeded admin of e2e/serve.mjs (E2E_PORT, E2E_DIR).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { BASE_PREFIX } from "../../base-path.mjs";

const [scriptPath, outDir, ...only] = process.argv.slice(2);
if (!scriptPath || !outDir) {
  console.error("usage: capture-cues.mjs <script.json> <out dir> [beat id ...]");
  process.exit(2);
}
const W = 1920;
const BASES = {
  prod: () => ({
    url: `https://prism.helenkwok.dev${BASE_PREFIX}`,
    email: "prism-admin@helenkwok.dev",
    password: fs.readFileSync(path.join(os.homedir(), "Library/Application Support/prism/prod-admin.key"), "utf8").trim(),
  }),
  local: () => {
    const { admin } = JSON.parse(fs.readFileSync(path.join(process.env.E2E_DIR, "creds.json"), "utf8"));
    return { url: `http://127.0.0.1:${process.env.E2E_PORT}${BASE_PREFIX}`, email: admin.email, password: admin.password };
  },
};

const { beats } = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
const browser = await chromium.launch();
const sessions = {};
async function session(base) {
  if (sessions[base]) return sessions[base];
  const b = BASES[base]();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${b.url}/sign-in`);
  await p.getByLabel("Email").fill(b.email);
  await p.getByLabel("Password").fill(b.password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => u.pathname !== "/sign-in", { timeout: 30_000 });
  sessions[base] = { url: b.url, state: await ctx.storageState() };
  await ctx.close();
  return sessions[base];
}

async function capture(shot, file) {
  const s = await session(shot.base ?? "prod");
  const [vw, vh] = shot.viewport ?? [1200, 675];
  const clip = shot.clip ?? [0, 0, vw, vh];
  const scale = W / clip[2];
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: scale, storageState: s.state });
  const page = await ctx.newPage();
  try {
    await page.goto(s.url + shot.url, { waitUntil: shot.waitUntil ?? "networkidle" });
    for (const a of shot.actions ?? []) {
      if (a.open) await page.locator(a.open).first().evaluate((el) => { el.open = true; });
      if (a.click) await page.locator(a.click).first().click();
      if (a.wait) await page.waitForTimeout(a.wait);
    }
    if (shot.scroll) {
      await page.locator(shot.scroll).first().evaluate((el, off) => {
        // Inner scroll containers first (the office desk scrolls on its own), then the page.
        if (off === "center") return el.scrollIntoView({ block: "center" });
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off);
      }, shot.offset ?? 80);
    }
    await page.waitForTimeout(shot.settle ?? 600);
    const cues = [];
    for (const c of shot.cues ?? []) {
      let box = c.box;
      if (c.sel) {
        // A list of selectors rings the union of their boxes.
        const bbs = [];
        for (const sel of [c.sel].flat()) {
          const bb = await page.locator(sel).first().boundingBox();
          if (!bb) throw new Error(`no box for ${sel} on ${shot.url}`);
          bbs.push(bb);
        }
        const x = Math.min(...bbs.map((b) => b.x));
        const y = Math.min(...bbs.map((b) => b.y));
        box = [x, y, Math.max(...bbs.map((b) => b.x + b.width)) - x, Math.max(...bbs.map((b) => b.y + b.height)) - y];
      }
      const [x, y, w, h] = box;
      cues.push({ ...c, box: [x - clip[0], y - clip[1], w, h].map((v) => Math.round(v * scale)) });
    }
    await page.screenshot({ path: file, clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3] } });
    return { ...shot, png: file, cues };
  } finally {
    await ctx.close();
  }
}

try {
  for (const beat of beats) {
    if (!beat.shots || (only.length && !only.includes(beat.id))) continue;
    const dir = path.join(outDir, beat.id);
    fs.mkdirSync(dir, { recursive: true });
    const out = [];
    for (const [i, shot] of beat.shots.entries()) {
      out.push(shot.video ? shot : await capture(shot, path.join(dir, `shot-${i + 1}.png`)));
      console.log(`SHOT ${beat.id} ${i + 1} ${shot.video ? "video" : shot.url} cues=${out.at(-1).cues?.length ?? 0}`);
    }
    fs.writeFileSync(path.join(dir, "shots.json"), JSON.stringify(out, null, 2));
  }
} finally {
  await browser.close();
}
