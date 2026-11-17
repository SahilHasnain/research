#!/usr/bin/env node
/**
 * Simple job queue for the naat clip pipeline.
 *
 * Usage:
 *   node scripts/queue.cjs add <youtube-url>
 *   node scripts/queue.cjs list
 *   node scripts/queue.cjs set <id> <status> [extra json]
 */
const fs = require("fs");
const path = require("path");

const QUEUE_PATH = path.join(__dirname, "..", "queue", "jobs.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
  } catch {
    return { jobs: [] };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2));
}

function videoIdFromUrl(url) {
  const m = url.match(/(?:youtu\.be\/|v=)([\w-]{11})/);
  if (!m) throw new Error(`Cannot parse YouTube id from: ${url}`);
  return m[1];
}

function truncate(s, n = 70) {
  const text = String(s || "").replace(/\s+/g, " ");
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

const [cmd, ...rest] = process.argv.slice(2);
const data = load();

if (cmd === "add") {
  const url = rest[0];
  if (!url) throw new Error("Usage: queue.cjs add <url>");
  const id = videoIdFromUrl(url);
  if (data.jobs.some((j) => j.id === id)) {
    console.log(`Already queued: ${id} (${data.jobs.find((j) => j.id === id).status})`);
    process.exit(0);
  }
  data.jobs.push({
    id,
    url,
    status: "pending",
    addedAt: new Date().toISOString(),
  });
  save(data);
  console.log(`Queued ${id} — ${data.jobs.length} job(s) total`);
} else if (cmd === "list") {
  for (const j of data.jobs) {
    const where = j.youtubeUrl || j.videoOutput || j.output || "";
    const note = j.uploadError
      ? `  [upload pending: ${truncate(j.uploadError)}]`
      : j.error
        ? `  [error: ${truncate(j.error)}]`
        : j.pipelineError
          ? `  [error: ${truncate(j.pipelineError)}]`
          : "";
    const comment =
      j.sourceCommentStatus === "commented"
        ? "  [commented]"
        : j.sourceCommentStatus === "skipped"
          ? `  [comment skipped: ${truncate(j.sourceCommentSkipReason)}]`
          : j.sourceCommentStatus === "pending"
            ? `  [comment pending: ${truncate(j.sourceCommentError || j.sourceCommentNote || "queued")}]`
            : "";
    const teen = j.teenYoutubeUrl
      ? `  [teen: ${j.teenYoutubeUrl}]`
      : j.teenUploadError
        ? `  [teen pending: ${truncate(j.teenUploadError)}]`
        : j.teenVideoOutput
          ? "  [teen: video ready]"
          : "";
    console.log(`${j.id}  ${j.status.padEnd(10)}  ${where}${note}${comment}${teen}  ${j.addedAt}`);
  }
  const { remainingToday: uploadsLeft, DAILY_LIMITS } = require("./lib/upload-budget.cjs");
  const { remainingToday: commentsLeft, DAILY_LIMIT: commentCap } = require("./lib/source-comment.cjs");
  console.log(
    `\nuploads today: main ${DAILY_LIMITS.main - uploadsLeft("main")}/${DAILY_LIMITS.main}` +
      `, teenage ${DAILY_LIMITS.teenage - uploadsLeft("teenage")}/${DAILY_LIMITS.teenage}` +
      `   source comments today: ${commentCap - commentsLeft()}/${commentCap}`,
  );
} else if (cmd === "set") {
  const [id, status, json] = rest;
  const job = data.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`No job ${id}`);
  job.status = status;
  job.updatedAt = new Date().toISOString();
  if (status !== "failed") delete job.error;
  if (json) Object.assign(job, JSON.parse(json));
  save(data);
  console.log(`${id} -> ${status}`);
} else {
  console.log("Usage: queue.cjs add <url> | list | set <id> <status> [json]");
}
