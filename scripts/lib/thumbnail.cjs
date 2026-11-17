/**
 * Thumbnail helper: fetch the best YouTube thumbnail for a video id, then stamp
 * the "NO EXPLANATION" band on it (the style picked during the thumbnail research).
 *
 * YouTube exposes several sizes; maxresdefault is 1280x720 but is not generated
 * for every video, so fall back through sddefault/hqdefault/mqdefault.
 * YouTube rejects thumbnails over 2 MB, so oversized files are skipped.
 *
 *   download/<id>.jpg        raw original (kept so it can be re-rendered)
 *   download/<id>-thumb.jpg  the 1280x720 upload thumbnail (returned)
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RENDERER = path.join(__dirname, "thumbnail-render.ps1");
const VARIANTS = ["maxresdefault", "sddefault", "hqdefault", "mqdefault"];
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_BYTES = 5000;

function isUsable(file) {
  try {
    const size = fs.statSync(file).size;
    return size > MIN_BYTES && size <= MAX_BYTES;
  } catch {
    return false;
  }
}

/** Download the best available original into `out`. Returns true on success. */
function fetchOriginal(id, out) {
  for (const variant of VARIANTS) {
    const url = `https://i.ytimg.com/vi/${id}/${variant}.jpg`;
    try {
      const code = execFileSync(
        "curl",
        ["-sS", "-L", "--max-time", "60", "-o", out, "-w", "%{http_code}", url],
        { encoding: "utf-8" },
      ).trim();
      if (code === "200" && isUsable(out)) return true;
    } catch {
      // try the next size
    }
  }
  try {
    fs.unlinkSync(out);
  } catch {}
  return false;
}

/** Render the band-style thumbnail onto `src` (kicker is the band's text). */
function renderThumbnail(src, out, { kicker = "NO EXPLANATION" } = {}) {
  execFileSync(
    "powershell",
    [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RENDERER,
      "-Base", src, "-Out", out, "-Layout", "band", "-Kicker", kicker,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!isUsable(out)) throw new Error("renderer produced no usable image");
  return out;
}

/**
 * Returns the path of the thumbnail to upload — the raw image with the
 * "NO EXPLANATION" band — or null when no original could be fetched at all.
 */
function ensureThumbnail(id, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, `${id}.jpg`);
  const out = path.join(dir, `${id}-thumb.jpg`);

  if (isUsable(out)) return out;
  if (!isUsable(raw) && !fetchOriginal(id, raw)) return null;

  try {
    return renderThumbnail(raw, out);
  } catch (err) {
    // A plain thumbnail is better than none — upload carries on either way.
    console.warn(`  thumbnail render failed (${err.message}) — using the original image`);
    return raw;
  }
}

/**
 * Teenage-channel artwork: the same original image, same band style, with a
 * "TEENAGE VOICE" kicker. It is both the upload thumbnail and the still image
 * of the teenage video.
 */
function ensureTeenThumbnail(id, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, `${id}.jpg`);
  const out = path.join(dir, `${id}-teen-thumb.jpg`);

  if (isUsable(out)) return out;
  if (!isUsable(raw) && !fetchOriginal(id, raw)) return null;

  try {
    return renderThumbnail(raw, out, { kicker: "TEENAGE VOICE" });
  } catch (err) {
    console.warn(`  teenage thumbnail render failed (${err.message}) — using the original image`);
    return raw;
  }
}

module.exports = { ensureThumbnail, ensureTeenThumbnail, fetchOriginal, renderThumbnail };
