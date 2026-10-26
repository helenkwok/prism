#!/usr/bin/env python3
"""Devpost image gallery: 3:2 JPGs drawn the same way as the video (08-VIDEO-REWORK.md).

    python3 scripts/video/gallery.py scripts/video/gallery.json <shots dir> <out dir> public-data/v1/release.json

Page shots come from capture-cues.mjs (1200x800 pages at 1.6x = 1920x1280); this draws their cue rings, the
number cards and the cover with overlays.py's own functions, and writes <out>/<id>.jpg (Devpost: 3:2, under 5 MB).
"""
import json
import sys
from pathlib import Path

from PIL import Image

import overlays as ov

ov.W, ov.H = 1920, 1280  # 3:2


def main():
    spec_path, shots_dir, out_dir, release_path = map(Path, sys.argv[1:5])
    spec = json.loads(spec_path.read_text())
    release = json.loads(release_path.read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "layers"
    work.mkdir(exist_ok=True)
    for b in spec["beats"]:
        layers = []
        c = b.get("card")
        if c and c.get("cover"):
            ov.panel(work / "cover.png", "Public-evidence review", "PRISM",
                     "What AI launches publicly evidence, for which decision, against which standard · prism.helenkwok.dev",
                     opaque=True, size=180)
            layers.append(work / "cover.png")
        elif c:
            ov.card_bg(work / f"{b['id']}-bg.png", c.get("kicker"), c["title"])
            layers.append(work / f"{b['id']}-bg.png")
            stats = c.get("stats", [])
            for i, s in enumerate(stats):
                ov.stat(work / f"{b['id']}-stat{i}.png", i, len(stats), ov.resolve(s["value"], release), s["label"])
                layers.append(work / f"{b['id']}-stat{i}.png")
            if c.get("foot"):
                ov.foot(work / f"{b['id']}-foot.png", c["foot"]["text"])
                layers.append(work / f"{b['id']}-foot.png")
        for k, s in enumerate(json.loads((shots_dir / b["id"] / "shots.json").read_text()) if b.get("shots") else []):
            if s.get("pdf"):
                tf = ov.pdf_plate(work / f"{b['id']}-pdf.png", s, work)
                layers.append(work / f"{b['id']}-pdf.png")
            else:
                tf = lambda bx: bx
                layers.append(Path(s["png"]))
            for j, cue in enumerate(s.get("cues", [])):
                ov.ring(work / f"{b['id']}-cue{j}.png", tf(cue["box"]), cue.get("label"))
                layers.append(work / f"{b['id']}-cue{j}.png")
        if b.get("fixtureData"):
            ov.badge(work / "fixture.png", "Synthetic fixture")
            layers.append(work / "fixture.png")
        img = Image.new("RGBA", (ov.W, ov.H), ov.BG)
        for layer in layers:
            img.alpha_composite(Image.open(layer).convert("RGBA").resize((ov.W, ov.H)))
        out = out_dir / f"{b['id']}.jpg"
        img.convert("RGB").save(out, quality=92)
        print(f"IMAGE {out} {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
