#!/usr/bin/env bash
# Check an assembled submission video (plan 08-01).
#
#   bash scripts/video/check.sh <video.mp4> <script.json> <out dir>
#
# Prints DURATION, VIDEO, AUDIO and MEAN_VOLUME lines; fails when the video is
# 175 s or longer, is not h264 1920x1080 yuv420p, has no aac 48 kHz audio, or
# its mean volume is below -40 dB (silence). Writes one JPG per beat at the
# beat's midpoint (<id>.jpg; timings from <video>.timings.tsv when build.sh wrote
# one, else from the script's slots) and a contact sheet, contact.jpg.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: check.sh <video.mp4> <script.json> <out dir>" >&2
  exit 2
fi
VIDEO=$1
SCRIPT=$2
OUT=$3
mkdir -p "$OUT"
FAIL=0
probe() { ffprobe -v error -select_streams "$1" -show_entries "stream=$2" -of csv=p=0 "$VIDEO" | head -1; }

DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO")
V=$(probe v:0 codec_name,width,height,pix_fmt)
A=$(probe a:0 codec_name,sample_rate)
MEAN=$(ffmpeg -hide_banner -nostats -i "$VIDEO" -map 0:a -af volumedetect -f null /dev/null 2>&1 | sed -n 's/.*mean_volume: \(-*[0-9.]*\) dB.*/\1/p')
echo "DURATION $DURATION"
echo "VIDEO $V"
echo "AUDIO $A"
echo "MEAN_VOLUME ${MEAN:-none} dB"

node -e 'process.exit(Number(process.argv[1]) < 175 ? 0 : 1)' -- "$DURATION" || { echo "FAIL duration is 175 s or more" >&2; FAIL=1; }
[ "$V" = "h264,1920,1080,yuv420p" ] || { echo "FAIL video is not h264 1920x1080 yuv420p" >&2; FAIL=1; }
[ "$A" = "aac,48000" ] || { echo "FAIL audio is not aac 48000" >&2; FAIL=1; }
node -e 'const m = process.argv[1]; process.exit(m !== "" && Number(m) >= -40 ? 0 : 1)' -- "${MEAN:-}" || { echo "FAIL mean volume below -40 dB (silence)" >&2; FAIL=1; }

TIMINGS="${VIDEO%.mp4}.timings.tsv"
node -e '
const fs = require("node:fs");
const [script, timings] = process.argv.slice(1);
let rows;
if (fs.existsSync(timings)) rows = fs.readFileSync(timings, "utf8").trim().split("\n").map((l) => l.split("\t"));
else { let t = 0; rows = JSON.parse(fs.readFileSync(script, "utf8")).beats.map((b) => [b.id, t, (t += b.seconds)]); }
for (const [id, a, b] of rows) console.log(id, ((Number(a) + Number(b)) / 2).toFixed(3));
' "$SCRIPT" "$TIMINGS" > "$OUT/midpoints.txt"

rm -rf "$OUT/sheet"
mkdir -p "$OUT/sheet"
I=0
COUNT=0
while read -r ID MID <&3; do
  ffmpeg -hide_banner -loglevel error -y -ss "$MID" -i "$VIDEO" -frames:v 1 -q:v 3 "$OUT/$ID.jpg"
  I=$((I + 1))
  cp "$OUT/$ID.jpg" "$OUT/sheet/$(printf '%03d' "$I").jpg"
  echo "FRAME $ID at ${MID}s -> $OUT/$ID.jpg"
  COUNT=$((COUNT + 1))
done 3< "$OUT/midpoints.txt"
[ "$COUNT" -gt 0 ] || { echo "FAIL no beat frames written" >&2; FAIL=1; }

COLS=3
ROWS=$(( (COUNT + COLS - 1) / COLS ))
ffmpeg -hide_banner -loglevel error -y -framerate 1 -i "$OUT/sheet/%03d.jpg" \
  -vf "scale=640:360,tile=${COLS}x${ROWS}:padding=8:margin=8" -frames:v 1 "$OUT/contact.jpg"
echo "CONTACT $OUT/contact.jpg"

if [ "$FAIL" -ne 0 ]; then echo "CHECK FAILED"; exit 1; fi
echo "CHECK PASSED"
