#!/usr/bin/env bash
# Assemble the submission video from script.json (plan 08-01).
#
#   bash scripts/video/build.sh <script.json> <frames dir> <out.mp4>
#
# Per beat: narration with macOS say, a segment of max(slot, narration + 0.6 s)
# from <frames dir>/<id>/frames/ (one PNG = a still; numbered PNGs = a sequence
# played at <id>/fps, default 30, holding its last frame), falling back to
# <id>/card.png, with <id>/caption.png overlaid. Then concat, mux narration as
# AAC 48 kHz, and write <out>.srt and <out>.timings.tsv. Output stays outside
# the repository. Voice: PRISM_VOICE, else script.json "voice", else Karen.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: build.sh <script.json> <frames dir> <out.mp4>" >&2
  exit 2
fi
SCRIPT=$1
FRAMES=$2
OUT=$3
FPS=30
BASE=${OUT%.mp4}
WORK="$BASE.work"
rm -rf "$WORK"
mkdir -p "$WORK"

# One line per beat: "<id> <seconds>"; narration text (placeholders spoken as "X")
# and caption text (placeholders as [NAME]) go to files, so no text passes through the shell.
VOICE_DEFAULT=$(node -e '
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const b of s.beats) {
  fs.writeFileSync(`${process.argv[2]}/${b.id}.txt`, b.narration.replace(/\{\{[A-Z0-9_]+\}\}/g, "X"));
  fs.writeFileSync(`${process.argv[2]}/${b.id}.srt.txt`, b.narration.replace(/\{\{([A-Z0-9_]+)\}\}/g, "[$1]"));
  fs.appendFileSync(`${process.argv[2]}/beats.txt`, `${b.id} ${b.seconds}\n`);
}
console.log(s.voice || "Karen");
' "$SCRIPT" "$WORK")
VOICE=${PRISM_VOICE:-$VOICE_DEFAULT}

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
: > "$WORK/video.txt"
: > "$WORK/audio.txt"
: > "$BASE.timings.tsv"
START=0

while read -r ID SEC <&3; do
  say -v "$VOICE" -o "$WORK/$ID.aiff" -f "$WORK/$ID.txt"
  NAR=$(dur "$WORK/$ID.aiff")
  LEN=$(node -e 'const [n, s] = process.argv.slice(1).map(Number); console.log((Math.ceil(Math.max(s, n + 0.6) * 30) / 30).toFixed(4))' "$NAR" "$SEC")

  DIR="$FRAMES/$ID"
  N=0
  if [ -d "$DIR/frames" ]; then N=$(find "$DIR/frames" -maxdepth 1 -name '*.png' | wc -l | tr -d ' '); fi
  if [ "$N" -gt 1 ]; then
    RATE=$(cat "$DIR/fps" 2>/dev/null || echo "$FPS")
    IN=(-framerate "$RATE" -i "$DIR/frames/%05d.png")
    HOLD=",tpad=stop_mode=clone:stop_duration=$LEN"
  else
    if [ "$N" -eq 1 ]; then IMG=$(find "$DIR/frames" -maxdepth 1 -name '*.png' | head -1); else IMG="$DIR/card.png"; fi
    [ -f "$IMG" ] || { echo "build: no frames and no card for $ID" >&2; exit 1; }
    IN=(-loop 1 -framerate "$FPS" -t "$LEN" -i "$IMG")
    HOLD=""
  fi
  FIT="scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=$FPS$HOLD"
  if [ -f "$DIR/caption.png" ]; then
    ffmpeg -hide_banner -loglevel error -y "${IN[@]}" -loop 1 -framerate "$FPS" -t "$LEN" -i "$DIR/caption.png" \
      -filter_complex "[0:v]$FIT[b];[b][1:v]overlay=0:0,format=yuv420p[v]" -map "[v]" -an \
      -c:v libx264 -preset medium -crf 16 -r "$FPS" -t "$LEN" "$WORK/$ID.mp4"
  else
    ffmpeg -hide_banner -loglevel error -y "${IN[@]}" -vf "$FIT,format=yuv420p" -an \
      -c:v libx264 -preset medium -crf 16 -r "$FPS" -t "$LEN" "$WORK/$ID.mp4"
  fi
  ffmpeg -hide_banner -loglevel error -y -i "$WORK/$ID.aiff" \
    -af "adelay=300:all=1,aresample=48000,apad=whole_dur=$LEN" -t "$LEN" -ac 2 -ar 48000 -c:a pcm_s16le "$WORK/$ID.wav"

  SEG=$(dur "$WORK/$ID.mp4")
  END=$(node -e 'console.log((Number(process.argv[1]) + Number(process.argv[2])).toFixed(3))' "$START" "$SEG")
  printf '%s\t%s\t%s\t%s\n' "$ID" "$START" "$END" "$NAR" >> "$BASE.timings.tsv"
  START=$END
  echo "file '$WORK/$ID.mp4'" >> "$WORK/video.txt"
  echo "file '$WORK/$ID.wav'" >> "$WORK/audio.txt"
  echo "BEAT $ID slot=${SEC}s narration=${NAR}s segment=${SEG}s"
done 3< "$WORK/beats.txt"

ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$WORK/video.txt" -c copy "$WORK/joined.mp4"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$WORK/audio.txt" -c copy "$WORK/narration.wav"
TOTAL=$(dur "$WORK/joined.mp4")
ffmpeg -hide_banner -loglevel error -y -i "$WORK/joined.mp4" -i "$WORK/narration.wav" \
  -filter_complex "[1:a]aresample=48000,apad=whole_dur=$TOTAL,atrim=duration=$TOTAL[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 48000 -t "$TOTAL" -movflags +faststart "$OUT"

node -e '
const fs = require("node:fs");
const [tsv, work, out] = process.argv.slice(1);
const t = (s) => { const ms = Math.round(Number(s) * 1000); const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const rows = fs.readFileSync(tsv, "utf8").trim().split("\n").map((l) => l.split("\t"));
fs.writeFileSync(out, rows.map(([id, a, , nar], i) =>
  `${i + 1}\n${t(Number(a) + 0.3)} --> ${t(Number(a) + 0.3 + Number(nar))}\n${fs.readFileSync(`${work}/${id}.srt.txt`, "utf8")}\n`).join("\n"));
' "$BASE.timings.tsv" "$WORK" "$BASE.srt"

echo "BUILT $OUT total=${TOTAL}s voice=$VOICE"
