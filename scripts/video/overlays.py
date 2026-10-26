#!/usr/bin/env python3
"""Visual layer for the submission video (08-VIDEO-REWORK.md).

    python3 scripts/video/overlays.py <script.json> <built.mp4> <shots dir> <out.mp4> [release.json]

Reads <built.mp4>.timings.tsv from build.sh, then lays on one ffmpeg pass:
shots (zoomed stills or video clips from capture-cues.mjs), cue rings timed to the
narration word they illustrate, number cards, the opening, section and ending
panels, and the synthetic-fixture badge. Narration audio is copied unchanged.
Overlay PNGs go to <out>.overlays/. Numbers marked {"ref": ...} come from release.json.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
AMBER = (255, 176, 32, 255)
INK = (247, 244, 238, 255)
MUTED = (178, 182, 190, 255)
BG = (11, 13, 18, 255)
PANEL = (13, 15, 19, 244)
FONT = "/System/Library/Fonts/HelveticaNeue.ttc"
FACE = {"regular": 0, "bold": 1, "light": 7, "medium": 10}
FADE = 0.4


def font(size, face="regular"):
    return ImageFont.truetype(FONT, size, index=FACE[face])


def words(s):
    return [re.sub(r"[^\w.%$,-]", "", w).strip(".,").lower() for w in s.split()]


def word_time(beat, row, phrase):
    """Seconds into the video when the narration reaches the phrase (build.sh delays speech 0.3 s)."""
    ws, ps = words(beat["narration"]), words(phrase)
    for i in range(len(ws) - len(ps) + 1):
        if ws[i:i + len(ps)] == ps:
            return row["start"] + 0.3 + i / len(ws) * row["nar"]
    raise SystemExit(f"overlays: phrase {phrase!r} not in {beat['id']} narration")


def tracked(draw, xy, text, f, fill, spacing):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + spacing
    return x


def wrap(draw, text, f, width):
    lines, line = [], ""
    for w in text.split():
        t = f"{line} {w}".strip()
        if draw.textlength(t, font=f) <= width or not line:
            line = t
        else:
            lines.append(line)
            line = w
    return lines + [line] if line else lines


def panel(path, kicker, title, sub=None, opaque=False, size=68):
    img = Image.new("RGBA", (W, H), BG if opaque else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    tf, sf, kf = font(size, "bold"), font(31, "light"), font(25, "medium")
    tl = wrap(d, title, tf, 1240)
    sl = wrap(d, sub, sf, 1240) if sub else []
    pw = 1400
    lh = round(size * 1.2)
    ph = 120 + 60 + len(tl) * lh + (24 + len(sl) * 42 if sl else 0) + 50
    x0, y0 = (W - pw) // 2, (H - ph) // 2
    d.rounded_rectangle([x0, y0, x0 + pw, y0 + ph], 34, fill=PANEL)
    y = y0 + 70
    tracked(d, (x0 + 80, y), kicker.upper(), kf, AMBER, 5)
    d.rectangle([x0 + 80, y + 44, x0 + 150, y + 47], fill=AMBER)
    y += 90
    for line in tl:
        d.text((x0 + 80, y), line, font=tf, fill=INK)
        y += lh
    y += 24
    for line in sl:
        d.text((x0 + 80, y), line, font=sf, fill=MUTED)
        y += 42
    img.save(path)


def card_bg(path, kicker, title):
    img = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(img)
    if kicker:
        tracked(d, (160, 150), kicker.upper(), font(25, "medium"), AMBER, 5)
        d.rectangle([160, 194, 230, 197], fill=AMBER)
    y = 240
    for line in wrap(d, title, font(64, "bold"), 1600):
        d.text((160, y), line, font=font(64, "bold"), fill=INK)
        y += 78
    img.save(path)


def stat(path, i, n, value, label):
    """One number block: a row of up to three, or a 2x2 grid of four, on a transparent frame."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cols = 2 if n == 4 else n
    colw = (W - 320) // cols
    x = 160 + (i % cols) * colw
    y0 = 420 if n == 4 else 520
    y0 += (i // cols) * 300
    size = 120 if n == 4 else 150
    while d.textlength(value, font=font(size, "bold")) > colw - 90:
        size -= 6
    vf = font(size, "bold")
    d.rectangle([x, y0, x + 6, y0 + (220 if n == 4 else 240)], fill=AMBER)
    d.text((x + 40, y0), value, font=vf, fill=INK)
    y = y0 + size + 20
    for line in wrap(d, label, font(34, "light"), colw - 100):
        d.text((x + 40, y), line, font=font(34, "light"), fill=MUTED)
        y += 44
    img.save(path)


def foot(path, text):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = font(36, "medium")
    tw = d.textlength(text, font=f)
    d.rounded_rectangle([160, 900, 160 + tw + 60, 970], 14, outline=AMBER, width=3)
    d.text((190, 913), text, font=f, fill=INK)
    img.save(path)


def ring(path, box, label=None):
    x, y, w, h = box
    pad = 10
    r = [x - pad, y - pad, x + w + pad, y + h + pad]
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle(r, 12, outline=(255, 176, 32, 150), width=12)
    img = glow.filter(ImageFilter.GaussianBlur(8))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(r, 12, outline=AMBER, width=4)
    if label:
        f = font(28, "medium")
        lines = wrap(d, label, f, 280)
        cw = max(d.textlength(l, font=f) for l in lines) + 36
        ch = len(lines) * 36 + 20
        if r[2] + 18 + cw <= W - 16:  # right margin
            cx, cy = r[2] + 18, r[1]
        elif r[0] - 18 - cw >= 16:  # left margin
            cx, cy = r[0] - 18 - cw, r[1]
        else:
            cx = min(max(r[0], 20), W - cw - 20)
            cy = r[1] - ch - 12 if r[1] - ch - 12 > 20 else r[3] + 12
        cy = min(max(cy, 16), H - ch - 16)
        d.rounded_rectangle([cx, cy, cx + cw, cy + ch], 12, fill=(13, 15, 19, 235), outline=AMBER, width=2)
        for k, l in enumerate(lines):
            d.text((cx + 18, cy + 10 + k * 36), l, font=f, fill=INK)
    img.save(path)


def badge(path, text):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = font(40, "bold")
    tw = d.textlength(text, font=f)
    d.rounded_rectangle([40, 40, 40 + tw + 56, 120], 12, fill=(8, 10, 14, 230), outline=(255, 209, 102, 255), width=4)
    d.text((68, 56), text, font=f, fill=(255, 209, 102, 255))
    img.save(path)


def pdf_plate(path, shot, work):
    """A PDF page region on a dark plate, scaled to fit 1800x1000; returns the transform for its cue boxes."""
    stem = work / f"pdf-{shot['page']}"
    if not stem.with_suffix(".png").exists():
        subprocess.run(["pdftoppm", "-r", "200", "-f", str(shot["page"]), "-l", str(shot["page"]),
                        "-png", "-singlefile", shot["pdf"], str(stem)], check=True)
    page = Image.open(stem.with_suffix(".png")).convert("RGBA")
    cx, cy, cw, ch = shot["crop"]
    s = min(1800 / cw, 1000 / ch)
    region = page.crop((cx, cy, cx + cw, cy + ch)).resize((round(cw * s), round(ch * s)), Image.LANCZOS)
    img = Image.new("RGBA", (W, H), BG)
    ox, oy = (W - region.width) // 2, (H - region.height) // 2
    img.paste(region, (ox, oy))
    img.save(path)
    return lambda b: [round(ox + (b[0] - cx) * s), round(oy + (b[1] - cy) * s), round(b[2] * s), round(b[3] * s)]


def resolve(value, release):
    if isinstance(value, str):
        return value
    v = release
    for k in value["ref"].split("."):
        v = v[int(k)] if isinstance(v, list) else v[k]
    return value.get("fmt", "{}").format(v)


SPOKEN_HOLD = 1.5  # seconds a ring, number or line stays up at least when the narration says it as it appears


def text_hold(text):
    """Text the narration does not say stays up long enough to read: max(3 s, 1 s + words/3)."""
    return max(3.0, 1 + len(text.split()) / 3)


def clip_seconds(shot):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", shot["video"]],
                         capture_output=True, text=True, check=True).stdout
    return (float(out) - shot.get("ss", 0)) / shot.get("speed", 1)


def beat_length(spec, b, nar):
    """A beat ends when its narration has ended (0.3 s lead-in + 0.4 s after) and every visual has had its time:
    rings SPOKEN_HOLD, unspoken text text_hold, the panels their spans, a closing clip its full length. No dead air
    beyond that; the planned slot is not a minimum. Card numbers and their lines are spoken as they appear, so
    they need SPOKEN_HOLD; only the end card's text is unspoken."""
    r = {"start": 0.0, "nar": nar}
    need = [0.3 + nar + 0.4]
    if b.get("opening"):
        need.append(4.7)
    if any(x["first"] == b["id"] for x in spec.get("sections", [])) and not b.get("card"):
        need.append(4.2)
    c = b.get("card") or {}
    need += [word_time(b, r, st["at"]) + SPOKEN_HOLD for st in c.get("stats", [])]
    if c.get("foot"):
        need.append(word_time(b, r, c["foot"]["at"]) + SPOKEN_HOLD)
    if b.get("ending"):
        e = b["ending"]
        need.append(text_hold(f"{e['title']} {e.get('sub', '')}"))
    shots = b.get("shots", [])
    for k, sh in enumerate(shots):
        t = 0.0 if k == 0 else word_time(b, r, sh["at"])
        if sh.get("video") and k == len(shots) - 1:
            need.append(t + clip_seconds(sh))
        need += [word_time(b, r, cue["at"]) + SPOKEN_HOLD for cue in sh.get("cues", [])]
    return max(need)


def main():
    script, built, shots_dir, out = map(Path, sys.argv[1:5])
    release = json.loads(Path(sys.argv[5]).read_text()) if len(sys.argv) > 5 else {}
    spec = json.loads(script.read_text())
    beats = {b["id"]: b for b in spec["beats"]}
    rows = {}
    for line in built.with_suffix(".timings.tsv").read_text().split("\n"):
        if line.strip():
            i, a, b, n = line.split("\t")
            rows[i] = {"start": float(a), "end": float(b), "nar": float(n)}
    work = Path(str(out) + ".overlays")
    work.mkdir(parents=True, exist_ok=True)
    beat_layers = {}  # beat id -> [layers, top]; a layer is (kind, source, start, end, fade_in, fade_out)

    def add(layer, on_top=False):
        beat_layers[cur][1 if on_top else 0].append(layer)

    def add_png(name, start, end, fade=FADE, fade_out=True, on_top=False):
        add(("png", work / name, start, end, fade, fade_out), on_top)

    sections = {s["first"]: s for s in spec.get("sections", [])}
    for n, s in enumerate(spec.get("sections", []), 1):
        s["kicker"] = f"Section {n} of {len(spec['sections'])} · {s['title']}"

    for b in spec["beats"]:
        cur = b["id"]
        beat_layers[cur] = [[], []]
        r = rows[b["id"]]
        t0, t1 = r["start"], r["end"]
        sec = sections.get(b["id"])
        if b.get("card"):
            c = b["card"]
            card_bg(work / f"{b['id']}-bg.png", sec["kicker"] if sec else c.get("kicker"), c["title"])
            add_png(f"{b['id']}-bg.png", t0, t1, 0, False)
            stats = c.get("stats", [])
            for i, s in enumerate(stats):
                stat(work / f"{b['id']}-stat{i}.png", i, len(stats), resolve(s["value"], release), s["label"])
                add_png(f"{b['id']}-stat{i}.png", max(t0 + 0.6, word_time(b, r, s["at"])), t1, 0.5, False)
            if c.get("foot"):
                foot(work / f"{b['id']}-foot.png", c["foot"]["text"])
                add_png(f"{b['id']}-foot.png", word_time(b, r, c["foot"]["at"]), t1, 0.5, False)
        elif b.get("ending"):
            e = b["ending"]
            panel(work / "ending.png", e["kicker"], e["title"], e.get("sub"), opaque=True)
            add_png("ending.png", t0, t1, 0.6, False)
        elif sec:
            panel(work / f"{b['id']}-section.png", sec["kicker"], sec["title"], sec.get("sub"))
            add_png(f"{b['id']}-section.png", t0 + 0.4, t0 + 4.2, on_top=True)
        if b.get("opening"):
            o = b["opening"]
            panel(work / "opening.png", o["kicker"], o["title"], o.get("sub"), size=o.get("size", 68))
            # On screen from the first frame (no fade in), so frame 0 already names the submission.
            add_png("opening.png", t0, t0 + 4.7, 0, on_top=True)

        shots_json = shots_dir / b["id"] / "shots.json"
        if b.get("shots"):
            shots = json.loads(shots_json.read_text()) if shots_json.exists() else b["shots"]
            starts = [t0 if k == 0 else word_time(b, r, s["at"]) for k, s in enumerate(shots)]
            for k, s in enumerate(shots):
                s_end = starts[k + 1] if k + 1 < len(shots) else t1
                fade = 0 if k == 0 else 0.35
                if s.get("video"):
                    add(("video", s, starts[k], t1, fade, False))
                    cues = s.get("cues", [])
                    tf = lambda bx: bx
                elif s.get("pdf"):
                    name = f"{b['id']}-shot{k + 1}.png"
                    tf = pdf_plate(work / name, s, work)
                    add_png(name, starts[k], t1, fade, False)
                    cues = s.get("cues", [])
                else:
                    add(("png", Path(s["png"]), starts[k], t1, fade, False))
                    cues = s.get("cues", [])
                    tf = lambda bx: bx
                floor = max(starts[k] + 0.5, t0 + b.get("cueAfter", 0))
                cts = [max(floor, word_time(b, r, c["at"])) for c in cues]
                for j, c in enumerate(cues):
                    c_end = min(cts[j + 1] if j + 1 < len(cues) else s_end, s_end) if not c.get("hold") else s_end
                    name = f"{b['id']}-s{k + 1}-cue{j + 1}.png"
                    ring(work / name, tf(c["box"]), c.get("label"))
                    add_png(name, cts[j], min(s_end, max(c_end, cts[j] + 1.8)), 0.25)
        if b.get("fixtureData"):
            badge(work / "fixture.png", "Synthetic fixture")
            add_png("fixture.png", t0, t1, 0, False, on_top=True)

    # One ffmpeg run per beat, times relative to the beat; then join and copy the narration.
    segs = []
    for b in spec["beats"]:
        r = rows[b["id"]]
        dur = r["end"] - r["start"]
        layers = beat_layers[b["id"]][0] + beat_layers[b["id"]][1]  # panels and badge on top
        seg = work / f"seg-{b['id']}.mp4"
        render_beat(layers, r["start"], dur, seg)
        segs.append(seg)
        print(f"BEAT {b['id']} layers={len(layers)}")
    (work / "segs.txt").write_text("".join(f"file '{p}'\n" for p in segs))
    joined = work / "joined.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
                    "-i", str(work / "segs.txt"), "-c", "copy", str(joined)], check=True)
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(joined), "-i", str(built),
                    "-map", "0:v", "-map", "1:a", "-c", "copy", "-shortest", "-movflags", "+faststart", str(out)], check=True)
    print(f"OVERLAID {out}")


def render_beat(layers, t0, dur, seg):
    """Every input starts at 0 and lasts the beat; alpha fades place each layer in time (no timestamp offsets)."""
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "lavfi", "-i", f"color=c=0x0b0d12:s={W}x{H}:r={FPS}:d={dur:.3f}"]
    graph, last = [], "0:v"
    for n, (kind, src, a, b_, fade, fade_out) in enumerate(layers, 1):
        a, b_ = a - t0, b_ - t0
        if kind == "png":
            cmd += ["-loop", "1", "-framerate", str(FPS), "-t", f"{dur:.3f}", "-i", str(src)]
            f = f"[{n}:v]format=rgba"
        else:
            cmd += ["-ss", str(src.get("ss", 0)), "-i", src["video"]]
            crop = f",crop={':'.join(map(str, src['crop']))}" if src.get("crop") else ""
            f = (f"[{n}:v]setpts=(PTS-STARTPTS)/{src.get('speed', 1)},fps={FPS}{crop},"
                 f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12,"
                 f"trim=duration={dur - a:.3f},setpts=PTS-STARTPTS,"
                 f"tpad=start_duration={a:.3f}:stop_mode=clone:stop_duration={dur:.3f},trim=duration={dur:.3f},format=rgba")
        if a > 0.01 or fade:
            f += f",fade=in:st={a:.3f}:d={max(fade, 0.04):.3f}:alpha=1"
        if fade_out and b_ < dur - 0.05:
            f += f",fade=out:st={max(a, b_ - 0.3):.3f}:d=0.3:alpha=1"
        graph.append(f + f"[l{n}]")
        graph.append(f"[{last}][l{n}]overlay=0:0:shortest=0[v{n}]")
        last = f"v{n}"
    graph.append(f"[{last}]format=yuv420p,trim=duration={dur:.3f}[vout]")
    script = seg.with_suffix(".graph.txt")
    script.write_text(";\n".join(graph))
    cmd += ["-/filter_complex", str(script), "-map", "[vout]", "-an", "-c:v", "libx264", "-preset", "medium",
            "-crf", "17", "-r", str(FPS), "-t", f"{dur:.3f}", str(seg)]
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    if sys.argv[1] == "--length":  # build.sh: overlays.py --length <script.json> <beat id> <narration seconds>
        spec = json.loads(Path(sys.argv[2]).read_text())
        print(f"{beat_length(spec, next(b for b in spec['beats'] if b['id'] == sys.argv[3]), float(sys.argv[4])):.4f}")
    else:
        main()
