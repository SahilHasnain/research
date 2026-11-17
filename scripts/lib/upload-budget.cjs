/**
 * Daily upload budget, per channel.
 *
 *   main     -> 3/day  (NAAT_UPLOADS_PER_DAY)
 *   teenage  -> 3/day  (NAAT_TEEN_UPLOADS_PER_DAY)
 *
 * Separate budgets so a teenage upload can never eat a main-channel slot.
 * Kept separate from YouTube's own quota (which allows ~6 videos/day) so a
 * backlog drains at a steady, human-looking pace. The day rolls over at local
 * midnight.
 *
 *   queue/uploads.json
 *   { "days": { "2026-11-17": { "main": ["srfRvUhtm2g"], "teenage": [] } } }
 *
 * Recording by video id makes it idempotent: adopting an upload receipt or
 * re-running the wrapper can never consume two slots for one video.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const BUDGET_PATH = path.join(ROOT, "queue", "uploads.json");

const LIMITS = {
  main: Number(process.env.NAAT_UPLOADS_PER_DAY || 3),
  teenage: Number(process.env.NAAT_TEEN_UPLOADS_PER_DAY || 3),
};

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(BUDGET_PATH, "utf-8"));
    if (raw && typeof raw.days === "object" && raw.days !== null) return { days: raw.days };
  } catch {
    // no file yet
  }
  return { days: {} };
}

/** The day's entry can be an array (older single-channel file) or an object. */
function dayEntry(channel, data = read()) {
  const entry = data.days[today()];
  if (!entry) return [];
  if (Array.isArray(entry)) return channel === "main" ? entry : [];
  return entry[channel] || [];
}

function uploadedToday(channel = "main") {
  return dayEntry(channel);
}

function remainingToday(channel = "main") {
  return Math.max(0, (LIMITS[channel] || 0) - dayEntry(channel).length);
}

/** Call only after YouTube really accepted the video. Returns the day's totals. */
function recordUpload(id, channel = "main") {
  if (!LIMITS[channel]) throw new Error(`Unknown upload channel "${channel}"`);
  const data = read();
  const day = today();
  const entry = data.days[day];
  const dayMap = Array.isArray(entry) ? { main: entry } : { ...(entry || {}) };
  const ids = dayMap[channel] || [];
  if (!ids.includes(id)) ids.push(id);
  dayMap[channel] = ids;
  data.days[day] = dayMap;

  // keep the last 30 days only
  const keep = Object.keys(data.days).sort().slice(-30);
  const days = {};
  for (const d of keep) days[d] = data.days[d];

  fs.mkdirSync(path.dirname(BUDGET_PATH), { recursive: true });
  fs.writeFileSync(BUDGET_PATH, JSON.stringify({ days }, null, 2));
  return {
    channel,
    count: ids.length,
    limit: LIMITS[channel],
    remaining: Math.max(0, LIMITS[channel] - ids.length),
  };
}

module.exports = {
  recordUpload,
  remainingToday,
  uploadedToday,
  DAILY_LIMITS: LIMITS,
  DAILY_LIMIT: LIMITS.main,
};
