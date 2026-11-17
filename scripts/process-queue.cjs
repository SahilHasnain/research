#!/usr/bin/env node
/**
 * Process naat jobs:
 *   1. download MP3 (bestaudio)
 *   2. detect explanation segments via the naat AI service (/detect-segments)
 *   3. cut explanation out of the audio (only if --keep-audio)
 *   4. download the video (<=1080p) and cut the SAME segments out of it
 *   5. delete the MP3s (audio is only needed for detection); keep detection JSON
 *   6. upload the cut video to YouTube (main channel, thumbnail + Play Store comment)
 *   7. comment on the ORIGINAL naat video linking to our no-explanation cut
 *   8. teenage-voice version: the cut audio is pitched +6 semitones and uploaded
 *      to the teenage channel as a still-image video (band "TEENAGE VOICE")
 *
 * Usage:
 *   node scripts/process-queue.cjs                    # process all pending jobs
 *   node scripts/process-queue.cjs --one              # only one pending job
 *   node scripts/process-queue.cjs --videos-only      # backfill videos for detected jobs
 *   node scripts/process-queue.cjs --keep-audio       # keep MP3 outputs for debugging
 *   node scripts/process-queue.cjs --keep-video       # keep the downloaded source video
 *   node scripts/process-queue.cjs --no-upload        # cut only, do not upload
 *   node scripts/process-queue.cjs --no-source-comment  # upload only, no source comment
 *   node scripts/process-queue.cjs --no-teen          # skip the teenage channel
 *
 * Daily caps (queue/uploads.json): 3 main uploads, 3 teenage uploads.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ensureThumbnail, ensureTeenThumbnail } = require("./lib/thumbnail.cjs");
const { extractAudio, pitchShift, buildStillVideo, SEMITONES } = require("./lib/teen-voice.cjs");
const { recordUpload, remainingToday, DAILY_LIMITS } = require("./lib/upload-budget.cjs");

const ROOT = path.join(__dirname, "..");
const QUEUE_PATH = path.join(ROOT, "queue", "jobs.json");
const DL_DIR = path.join(ROOT, "download");
const CUT_DIR = path.join(ROOT, "cut");
const AI_URL = process.env.NAAT_AI_URL || "http://localhost:8000/detect-segments";

const LOCK_PATH = path.join(ROOT, "queue", ".processor.lock");

const KEEP_AUDIO = process.argv.includes("--keep-audio");
const KEEP_VIDEO = process.argv.includes("--keep-video");
const VIDEOS_ONLY = process.argv.includes("--videos-only");
const UPLOAD = !process.argv.includes("--no-upload");
// Commenting on someone else's video is opt-in: it only runs when explicitly
// enabled, so the scheduled task can never post one before you approve it.
const SOURCE_COMMENT =
  !process.argv.includes("--no-source-comment") && process.env.NAAT_SOURCE_COMMENT === "on";
// Teenage-voice versions are part of the normal flow unless disabled.
const TEEN = !process.argv.includes("--no-teen");
const UPLOAD_ATTEMPTS = Number(process.env.NAAT_UPLOAD_ATTEMPTS || 3);

function load() {
  return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
}
function save(data) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2));
}
function safeName(s) {
  return s.replace(/[\\/:*?"<>|｜]+/g, " ").replace(/\s+/g, " ").trim();
}
function stamp(id, status, extra = {}) {
  const data = load();
  const job = data.jobs.find((j) => j.id === id);
  if (job) Object.assign(job, { status, updatedAt: new Date().toISOString() }, extra);
  save(data);
}
function probeJson(file, entries) {
  return JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "json", file], {
      encoding: "utf-8",
    }),
  );
}

function downloadAudio(id, audioPath) {
  console.log(`[${id}] downloading MP3...`);
  execFileSync(
    "yt-dlp",
    [
      "--no-playlist", "-f", "bestaudio", "-x", "--audio-format", "mp3",
      "--audio-quality", "0", "--embed-metadata",
      "-o", path.join(DL_DIR, `${id}.%(ext)s`),
      `https://youtu.be/${id}`,
    ],
    { stdio: "inherit" },
  );
  if (!fs.existsSync(audioPath)) throw new Error(`MP3 not produced: ${audioPath}`);
}

function downloadVideo(id) {
  const videoPath = path.join(DL_DIR, `${id}.mp4`);
  if (fs.existsSync(videoPath)) return videoPath;
  console.log(`[${id}] downloading video (max 1080p)...`);
  execFileSync(
    "yt-dlp",
    [
      "--no-playlist",
      "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
      "--merge-output-format", "mp4",
      "-o", path.join(DL_DIR, `${id}.%(ext)s`),
      `https://youtu.be/${id}`,
    ],
    { stdio: "inherit" },
  );
  if (!fs.existsSync(videoPath)) throw new Error(`Video not produced: ${videoPath}`);
  return videoPath;
}

const HEALTH_URL = AI_URL.replace(/\/detect-segments.*$/, "/health");
const DETECT_ATTEMPTS = Number(process.env.NAAT_DETECT_ATTEMPTS || 5);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The AI container occasionally restarts mid-inference; wait until it answers again. */
function waitForHealth(timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const out = execFileSync(
        "curl",
        ["-sS", "-m", "15", "-o", "-", "-w", "\n%{http_code}", HEALTH_URL],
        { encoding: "utf-8" },
      ).trim();
      if (out.endsWith("200")) return true;
    } catch {
      // service not up yet
    }
    if (Date.now() > deadline) return false;
    console.log(`  waiting for AI service at ${HEALTH_URL} ...`);
    sleep(15000);
  }
}

function detectOnce(id, audioPath, detPath, duration) {
  console.log(`[${id}] detecting explanation (${duration.toFixed(0)}s audio)...`);
  if (fs.existsSync(detPath)) fs.unlinkSync(detPath);
  // curl with no --max-time: CPU inference runs longer than undici's default timeout.
  let httpCode = "";
  try {
    httpCode = execFileSync(
      "curl",
      ["-sS", "--max-time", "0", "-F", `audio=@${audioPath};type=audio/mpeg`, "-o", detPath, "-w", "%{http_code}", AI_URL],
      { encoding: "utf-8" },
    ).trim();
  } catch (err) {
    throw new Error(`detection request failed (${String(err.message).split("\n")[0].trim()})`);
  }
  if (httpCode !== "200") {
    let body = "";
    try {
      body = fs.readFileSync(detPath, "utf-8").slice(0, 300);
    } catch {}
    throw new Error(`AI service HTTP ${httpCode}: ${body}`);
  }
  let detection;
  try {
    detection = JSON.parse(fs.readFileSync(detPath, "utf-8"));
  } catch {
    throw new Error("AI service returned a truncated/invalid JSON body");
  }
  return detection;
}

function detect(id, audioPath, detPath, duration) {
  if (!waitForHealth()) console.error(`[${id}] AI service not healthy yet — trying anyway`);
  let lastErr;
  for (let attempt = 1; attempt <= DETECT_ATTEMPTS; attempt++) {
    try {
      const detection = detectOnce(id, audioPath, detPath, duration);
      console.log(
        `[${id}] explanation: ${detection.speechSegments?.length || 0} segment(s), ` +
          `${Number(detection.totalSpeechDuration || 0).toFixed(1)}s`,
      );
      return detection;
    } catch (err) {
      lastErr = err;
      console.error(`[${id}] detection attempt ${attempt}/${DETECT_ATTEMPTS} failed: ${err.message}`);
      if (attempt === DETECT_ATTEMPTS) break;
      sleep(10000);
      if (!waitForHealth()) break;
    }
  }
  throw lastErr;
}

async function processJob(job) {
  const id = job.id;
  fs.mkdirSync(DL_DIR, { recursive: true });
  fs.mkdirSync(CUT_DIR, { recursive: true });

  const audioPath = path.join(DL_DIR, `${id}.mp3`);
  const detPath = path.join(DL_DIR, `${id}.detect.json`);

  let title = job.title;
  let duration = Number(job.duration || 0);

  if (!VIDEOS_ONLY) {
    if (!fs.existsSync(audioPath)) downloadAudio(id, audioPath);
    const info = probeJson(audioPath, "format=duration:format_tags=title").format || {};
    title = safeName(info.tags?.title || job.title || id);
    duration = Number(info.duration || 0);
    stamp(id, "detecting", { title, duration });

    if (!fs.existsSync(detPath)) detect(id, audioPath, detPath, duration);
  }

  if (!title || !duration) {
    const det = JSON.parse(fs.readFileSync(detPath, "utf-8"));
    duration = duration || Number(det.duration || 0);
    if (!title) {
      let probed = "";
      if (fs.existsSync(audioPath)) {
        const info = probeJson(audioPath, "format_tags=title").format || {};
        probed = info.tags?.title || "";
      }
      title = safeName(job.title || probed || id);
    }
  }

  let audioOut = KEEP_AUDIO ? path.join(CUT_DIR, `${id} - ${title}.mp3`) : null;
  if (KEEP_AUDIO && !fs.existsSync(audioOut)) {
    console.log(`[${id}] cutting explanation out of audio...`);
    execFileSync(
      process.execPath,
      [path.join(__dirname, "cut-explanation.cjs"), detPath, audioPath, audioOut],
      { stdio: "inherit" },
    );
  }

  const videoIn = downloadVideo(id);
  const videoOut = path.join(CUT_DIR, `${id} - ${title}.mp4`);
  if (!fs.existsSync(videoOut)) {
    console.log(`[${id}] cutting the same segments out of the video...`);
    execFileSync(
      process.execPath,
      [path.join(__dirname, "cut-video.cjs"), detPath, videoIn, videoOut],
      { stdio: "inherit" },
    );
  }

  // Audio is only needed for detection — drop the MP3s once the video is cut.
  if (!KEEP_AUDIO) {
    for (const p of [audioPath, job.output, path.join(CUT_DIR, `${id} - ${title}.mp3`)]) {
      if (p && p.endsWith(".mp3") && fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[${id}] removed ${path.basename(p)}`);
      }
    }
  }

  // Free the disk: the downloaded source video is no longer needed once cut.
  if (!KEEP_VIDEO && videoIn !== videoOut && fs.existsSync(videoIn)) {
    fs.unlinkSync(videoIn);
    console.log(`[${id}] removed ${path.basename(videoIn)}`);
  }

  // The original YouTube thumbnail (best size available) goes with the upload.
  const thumbPath = ensureThumbnail(id, DL_DIR);
  console.log(
    thumbPath
      ? `[${id}] thumbnail -> ${path.basename(thumbPath)}`
      : `[${id}] no thumbnail available — will upload without one`,
  );

  const detection = JSON.parse(fs.readFileSync(detPath, "utf-8"));
  stamp(id, "done", {
    title,
    duration,
    detPath,
    output: KEEP_AUDIO ? audioOut : undefined,
    videoOutput: videoOut,
    thumbPath: thumbPath || undefined,
    removedSeconds: Number(detection.totalSpeechDuration || 0).toFixed(1),
    keptSeconds: Number(detection.totalSingingDuration || 0).toFixed(1),
    segments: detection.speechSegments || [],
  });
  console.log(`[${id}] done`);
  console.log(`  video -> ${videoOut}`);

  // Upload last: the video stays on disk either way, so a failed upload can be
  // retried (next queue run picks up done jobs that have no youtubeUrl yet).
  if (UPLOAD) {
    try {
      const url = uploadJob(id);
      if (url) postUploadSteps(id);
    } catch (err) {
      console.error(`[${id}] upload failed: ${err.message}`);
      console.error(`[${id}] video kept — will retry on the next queue run`);
      stamp(id, "done", { uploadError: err.message });
    }
  }
}

/** Upload one finished job via the wrapper (metadata, thumbnail, comment, receipt). */
function uploadJob(id) {
  // Re-read the queue: a longer-running processor can hold stale job data while
  // another run (or a manual adoption) records the upload in the meantime.
  const already = load().jobs.find((j) => j.id === id)?.youtubeUrl;
  if (already) {
    console.log(`[${id}] already uploaded: ${already}`);
    return already;
  }

  console.log(`[${id}] uploading to YouTube...`);
  const script = path.join(__dirname, "upload-queue-video.cjs");
  const receiptPath = path.join(ROOT, "yt", "queue-uploads", `${id}.meta-result.json`);
  const started = Date.now();

  /** A receipt means the video already exists online — never upload it twice. */
  function adoptReceipt() {
    try {
      if (fs.statSync(receiptPath).mtimeMs < started - 5000) return null;
      const r = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
      if (!r.url) return null;
      const fresh = load();
      const job = fresh.jobs.find((j) => j.id === id);
      if (job) {
        Object.assign(job, {
          youtubeUrl: r.url,
          youtubeVideoId: r.videoId,
          youtubeChannel: r.channel,
          uploadedAt: r.at,
          uploadReceipt: receiptPath,
          thumbnailSet: Boolean(r.thumbnail),
          updatedAt: new Date().toISOString(),
        });
        delete job.uploadError;
        save(fresh);
        recordUpload(id);
      }
      console.warn(`[${id}] upload did complete (${r.url}) — recorded it instead of retrying`);
      return r.url;
    } catch {
      return null;
    }
  }

  let lastErr;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      execFileSync(process.execPath, [script, id], { stdio: "inherit", cwd: ROOT });
      const saved = load().jobs.find((j) => j.id === id);
      if (saved?.youtubeUrl) {
        console.log(`[${id}] uploaded -> ${saved.youtubeUrl}`);
        return saved.youtubeUrl;
      }
      lastErr = new Error("uploader finished without a YouTube URL");
    } catch (err) {
      const adopted = adoptReceipt();
      if (adopted) return adopted;
      if (err.status === 3) {
        // Daily cap — a deferral, not a failure. Leave the job queued for tomorrow.
        console.warn(`[${id}] daily upload limit reached — leaving it for the next day`);
        return null;
      }
      lastErr = new Error(String(err.message).split("\n")[0].trim());
    }
    console.error(`[${id}] upload attempt ${attempt}/${UPLOAD_ATTEMPTS}: ${lastErr.message}`);
    if (attempt < UPLOAD_ATTEMPTS) sleep(30000);
  }
  throw lastErr;
}

/** Comment on the source naat video, linking the upload we just made. */
function commentSourceJob(id) {
  if (!SOURCE_COMMENT) return;
  console.log(`[${id}] commenting on the original video...`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, "comment-source-video.cjs"), id], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (err) {
    // The wrapper records sourceCommentStatus/Error itself; the upload is fine.
    console.error(`[${id}] source comment failed: ${String(err.message).split("\n")[0].trim()}`);
  }
}

/**
 * Build the teenage-voice deliverable: audio is taken from the already-cut
 * video (so the explanation is gone), pitch-shifted +6 semitones, then married
 * to the "TEENAGE VOICE" band artwork as a still-image MP4.
 */
function ensureTeenVideo(id) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job?.videoOutput || !fs.existsSync(job.videoOutput)) {
    throw new Error("cut video is missing — cannot build the teenage version");
  }

  const teenVideo = path.join(CUT_DIR, `${job.id} - ${job.title} [teenage voice].mp4`);
  let teenThumb =
    job.teenThumbPath && fs.existsSync(job.teenThumbPath) ? job.teenThumbPath : null;
  if (!teenThumb) teenThumb = ensureTeenThumbnail(id, DL_DIR);
  if (!teenThumb) throw new Error("no artwork available for the teenage video");

  if (!fs.existsSync(teenVideo)) {
    const extracted = path.join(DL_DIR, `${id}.m4a`);
    const shifted = path.join(DL_DIR, `${id}-teen.m4a`);
    try {
      console.log(`[${id}] extracting the cut audio...`);
      extractAudio(job.videoOutput, extracted);
      console.log(`[${id}] teenage voice (+${SEMITONES} semitones)...`);
      pitchShift(extracted, shifted, SEMITONES);
      console.log(`[${id}] building the still-image video...`);
      buildStillVideo(shifted, teenThumb, teenVideo);
    } finally {
      // The audio only exists to make the mp4 — drop it either way.
      for (const p of [extracted, shifted]) {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }
  }

  stamp(id, "done", {
    teenVideoOutput: teenVideo,
    teenThumbPath: teenThumb,
    teenSemitones: SEMITONES,
  });
  console.log(`[${id}] teenage video -> ${teenVideo}`);
  return teenVideo;
}

/** Upload the teenage-voice video to the teenage channel (no source comment). */
function teenUploadJob(id) {
  if (!UPLOAD || !TEEN) return null;
  if (remainingToday("teenage") <= 0) return null;

  ensureTeenVideo(id);
  console.log(`[${id}] uploading the teenage-voice version...`);
  const script = path.join(__dirname, "upload-queue-video.cjs");

  let lastErr;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      execFileSync(process.execPath, [script, id, "--channel", "teenage"], {
        stdio: "inherit",
        cwd: ROOT,
      });
      const saved = load().jobs.find((j) => j.id === id);
      if (saved?.teenYoutubeUrl) {
        console.log(`[${id}] teenage uploaded -> ${saved.teenYoutubeUrl}`);
        return saved.teenYoutubeUrl;
      }
      lastErr = new Error("teenage uploader finished without a YouTube URL");
    } catch (err) {
      if (err.status === 3) {
        console.warn(`[${id}] daily teenage upload limit reached — deferred`);
        return null;
      }
      lastErr = new Error(String(err.message).split("\n")[0].trim());
    }
    console.error(`[${id}] teenage upload attempt ${attempt}/${UPLOAD_ATTEMPTS}: ${lastErr.message}`);
    if (attempt < UPLOAD_ATTEMPTS) sleep(30000);
  }
  throw lastErr;
}

/**
 * Everything that happens after a main-channel upload: the source comment and
 * the teenage-voice upload. The teenage upload deliberately never comments on
 * the source video.
 */
function postUploadSteps(id) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job?.youtubeUrl) return;

  const commentDone =
    job.sourceCommentStatus === "commented" || job.sourceCommentStatus === "skipped";
  if (SOURCE_COMMENT && !commentDone) commentSourceJob(id);

  if (!TEEN || job.teenYoutubeUrl) return;
  if (!UPLOAD) return;
  if (remainingToday("teenage") <= 0) {
    console.log(`[${id}] teenage upload deferred — daily limit (${DAILY_LIMITS.teenage}/day)`);
    return;
  }

  try {
    teenUploadJob(id);
  } catch (err) {
    console.error(`[${id}] teenage upload failed: ${err.message}`);
    console.error(`[${id}] teenage video kept — will retry on the next queue run`);
    stamp(id, "done", { teenUploadError: err.message });
  }
}

/** A job is only uploadable while its cut video still exists and the day's budget allows. */
function uploadPending(data, skip) {
  if (!UPLOAD || remainingToday("main") <= 0) return undefined;
  return data.jobs.find(
    (job) =>
      job.status === "done" &&
      !job.youtubeUrl &&
      !skip.has(job.id) &&
      job.videoOutput &&
      fs.existsSync(job.videoOutput),
  );
}

/** Uploaded jobs whose source comment is still owed (failed, deferred or crashed). */
function sourceCommentPending(data, skip) {
  if (!SOURCE_COMMENT) return undefined;
  const DONE = new Set(["commented", "skipped"]);
  return data.jobs.find(
    (job) =>
      job.status === "done" &&
      job.youtubeUrl &&
      !DONE.has(job.sourceCommentStatus) &&
      !skip.has(job.id),
  );
}

/** Uploaded jobs whose teenage-voice version is still owed. */
function teenUploadPending(data, skip) {
  if (!UPLOAD || !TEEN || remainingToday("teenage") <= 0) return undefined;
  return data.jobs.find(
    (job) =>
      job.status === "done" &&
      job.youtubeUrl &&
      !job.teenYoutubeUrl &&
      !skip.has(job.id),
  );
}

function nextJob(data, skip = new Set()) {
  // Finished-but-not-uploaded jobs go first: they are quick and the file is done.
  const pendingUpload = uploadPending(data, skip);
  if (pendingUpload) return pendingUpload;

  const pendingComment = sourceCommentPending(data, skip);
  if (pendingComment) return pendingComment;

  const pendingTeen = teenUploadPending(data, skip);
  if (pendingTeen) return pendingTeen;

  if (VIDEOS_ONLY) {
    const j = data.jobs.find((job) => {
      const det = path.join(DL_DIR, `${job.id}.detect.json`);
      const out = job.title ? path.join(CUT_DIR, `${job.id} - ${job.title}.mp4`) : null;
      return !skip.has(job.id) && fs.existsSync(det) && (!out || !fs.existsSync(out));
    });
    if (j) j.status = "video-pending";
    return j;
  }
  // "detecting" / "video-pending" are resumable: the previous run was killed or
  // the AI service restarted, so the job never reached "done".
  const RESUMABLE = new Set(["pending", "detecting", "video-pending"]);
  return data.jobs.find((j) => RESUMABLE.has(j.status) && !skip.has(j.id));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Returns false when another processor (e.g. the logon task) already holds the lock. */
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    const pid = Number(fs.readFileSync(LOCK_PATH, "utf-8").trim());
    if (pid && pid !== process.pid && pidAlive(pid)) return false;
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_PATH) && fs.readFileSync(LOCK_PATH, "utf-8").trim() === String(process.pid)) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {}
}

(async () => {
  const one = process.argv.includes("--one");
  const attempted = new Set();

  if (!acquireLock()) {
    console.log("Queue processor already running — nothing to do.");
    return;
  }
  const cleanup = () => releaseLock();
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.on(sig, () => {
      releaseLock();
      process.exit(1);
    });
  }

  let data = load();
  try {
    for (;;) {
      const job = nextJob(data, attempted);
      if (!job) break;

      // A cut is pointless if today's main-channel upload slots are gone — it
      // would only sit on disk. Stop; the job stays pending for the next day.
      const needsUpload = job.status !== "done" || !job.youtubeUrl;
      if (UPLOAD && needsUpload && remainingToday("main") <= 0) {
        console.log(
          `Daily main upload limit reached (${DAILY_LIMITS.main}/day) — stopping, ${job.id} stays queued.`,
        );
        break;
      }

      attempted.add(job.id);
      try {
        if (job.status === "done") {
          // Cut already exists — the main upload, source comment or teenage
          // version is still missing.
          if (!job.youtubeUrl) {
            const url = uploadJob(job.id);
            if (url) postUploadSteps(job.id);
          } else {
            postUploadSteps(job.id);
          }
        } else {
          await processJob(job);
        }
      } catch (err) {
        console.error(`[${job.id}] FAILED: ${err.message}`);
        if (job.status === "done") {
          // State-based retries (missing upload/comment/teen) drive the next run.
          stamp(job.id, "done", { pipelineError: err.message });
        } else {
          stamp(job.id, "failed", { error: err.message });
        }
      }
      if (one) break;
      data = load();
    }
  } finally {
    releaseLock();
  }
  console.log("Queue drained.");
})().catch((e) => {
  console.error("Queue processor error:", e);
  releaseLock();
  process.exit(1);
});
