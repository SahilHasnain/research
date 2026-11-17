#!/usr/bin/env node
/**
 * Leave a comment on a video that belongs to ANOTHER channel (the original naat),
 * pointing at our "no explanation" cut.
 *
 * yt/add-comment.cjs deliberately refuses this (it only comments on our own
 * uploads), so this script is separate on purpose. The guards that keep the
 * comment from looking like spam live here and in scripts/lib/source-comment.cjs:
 *
 *   - never comments on our own videos
 *   - skips if our channel already has a top-level comment on that video
 *   - one comment per run, text supplied by the caller (unique per video)
 *   - exits 2 (not 1) for "not allowed", so the queue can mark it skipped
 *
 * Usage:
 *   node yt/comment-external.cjs --video <sourceId> --text "<comment>" \
 *        [--channel main] [--receipt <file>] [--confirm]
 *
 * Without --confirm it is a dry run: the video is checked, nothing is posted.
 *
 * Exit codes: 0 commented (or dry run), 2 skipped, 1 error.
 */
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");

const ENV_PATH = "D:/Projects/naat-collection/.env.naat-collection";
const CHANNELS = { main: "GOOGLE_REFRESH_TOKEN", teenage: "GOOGLE_REFRESH_TOKEN_TEENAGE" };
const MAX_TEXT = 10000;
const MAX_PAGES = 5;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function reasonOf(err) {
  const e = err?.response?.data?.error || err?.errors?.[0] || err;
  return String(e?.errors?.[0]?.reason || e?.reason || e?.status || err?.message || err);
}

dotenv.config({ path: ENV_PATH });

const videoId = arg("--video");
const text = arg("--text");
const key = arg("--channel", "main");
const receiptPath = arg("--receipt");
const CONFIRM = process.argv.includes("--confirm");

const tokenName = CHANNELS[key];
if (!videoId) throw new Error("Missing --video <id>");
if (!tokenName) throw new Error(`Unknown --channel "${key}" (use main|teenage)`);
if (!text) throw new Error("Missing --text \"<comment>\"");
if (text.length > MAX_TEXT) throw new Error(`Comment is ${text.length} chars, YouTube's limit is ${MAX_TEXT}`);
if (!CONFIRM) console.log("DRY RUN — the comment will not be posted.");

/** Write the outcome next to the queue so a crash cannot cause a second comment. */
function writeReceipt(result) {
  if (!receiptPath) return;
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({ ...result, videoId, channel: key, text, at: new Date().toISOString() }, null, 2),
  );
}

function done(result, code) {
  writeReceipt(result);
  if (result.reason) console.log(`Skipped: ${result.reason}`);
  if (result.url) console.log(`Comment: ${result.url}`);
  process.exit(code);
}

async function main() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "urn:ietf:wg:oauth:2.0:oob",
  );
  auth.setCredentials({ refresh_token: process.env[tokenName] });
  const youtube = google.youtube({ version: "v3", auth });

  const mine = await youtube.channels.list({ part: ["id"], mine: true });
  const channelId = mine.data.items?.[0]?.id;
  if (!channelId) throw new Error("Could not read the authenticated channel");

  const vids = await youtube.videos.list({ part: ["snippet"], id: [videoId] });
  const video = vids.data.items?.[0];
  if (!video) {
    done({ status: "skipped", reason: `videoNotFound: ${videoId}` }, 2);
    return;
  }

  console.log(`Video  : ${video.snippet.title}`);
  console.log(`Channel: ${video.snippet.channelTitle} (${video.snippet.channelId})`);

  if (video.snippet.channelId === channelId) {
    done({ status: "skipped", reason: "ownVideo — never comment on our own upload" }, 2);
    return;
  }

  // Already commented there? commentThreads.list has no `mine` filter, so walk
  // the top-level threads (a few pages is plenty for these small channels).
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    let threads;
    try {
      threads = await youtube.commentThreads.list({
        part: ["snippet"],
        videoId,
        maxResults: 100,
        textFormat: "plainText",
        pageToken,
      });
    } catch (err) {
      const reason = reasonOf(err);
      if (/commentsDisabled/i.test(reason)) {
        done({ status: "skipped", reason: "commentsDisabled" }, 2);
        return;
      }
      throw err;
    }
    const hit = (threads.data.items || []).find(
      (t) => t.snippet?.topLevelComment?.snippet?.authorChannelId?.value === channelId,
    );
    if (hit) {
      done(
        {
          status: "skipped",
          reason: "alreadyCommented — our channel already has a top-level comment here",
          commentId: hit.id,
        },
        2,
      );
      return;
    }
    pageToken = threads.data.nextPageToken;
    if (!pageToken) break;
  }

  if (!CONFIRM) {
    console.log("\nComment text:\n");
    console.log(text);
    done({ status: "dry-run", reason: null }, 0);
    return;
  }

  console.log("\nPosting comment...");
  let res;
  try {
    res = await youtube.commentThreads.insert({
      part: ["snippet"],
      requestBody: {
        snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } },
      },
    });
  } catch (err) {
    const reason = reasonOf(err);
    if (/commentsDisabled/i.test(reason)) {
      done({ status: "skipped", reason: "commentsDisabled" }, 2);
      return;
    }
    throw new Error(`${reason}: ${err.message.split("\n")[0]}`);
  }

  const id = res.data?.id;
  if (!id) throw new Error("commentThreads.insert returned no comment id");
  console.log(`Comment added: ${id}`);
  console.log(`https://www.youtube.com/watch?v=${videoId}&lc=${id}`);
  done(
    {
      status: "commented",
      commentId: id,
      url: `https://www.youtube.com/watch?v=${videoId}&lc=${id}`,
      reason: null,
    },
    0,
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
