#!/usr/bin/env node
/**
 * Upload a processed queue video to the naat YouTube channel.
 *
 * Thin wrapper around yt/upload-video.cjs (same tokens, duplicate check, receipt
 * and Play Store comment): it builds the metadata file for the job from
 * queue/jobs.json, runs the uploader, then records the YouTube URL back into the job.
 *
 * Usage:
 *   node scripts/upload-queue-video.cjs <id> [--channel main|teenage]
 *        [--privacy public|unlisted|private] [--dry-run] [--no-comment] [--force]
 *
 * Requires: --confirm is added automatically unless --dry-run.
 *
 * Daily caps: 3 main uploads (`NAAT_UPLOADS_PER_DAY`) and 3 teenage uploads
 * (`NAAT_TEEN_UPLOADS_PER_DAY`) per calendar day, tracked separately by channel
 * in queue/uploads.json. When a channel's budget is used up this script exits
 * 3 (deferral) unless --force / --dry-run. Every real upload is recorded after
 * the receipt.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ensureThumbnail, ensureTeenThumbnail } = require("./lib/thumbnail.cjs");
const { recordUpload, remainingToday, DAILY_LIMITS } = require("./lib/upload-budget.cjs");

const ROOT = path.join(__dirname, "..");
const QUEUE_PATH = path.join(ROOT, "queue", "jobs.json");
const META_DIR = path.join(ROOT, "yt", "queue-uploads");
const UPLOADER = path.join(ROOT, "yt", "upload-video.cjs");
const ENV_PATH = "D:/Projects/naat-collection/.env.naat-collection";
const NAAT_MODULES = "D:/Projects/naat-collection/node_modules";

const CHANNELS = {
  main: {
    prefix: "[No Explanation]",
    intro: "This naat has NO explanation or commentary — pure naat audio only.",
    hashtags: "#naat #islamic #nasheed #noexplanation #owaisrazaqadri",
    tags: ["no explanation", "pure naat", "islamic naat"],
  },
  teenage: {
    prefix: "[Teenage Voice]",
    intro: "Teenage-voice version (+6 semitones) of this naat.",
    hashtags: "#naat #islamic #nasheed #teenagevoice #teenvoice",
    tags: ["teenage voice", "teen voice", "six semitone"],
  },
};

/**
 * Where each channel keeps its upload state in queue/jobs.json. Keeping the
 * fields apart means a teenage upload can never be mistaken for the main one
 * (or skip the main upload because a teenage URL is already present).
 */
const CHANNEL_STATE = {
  main: {
    urlField: "youtubeUrl",
    idField: "youtubeVideoId",
    channelField: "youtubeChannel",
    atField: "uploadedAt",
    receiptField: "uploadReceipt",
    thumbField: "thumbPath",
    thumbSetField: "thumbnailSet",
    errorField: "uploadError",
    metaSuffix: "",
  },
  teenage: {
    urlField: "teenYoutubeUrl",
    idField: "teenYoutubeVideoId",
    channelField: "teenYouTubeChannel",
    atField: "teenUploadedAt",
    receiptField: "teenUploadReceipt",
    thumbField: "teenThumbPath",
    thumbSetField: "teenThumbnailSet",
    errorField: "teenUploadError",
    metaSuffix: ".teenage",
  },
};

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(name);

function loadQueue() {
  return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
}
function saveQueue(data) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2));
}

/** Read the small subset of .env we need (no dotenv dependency in this process). */
function readEnv(keys) {
  const out = {};
  const text = fs.readFileSync(ENV_PATH, "utf-8");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || !keys.includes(m[1])) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const k of keys) if (!out[k] && process.env[k]) out[k] = process.env[k];
  return out;
}

function fmtDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function probeDuration(file) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf-8" },
  ).trim();
  return Number(out) || 0;
}

/** Resolve the cut file for a job, tolerating older jobs without videoOutput. */
function videoPathFor(job, channelKey = "main") {
  const suffix = channelKey === "teenage" ? " [teenage voice]" : "";
  const candidates =
    channelKey === "teenage"
      ? [job.teenVideoOutput, job.title ? path.join(ROOT, "cut", `${job.id} - ${job.title}${suffix}.mp4`) : null]
      : [job.videoOutput, job.title ? path.join(ROOT, "cut", `${job.id} - ${job.title}.mp4`) : null];
  for (const p of candidates.filter(Boolean)) if (fs.existsSync(p)) return p;
  if (channelKey === "teenage") {
    throw new Error(`No teenage video for ${job.id} — run the teenage step first`);
  }
  if (job.videoOutput) throw new Error(`Cut video is missing: ${job.videoOutput}`);
  throw new Error(`No cut video found for ${job.id} — run the processing step first`);
}

function buildMeta(job, videoPath, channelKey, privacy, thumbPath) {
  const ch = CHANNELS[channelKey];
  if (!ch) throw new Error(`Unknown channel "${channelKey}"`);
  const env = readEnv(["APP_NAME", "PLAY_STORE_URL"]);
  const track = (job.title || job.id).replace(/\s+/g, " ").trim();
  const duration = probeDuration(videoPath);

  const title = `${ch.prefix} ${track}`.slice(0, 100);
  const description = [
    ch.intro,
    "",
    `🎵 ${track}`,
    `🎤 ${env.APP_NAME || "Owais Raza Qadri"}`,
    `⏱ ${fmtDuration(duration)}`,
    "",
    `📥 Download the ${env.APP_NAME || "Owais Raza Qadri"} app from Google Play Store:`,
    env.PLAY_STORE_URL || "https://play.google.com/store/apps/details?id=com.owaisrazaqadri",
    "",
    ch.hashtags,
  ].join("\n");

  const tags = ["naat", "islamic", "nasheed", ...ch.tags, track.toLowerCase().slice(0, 80)];

  return {
    videoPath,
    thumbPath: thumbPath || undefined,
    title,
    description,
    tags: [...new Set(tags)],
    categoryId: "22",
    defaultLanguage: "en",
    privacyStatus: privacy,
    selfDeclaredMadeForKids: false,
  };
}

const jobId = process.argv[2];
const CHANNEL_KEY = String(arg("--channel", "main"));
const PRIVACY = String(arg("--privacy", "public"));
const DRY_RUN = has("--dry-run");
const COMMENT = !has("--no-comment");
const FORCE = has("--force");

if (!jobId) {
  console.error("Usage: upload-queue-video.cjs <id> [--channel main|teenage] [--privacy ...] [--dry-run] [--no-comment] [--force]");
  process.exit(1);
}

const data = loadQueue();
const job = data.jobs.find((j) => j.id === jobId);
if (!job) throw new Error(`No job ${jobId} in queue/jobs.json`);
const state = CHANNEL_STATE[CHANNEL_KEY];
if (!state) throw new Error(`Unknown channel "${CHANNEL_KEY}"`);

const existingUrl = job[state.urlField];
if (existingUrl && !FORCE) {
  console.log(`${job.id} already uploaded to ${CHANNEL_KEY}: ${existingUrl}`);
  console.log("Use --force to upload again.");
  process.exit(0);
}

// Hard daily cap per channel (3 by default) — exit 3 tells the pipeline this is
// a deferral, not a failure, so the job stays queued for tomorrow.
if (!DRY_RUN && !FORCE && remainingToday(CHANNEL_KEY) <= 0) {
  console.log(`Daily ${CHANNEL_KEY} upload limit reached (${DAILY_LIMITS[CHANNEL_KEY]}/day) — ${job.id} stays queued.`);
  console.log("Use --force to override.");
  process.exit(3);
}

const videoPath = videoPathFor(job, CHANNEL_KEY);
const thumbPath =
  CHANNEL_KEY === "teenage"
    ? job.teenThumbPath && fs.existsSync(job.teenThumbPath)
      ? job.teenThumbPath
      : ensureTeenThumbnail(job.id, path.join(ROOT, "download"))
    : job.thumbPath && fs.existsSync(job.thumbPath)
      ? job.thumbPath
      : ensureThumbnail(job.id, path.join(ROOT, "download"));
if (!thumbPath) console.warn(`[${job.id}] no thumbnail available — uploading without one`);
const meta = buildMeta(job, videoPath, CHANNEL_KEY, PRIVACY, thumbPath);

fs.mkdirSync(META_DIR, { recursive: true });
const metaPath = path.join(META_DIR, `${job.id}${state.metaSuffix}.meta.json`);
const resultPath = metaPath.replace(/\.json$/, "-result.json");
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);

console.log(`[${job.id}] uploading ${path.basename(videoPath)}`);
console.log(`  title  : ${meta.title}`);
console.log(`  privacy: ${meta.privacyStatus}`);
console.log(`  thumb  : ${meta.thumbPath || "(none)"}`);
console.log(`  meta   : ${metaPath}`);

const args = [UPLOADER, "--meta", metaPath, "--channel", CHANNEL_KEY];
if (!DRY_RUN) args.push("--confirm");
if (COMMENT && !DRY_RUN) args.push("--comment");
// Never create a second public copy when a video with this exact title already
// exists — adopt it instead. --force deliberately bypasses this guard.
if (!DRY_RUN && !FORCE) args.push("--abort-on-duplicate");

const env = {
  ...process.env,
  NODE_PATH: [process.env.NODE_PATH, NAAT_MODULES].filter(Boolean).join(path.delimiter),
};

/** Exit 4 from the uploader means "duplicate found": adopt that video. */
function adoptDuplicate(output) {
  const m = /DUPLICATE_ID=([\w-]{11})/.exec(output || "");
  if (!m) return false;
  const id = m[1];
  const url = `https://youtu.be/${id}`;
  const fresh = loadQueue();
  const saved = fresh.jobs.find((j) => j.id === job.id);
  if (!saved) return false;
  Object.assign(saved, {
    [state.urlField]: url,
    [state.idField]: id,
    [state.atField]: new Date().toISOString(),
    [state.thumbField]: thumbPath || undefined,
    [state.thumbSetField]: false,
    updatedAt: new Date().toISOString(),
  });
  delete saved[state.errorField];
  saveQueue(fresh);
  recordUpload(job.id, CHANNEL_KEY);
  console.log(`[${job.id}] adopted existing ${CHANNEL_KEY} upload: ${url}`);
  return true;
}

try {
  const output = execFileSync(process.execPath, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
    env,
    cwd: ROOT,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (output) process.stdout.write(output);
} catch (err) {
  if (err.status === 4 && adoptDuplicate(err.stdout || "")) process.exit(0);
  if (err.stdout) process.stdout.write(err.stdout);
  throw new Error(`uploader failed for ${job.id}: ${err.message.split("\n")[0]}`);
}

if (DRY_RUN) {
  console.log(`[${job.id}] dry run — nothing uploaded`);
  process.exit(0);
}

const receipt = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
const fresh = loadQueue();
const saved = fresh.jobs.find((j) => j.id === job.id);
Object.assign(saved, {
  [state.urlField]: receipt.url,
  [state.idField]: receipt.videoId,
  [state.channelField]: receipt.channel,
  [state.atField]: receipt.at,
  [state.receiptField]: resultPath,
  [state.thumbField]: thumbPath || undefined,
  [state.thumbSetField]: Boolean(receipt.thumbnail),
  updatedAt: new Date().toISOString(),
});
delete saved[state.errorField];
saveQueue(fresh);
const quota = recordUpload(job.id, CHANNEL_KEY);
console.log(
  `[${job.id}] ${CHANNEL_KEY} uploaded -> ${receipt.url}${receipt.thumbnail ? " (with thumbnail)" : ""}` +
    `  [${quota.count}/${quota.limit} ${CHANNEL_KEY} uploads today]`,
);
