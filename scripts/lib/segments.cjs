/**
 * Shared logic: turn detected explanation ("speech") segments into the ranges we keep,
 * plus the fade-in/fade-out filters used at every kept-segment boundary.
 *
 * Fade behaviour mirrors naat-collection/functions/cut-audio-cron/index.ts:
 *   FADE_DURATION = 0.3 s
 *   fade-in  on every kept segment except a first segment that starts at 0
 *   fade-out on every kept segment (including the last one)
 */

const FADE_DURATION = 0.3;

function computeKept(detection, options = {}) {
  const pad = Math.max(0, Number(options.pad || 0));
  const duration = Number(detection.duration || 0);
  const speech = (detection.speechSegments || [])
    .map((s) => [Math.max(0, Number(s.start)), Math.min(duration, Number(s.end))])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);

  // Merge overlapping/adjacent explanation ranges.
  const cut = [];
  for (const seg of speech) {
    const last = cut[cut.length - 1];
    if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
    else cut.push([...seg]);
  }

  // Complement = parts we keep.
  const keep = [];
  let cursor = 0;
  for (const [s, e] of cut) {
    if (s > cursor) keep.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < duration) keep.push([cursor, duration]);

  // Optional padding: grow every kept range by `pad` seconds on BOTH sides
  // (i.e. keep a little of the explanation), clamped to the media and merged so
  // overlapping ranges are not encoded twice.
  let padded = keep;
  if (pad > 0) {
    padded = [];
    for (const [a, b] of keep) {
      const s = Math.max(0, a - pad);
      const e = Math.min(duration, b + pad);
      const last = padded[padded.length - 1];
      if (last && s <= last[1] + 1e-9) last[1] = Math.max(last[1], e);
      else padded.push([s, e]);
    }
  }

  const keptDuration = padded.reduce((sum, [a, b]) => sum + (b - a), 0);
  return {
    duration,
    cut,
    keep: padded,
    unpaddedKeep: keep,
    pad,
    keptDuration,
    removed: duration - keptDuration,
  };
}

function fmt(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(5, "0")}`;
}

/**
 * afade chain for one kept segment, matching the naat-collection cut-audio worker.
 * `start`/`end` are source-timeline values; `isFirst` is true for the first kept segment.
 * Returns "" when no fade applies (single full-length keep).
 */
function fadeChain(start, end, isFirst, fade = FADE_DURATION) {
  const segDur = end - start;
  const filters = [];
  if (!isFirst || start > 0) filters.push(`afade=t=in:st=0:d=${fade}`);
  filters.push(`afade=t=out:st=${Math.max(0, segDur - fade).toFixed(3)}:d=${fade}`);
  return filters.join(",");
}

module.exports = { computeKept, fmt, fadeChain, FADE_DURATION };
