#!/usr/bin/env node
/**
 * Remove the detected explanation segments from the VIDEO, using the detection JSON
 * produced by the naat AI service for that naat's audio.
 *
 * Each kept segment is trimmed out and concatenated; audio gets a 0.3 s fade-in /
 * fade-out at every segment boundary, exactly like the cut-audio worker in the
 * naat-collection repo (functions/cut-audio-cron/index.ts).
 *
 * Usage:
 *   node scripts/cut-video.cjs <detection.json> <input.mp4> <output.mp4> [--crf 20] [--preset veryfast] [--pad 0.15]
 */
const fs = require("fs");
const { execFileSync } = require("child_process");
const { computeKept, fmt, fadeChain } = require("./lib/segments.cjs");

const [detPath, inPath, outPath] = process.argv.slice(2);
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const crf = String(arg("--crf", 20));
const preset = String(arg("--preset", "veryfast"));
const pad = Number(arg("--pad", 0));

if (!detPath || !inPath || !outPath) {
  console.error("Usage: cut-video.cjs <detection.json> <input.mp4> <output.mp4> [--crf] [--preset] [--pad]");
  process.exit(1);
}

const detection = JSON.parse(fs.readFileSync(detPath, "utf-8"));
const { duration, cut, keep, keptDuration } = computeKept(detection, { pad });

console.log(`Video duration : ${fmt(duration)}`);
if (pad > 0) console.log(`Padding        : ${pad}s on each side of every kept range`);
console.log(`Explanation cut: ${cut.length} range(s), ${(duration - keptDuration).toFixed(1)}s removed`);
for (const [a, b] of cut) console.log(`  cut  ${fmt(a)} -> ${fmt(b)}`);
console.log(`Kept segments  : ${keep.length}, ${keptDuration.toFixed(1)}s`);
for (const [a, b] of keep) console.log(`  keep ${fmt(a)} -> ${fmt(b)}`);

if (!keep.length) {
  console.error("Nothing left after cutting — aborting.");
  process.exit(1);
}

// One trim/concat branch per kept segment, with the audio fades at each join.
const filters = [];
const labels = [];
keep.forEach(([start, end], i) => {
  const fade = fadeChain(start, end, i === 0);
  filters.push(
    `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`,
  );
  filters.push(
    `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${fade ? "," + fade : ""}[a${i}]`,
  );
  labels.push(`[v${i}][a${i}]`);
});
filters.push(`${labels.join("")}concat=n=${keep.length}:v=1:a=1[outv][outa]`);

console.log(`\nCutting video (libx264 crf ${crf}, ${preset}) with audio fades...`);
execFileSync(
  "ffmpeg",
  [
    "-y", "-v", "error", "-stats",
    "-i", inPath,
    "-filter_complex", filters.join(";"),
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-crf", crf, "-preset", preset, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ],
  { stdio: "inherit" },
);

const probe = execFileSync(
  "ffprobe",
  ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", outPath],
  { encoding: "utf-8" },
).trim();
console.log(`\nWrote: ${outPath}`);
console.log(`Output duration: ${fmt(Number(probe))} (expected ~${fmt(keptDuration)})`);
