// Adapted from .office-ref/scripts/prepare-apps.mjs: download the four pinned
// Craft editor release ZIPs (office-apps.lock.json), verify each SHA-256
// before extracting, and unpack into public/office-apps/<tool>/ with their
// licence files retained. Node built-ins plus python3 for unpacking only.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, "office-apps.lock.json"), "utf8"));
await mkdir(path.join(root, ".office-downloads"), { recursive: true });
for (const [app, { version, sha256 }] of Object.entries(lock)) {
  const filename = `${app}-web-${version}.zip`;
  const archive = path.join(root, ".office-downloads", filename);
  let bytes;
  try {
    bytes = await readFile(archive);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`${app}: checksum mismatch`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log(`Downloading ${app} ${version}…`);
    const response = await fetch(`https://github.com/storytold/${app}/releases/download/v${version}/${filename}`);
    if (!response.ok) throw new Error(`${app}: download failed (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    // Verify the download BEFORE caching it or extracting anything.
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`${app}: checksum mismatch`);
    await writeFile(archive, bytes);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`${app}: checksum mismatch`);
  const destination = path.join(root, "public/office-apps", app);
  // The official archives have a versioned wrapper directory; retain every file beneath it.
  const extracted = spawnSync("python3", ["-c", `
import pathlib, sys, zipfile
archive, target = sys.argv[1:]
root = pathlib.Path(target).resolve()
with zipfile.ZipFile(archive) as z:
    names = [p for p in z.namelist() if not p.endswith('/')]
    wrappers = {p.split('/')[0] for p in names}
    strip = len(wrappers) == 1 and all('/' in p for p in names)
    for info in z.infolist():
        if info.is_dir(): continue
        name = info.filename.split('/', 1)[1] if strip else info.filename
        out = (root / name).resolve()
        if not out.is_relative_to(root): raise ValueError('Unsafe archive path')
        if (info.external_attr >> 16) & 0o170000 == 0o120000: raise ValueError('Archive symlink')
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(z.read(info))
if not (root / 'index.html').is_file(): raise ValueError('Missing app entry point')
`, archive, destination], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr || `Could not extract ${app}`);
  console.log(`Verified and installed ${app} ${version}`);
}
await writeFile(path.join(root, "public/office-apps/versions.json"), `${JSON.stringify(lock, null, 2)}\n`);

// The four findings files /office opens, fetched from the findings site and checked against the sums
// pinned in site/downloads.sha256 before anything is written to public/office/findings/.
const findingsBase = process.env.PRISM_FINDINGS_DOWNLOADS ?? "https://prism.helenkwok.dev/downloads/";
const sums = (await readFile(path.join(root, "site/downloads.sha256"), "utf8")).trim().split("\n").map((line) => line.split(/\s+/));
await mkdir(path.join(root, "public/office/findings"), { recursive: true });
for (const [sha256, name] of sums) {
  if (name.endsWith(".json")) continue;
  const response = await fetch(new URL(name, findingsBase));
  if (!response.ok) throw new Error(`${name}: download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`${name}: checksum mismatch`);
  await writeFile(path.join(root, "public/office/findings", name), bytes);
  console.log(`Verified and installed findings/${name}`);
}
