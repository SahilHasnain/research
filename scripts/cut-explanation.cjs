#!/usr/bin/env node
/**
 * Remove detected explanation (speech) segments from the audio.
 *
 * Each kept segment is trimmed out and concatenated; audio gets a 0.3 s fade-in /
 * fade-out at every segment boundary, exactly like the cut-audio worker in the
 * naat-collection repo (functions/cut-audio-cron/index.ts).
 *
 * Usage:
 *   node scripts/cut-explanation.cjs <detection.json> <input.mp3> <output.mp3> [--pad 0.15]
 */
const fs = require("fs");
const { execFileSync } = require("child_process");
const { computeKept, fmt, fadeChain } = require("./lib/segments.cjs");

const [detPath, inPath, outPath] = process.argv.slice(2);
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const pad = Number(arg("--pad", 0));

if (!detPath || !inPath || !outPath) {
  console.error("Usage: cut-explanation.cjs <detection.json> <input.mp3> <output.mp3> [--pad 0.15]");
  process.exit(1);
}

const detection = JSON.parse(fs.readFileSync(detPath, "utf-8"));
const { duration, cut, keep, keptDuration } = computeKept(detection, { pad });

console.log(`Source duration : ${fmt(duration)}`);
if (pad > 0) console.log(`Padding         : ${pad}s on each side of every kept range`);
console.log(`Explanation cut : ${cut.length} range(s), ${(duration - keptDuration).toFixed(1)}s removed`);
for (const [a, b] of cut) console.log(`  cut  ${fmt(a)} -> ${fmt(b)}`);
console.log(`Kept segments   : ${keep.length}, ${keptDuration.toFixed(1)}s`);
for (const [a, b] of keep) console.log(`  keep ${fmt(a)} -> ${fmt(b)}`);

if (!keep.length) {
  console.error("Nothing left after cutting — aborting.");
  process.exit(1);
}

const filters = [];
const labels = [];
keep.forEach(([start, end], i) => {
  const fade = fadeChain(start, end, i === 0);
  filters.push(
    `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${fade ? "," + fade : ""}[a${i}]`,
  );
  labels.push(`[a${i}]`);
});
filters.push(`${labels.join("")}concat=n=${keep.length}:v=0:a=1[out]`);

console.log("\nRunning ffmpeg (removing explanation, adding fades)...");
execFileSync(
  "ffmpeg",
  [
    "-y", "-v", "error",
    "-i", inPath,
    "-filter_complex", filters.join(";"),
    "-map", "[out]",
    "-c:a", "libmp3lame", "-q:a", "2",
    outPath,
  ],
  { stdio: "inherit" },
);
console.log(`\nWrote: ${outPath}`);
console.log(`Kept ${fmt(keptDuration)} of ${fmt(duration)}`);
