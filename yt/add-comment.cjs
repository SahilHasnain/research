#!/usr/bin/env node
/**
 * Add the standard Play Store comment to an uploaded video.
 *
 * Usage:
 *   node yt/add-comment.cjs --video <id> --channel main|teenage
 */
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");

const ENV_PATH = "D:/Projects/naat-collection/.env.naat-collection";
const CHANNELS = {
  main: {
    token: "GOOGLE_REFRESH_TOKEN",
    text: (app, url) =>
      `📲 Download the ${app} app: ${url}\n\nExperience pure naats without explanations, offline playback, and more!`,
  },
  teenage: {
    token: "GOOGLE_REFRESH_TOKEN_TEENAGE",
    text: (app, url) => `📲 Download the ${app} app: ${url}`,
  },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

dotenv.config({ path: ENV_PATH });

const videoId = arg("--video");
const key = arg("--channel", "main");
if (!videoId) throw new Error("Missing --video <id>");
if (!CHANNELS[key]) throw new Error(`Unknown --channel "${key}" (use main|teenage)`);

const channel = CHANNELS[key];
const appName = process.env.APP_NAME || "Owais Raza Qadri";
const playStoreUrl = process.env.PLAY_STORE_URL || "";

async function main() {
  if (!playStoreUrl) throw new Error("PLAY_STORE_URL is not set");

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "urn:ietf:wg:oauth:2.0:oob",
  );
  auth.setCredentials({ refresh_token: process.env[channel.token] });

  const youtube = google.youtube({ version: "v3", auth });

  // Fail fast if the video is not on the token's own channel.
  const mine = await youtube.channels.list({ part: ["id"], mine: true });
  const channelId = mine.data.items?.[0]?.id;
  const vids = await youtube.videos.list({ part: ["snippet"], id: [videoId] });
  const video = vids.data.items?.[0];
  if (!video) throw new Error(`Video ${videoId} not found`);
  if (video.snippet.channelId !== channelId) {
    throw new Error(`Video ${videoId} belongs to ${video.snippet.channelId}, not ${channelId}`);
  }
  console.log(`Video  : ${video.snippet.title}`);
  console.log(`Channel: ${video.snippet.channelTitle}  [${key}]`);

  const res = await youtube.commentThreads.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        videoId,
        topLevelComment: {
          snippet: { textOriginal: channel.text(appName, playStoreUrl) },
        },
      },
    },
  });
  console.log(`Comment added: ${res.data.id}`);
  console.log("Note: API cannot pin — pin it manually in YouTube Studio if desired.");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
