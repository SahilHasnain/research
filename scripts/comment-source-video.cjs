#!/usr/bin/env node
/**
 * Comment on the ORIGINAL naat video with a link to our "no explanation" cut.
 *
 * The comment text is built per job (quotes the naat title, rotates phrasings)
 * by scripts/lib/source-comment.cjs, and a daily budget keeps the channel from
 * looking like a link-dropping bot (queue/source-comments.json).
 *
 * Usage:
 *   node scripts/comment-source-video.cjs <id> [--dry-run] [--force]
 *
 * Status written back into queue/jobs.json:
 *   commented  -> sourceCommentId / sourceCommentUrl / sourceCommentedAt
 *   skipped    -> sourceCommentSkipReason (own video, comments off, already commented)
 *   pending    -> sourceCommentError (network/quota — retried on a later run)
 *
 * --dry-run prints the exact comment and posts nothing.
 * --force ignores the daily budget and the "already commented" state.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildSourceComment, pickTemplate, remainingToday, recordComment, DAILY_LIMIT } = require("./lib/source-comment.cjs");

const ROOT = path.join(__dirname, "..");
const QUEUE_PATH = path.join(ROOT, "queue", "jobs.json");
const COMMENT_DIR = path.join(ROOT, "yt", "queue-comments");
const COMMENTER = path.join(ROOT, "yt", "comment-external.cjs");
const NAAT_MODULES = "D:/Projects/naat-collection/node_modules";

const has = (name) => process.argv.includes(name);
const jobId = process.argv[2];
const DRY_RUN = has("--dry-run");
const FORCE = has("--force");

if (!jobId) {
  console.error("Usage: comment-source-video.cjs <id> [--dry-run] [--force]");
  process.exit(1);
}

function load() {
  return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
}
function save(data) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2));
}
function stamp(id, extra) {
  const data = load();
  const job = data.jobs.find((j) => j.id === id);
  if (job) Object.assign(job, extra, { updatedAt: new Date().toISOString() });
  save(data);
}

const data = load();
const job = data.jobs.find((j) => j.id === jobId);
if (!job) throw new Error(`No job ${jobId} in queue/jobs.json`);
if (!job.youtubeUrl && !DRY_RUN) throw new Error(`${jobId} has not been uploaded yet — nothing to link to`);
if (job.sourceCommentStatus === "commented" && !FORCE) {
  console.log(`${job.id} already commented: ${job.sourceCommentUrl}`);
  console.log("Use --force to comment again.");
  process.exit(0);
}

const link = job.youtubeUrl || "https://youtu.be/<upload-pending>";
const templateIndex = pickTemplate(job);
const text = buildSourceComment(job, link);
console.log(`[${job.id}] source comment for "${job.title}"`);
console.log(`  link : ${link}`);
console.log(`  text : ${text}`);
console.log(`  budget: ${remainingToday()}/${DAILY_LIMIT} comments left today`);

if (DRY_RUN) {
  console.log(`[${job.id}] dry run — nothing posted`);
  process.exit(0);
}

if (remainingToday() <= 0 && !FORCE) {
  stamp(job.id, {
    sourceCommentStatus: "pending",
    sourceCommentNote: `daily cap reached (${DAILY_LIMIT}/day) — retries on a later run`,
  });
  console.log(`[${job.id}] daily comment budget used up — deferred`);
  process.exit(0);
}

fs.mkdirSync(COMMENT_DIR, { recursive: true });
const receiptPath = path.join(COMMENT_DIR, `${job.id}-result.json`);
if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);

const env = {
  ...process.env,
  NODE_PATH: [process.env.NODE_PATH, NAAT_MODULES].filter(Boolean).join(path.delimiter),
};

const run = spawnSync(
  process.execPath,
  [COMMENTER, "--video", job.id, "--text", text, "--channel", "main", "--receipt", receiptPath, "--confirm"],
  { stdio: "inherit", env, cwd: ROOT, timeout: 5 * 60 * 1000 },
);

let receipt = null;
try {
  receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
} catch {}

if (receipt?.status === "commented") {
  const left = recordComment(templateIndex);
  stamp(job.id, {
    sourceCommentStatus: "commented",
    sourceCommentId: receipt.commentId,
    sourceCommentUrl: receipt.url,
    sourceCommentedAt: receipt.at,
    sourceCommentReceipt: receiptPath,
    sourceCommentError: undefined,
    sourceCommentSkipReason: undefined,
    sourceCommentNote: undefined,
  });
  console.log(`[${job.id}] comment posted -> ${receipt.url} (${left} left today)`);
  process.exit(0);
}

if (receipt?.status === "skipped" || run.status === 2) {
  const reason = receipt?.reason || "not allowed to comment";
  stamp(job.id, {
    sourceCommentStatus: "skipped",
    sourceCommentSkipReason: reason,
    sourceCommentNote: undefined,
  });
  console.log(`[${job.id}] comment skipped: ${reason}`);
  process.exit(0);
}

const error =
  run.error?.message ||
  `commenter exited with ${run.status === null ? `signal ${run.signal}` : `code ${run.status}`}`;
stamp(job.id, {
  sourceCommentStatus: "pending",
  sourceCommentError: error,
  sourceCommentNote: undefined,
});
console.error(`[${job.id}] comment failed: ${error} — will retry on a later run`);
process.exit(1);
