// Built-asset check for APP-05 / SC5. Node built-ins only.
//   node scripts/check-built-assets.mjs [--dist dist] [--src src]
// 1. No file in the build may name an Iconify API host (the primary API and its
//    two fallbacks): a runtime icon fetch would tell a third party that a private
//    page was opened.
// 2. Every icon-[set--name] class used under src/ must have a generated rule in the
//    client CSS: Iconify's Tailwind plugin silently emits nothing for an unknown
//    icon, which would ship a blank icon.
// Prints: ASSETS iconify_api_refs=<n> icon_classes=<k> missing_icon_rules=<m>
// Exits 1 when n or m is above 0, 2 when the build is missing.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const distDir = path.resolve(opt("--dist", "dist"));
const srcDir = path.resolve(opt("--src", "src"));
const clientDir = path.join(distDir, "client");

const API_HOSTS = ["api.iconify.design", "api.simplesvg.com", "api.unisvg.com"];
const ICON_CLASS = /icon-\[([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)\]/g;
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"]);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

if (!fs.existsSync(clientDir)) {
  console.error(`ASSETS error: no client build at ${clientDir}; run the build first`);
  process.exit(2);
}

let apiRefs = 0;
for (const file of walk(distDir)) {
  const text = fs.readFileSync(file, "latin1");
  for (const host of API_HOSTS) apiRefs += text.split(host).length - 1;
}

const used = new Set();
for (const file of walk(srcDir)) {
  if (!SOURCE_EXT.has(path.extname(file))) continue;
  for (const m of fs.readFileSync(file, "utf8").matchAll(ICON_CLASS)) used.add(`${m[1]}--${m[2]}`);
}

let css = "";
for (const file of walk(clientDir)) if (file.endsWith(".css")) css += fs.readFileSync(file, "utf8");
const missing = [...used].filter((icon) => !css.includes(`.icon-\\[${icon}\\]`)).sort();
for (const icon of missing) console.error(`ASSETS missing rule for icon-[${icon}]`);

console.log(`ASSETS iconify_api_refs=${apiRefs} icon_classes=${used.size} missing_icon_rules=${missing.length}`);
process.exit(apiRefs > 0 || missing.length > 0 ? 1 : 0);
