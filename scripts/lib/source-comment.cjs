/**
 * Text + budget for the comment we leave on the ORIGINAL naat video, pointing
 * at our "no explanation" cut.
 *
 * Why this is more than a string: YouTube treats repeated comments with links
 * as spam. So every comment
 *   - quotes the naat's own title (makes each one unique),
 *   - rotates through several phrasings (no two consecutive postings match),
 *   - contains exactly one link, no hashtags/emojis/calls to subscribe,
 * and the channel only leaves a few of them per day (queue/source-comments.json).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const COUNTER_PATH = path.join(ROOT, "queue", "source-comments.json");
const DAILY_LIMIT = Number(process.env.NAAT_SOURCE_COMMENTS_PER_DAY || 3);

const TEMPLATES = [
  (title, url) =>
    `Assalamu alaikum. I removed the explanation part from "${title}" and kept only the naat — sharing in case someone wants to listen without the talk in between: ${url}`,
  (title, url) =>
    `I made a version of this naat with just the naat and no explanation — "${title}": ${url}`,
  (title, url) =>
    `For anyone who wants "${title}" without the explanation in between, I made a clean cut here: ${url}`,
  (title, url) =>
    `Beautiful naat. I edited the explanation out of "${title}" — pure naat version: ${url}`,
];

function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function displayTitle(job) {
  return String(job.title || job.id)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(4K|8K|HD)\s+/i, "")
    .slice(0, 90);
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readCounter() {
  try {
    const raw = JSON.parse(fs.readFileSync(COUNTER_PATH, "utf-8"));
    // Current format: { days: { "2026-11-17": 2 }, lastTemplate: 1 }
    if (raw && typeof raw.days === "object" && raw.days !== null) {
      return { days: raw.days, lastTemplate: Number.isInteger(raw.lastTemplate) ? raw.lastTemplate : null };
    }
    // Tolerate the earlier flat { "2026-11-17": 2 } shape.
    return { days: raw || {}, lastTemplate: null };
  } catch {
    return { days: {}, lastTemplate: null };
  }
}

function remainingToday() {
  const counter = readCounter();
  return Math.max(0, DAILY_LIMIT - Number(counter.days[today()] || 0));
}

/**
 * Template for this video: stable per id, but advanced by one when it would
 * repeat the phrasing used for the previous comment.
 */
function pickTemplate(job) {
  const count = TEMPLATES.length;
  let index = hash(job.id) % count;
  const { lastTemplate } = readCounter();
  if (lastTemplate !== null && lastTemplate === index && count > 1) index = (index + 1) % count;
  return index;
}

function buildSourceComment(job, url) {
  return TEMPLATES[pickTemplate(job)](displayTitle(job), url);
}

/** Call only after a comment was really created. Returns the new remaining count. */
function recordComment(templateIndex = null) {
  const counter = readCounter();
  const day = today();
  counter.days[day] = Number(counter.days[day] || 0) + 1;
  if (Number.isInteger(templateIndex)) counter.lastTemplate = templateIndex;

  const keep = Object.keys(counter.days).sort().slice(-30);
  const days = {};
  for (const d of keep) days[d] = counter.days[d];

  fs.mkdirSync(path.dirname(COUNTER_PATH), { recursive: true });
  fs.writeFileSync(COUNTER_PATH, JSON.stringify({ days, lastTemplate: counter.lastTemplate }, null, 2));
  return Math.max(0, DAILY_LIMIT - counter.days[day]);
}

module.exports = { buildSourceComment, pickTemplate, remainingToday, recordComment, DAILY_LIMIT };
