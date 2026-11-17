#!/usr/bin/env node
/**
 * Upload a single video to a naat YouTube channel.
 * Auth tokens come from D:\Projects\naat-collection\.env.naat-collection
 *
 * Usage:
 *   node yt/upload-video.cjs [--meta <file>] [--channel main|teenage] [--confirm]
 *
 * Defaults: --meta yt/upload-metadata.json --channel main  (dry run unless --confirm)
 */
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");

const ENV_PATH = "D:/Projects/naat-collection/.env.naat-collection";
const CHANNELS = {
  main: {
    token: "GOOGLE_REFRESH_TOKEN",
    label: "No Explanation",
    comment: (app, url) =>
      `📲 Download the ${app} app: ${url}\n\nExperience pure naats without explanations, offline playback, and more!`,
  },
  teenage: {
    token: "GOOGLE_REFRESH_TOKEN_TEENAGE",
    label: "Teenage Voice",
    comment: (app, url) => `📲 Download the ${app} app: ${url}`,
  },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const META_PATH = path.resolve(arg("--meta", path.join(__dirname, "upload-metadata.json")));
const CHANNEL_KEY = arg("--channel", "main");
const CONFIRM = process.argv.includes("--confirm");
const RESULT_PATH = META_PATH.replace(/\.json$/, "-result.json");

dotenv.config({ path: ENV_PATH });

if (!CHANNELS[CHANNEL_KEY]) throw new Error(`Unknown --channel "${CHANNEL_KEY}" (use main|teenage)`);
const CHANNEL = CHANNELS[CHANNEL_KEY];
const meta = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));

function getAuth() {
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", CHANNEL.token];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "urn:ietf:wg:oauth:2.0:oob",
  );
  auth.setCredentials({ refresh_token: process.env[CHANNEL.token] });
  return auth;
}

function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* ------------------------------------------------------------------ *
 * Resumable upload
 *
 * googleapis always sends create+media as one multipart request, which a
 * 500 MB video cannot survive on a flaky link (ECONNRESET = the whole
 * upload is lost). The resumable protocol lets us continue where the
 * server stopped: 16 MB chunks, offset recovered after every error.
 * ------------------------------------------------------------------ */
const CHUNK_SIZE = 16 * 1024 * 1024;
const TRANSFER_ATTEMPTS = 6;

async function accessToken(auth) {
  const res = await auth.getAccessToken();
  return typeof res === "string" ? res : res.token;
}

async function startResumableSession(token, meta, size) {
  const mime = meta.videoPath.toLowerCase().endsWith(".mp4") ? "video/mp4" : "application/octet-stream";
  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime,
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({
        snippet: {
          title: meta.title,
          description: meta.description,
          tags: meta.tags,
          categoryId: meta.categoryId,
          defaultLanguage: meta.defaultLanguage,
        },
        status: {
          privacyStatus: meta.privacyStatus,
          selfDeclaredMadeForKids: meta.selfDeclaredMadeForKids,
        },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`resumable session failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const session = res.headers.get("location");
  if (!session) throw new Error("resumable session returned no upload URL");
  return session;
}

/** Ask the server how many bytes it already has (after a broken connection). */
async function queryOffset(session, size) {
  try {
    const res = await fetch(session, {
      method: "PUT",
      headers: { "Content-Range": `bytes */${size}`, "Content-Length": "0" },
    });
    if (res.status === 200 || res.status === 201) return { offset: size, body: await res.json() };
    if (res.status === 308) {
      const range = res.headers.get("range");
      return { offset: range ? Number(range.split("-")[1]) + 1 : 0, body: null };
    }
  } catch {
    // still offline — the caller retries
  }
  return null;
}

async function resumableUpload(token, meta, size) {
  const session = await startResumableSession(token, meta, size);
  const started = Date.now();
  let offset = 0;
  let failures = 0;

  function report() {
    const pct = ((offset / size) * 100).toFixed(1);
    const mb = (offset / 1024 / 1024).toFixed(1);
    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    process.stdout.write(`\r  ${pct}%  ${mb} MB  ${(offset / 1024 / 1024 / secs).toFixed(2)} MB/s    `);
  }

  while (offset < size) {
    const end = Math.min(offset + CHUNK_SIZE, size) - 1;
    const length = end - offset + 1;
    try {
      const res = await fetch(session, {
        method: "PUT",
        headers: {
          "Content-Length": String(length),
          "Content-Range": `bytes ${offset}-${end}/${size}`,
        },
        body: fs.createReadStream(meta.videoPath, { start: offset, end }),
        duplex: "half",
      });
      if (res.status === 200 || res.status === 201) {
        process.stdout.write("\n");
        return res.json();
      }
      if (res.status === 308) {
        const range = res.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : offset + length;
        failures = 0;
        report();
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (err) {
      failures++;
      if (failures >= TRANSFER_ATTEMPTS) {
        throw new Error(`upload failed at ${(offset / 1048576).toFixed(1)} MB: ${err.message}`);
      }
      console.warn(`\n  transfer error (${err.message}) — resuming (${failures}/${TRANSFER_ATTEMPTS})...`);
      await new Promise((resolve) => setTimeout(resolve, 3000 * failures));
      const state = await queryOffset(session, size);
      if (state && state.body) {
        process.stdout.write("\n");
        return state.body;
      }
      if (state) {
        offset = state.offset;
        report();
      }
    }
  }
  throw new Error("upload finished without a response");
}

async function getChannel(youtube) {
  const res = await youtube.channels.list({ part: ["snippet", "contentDetails"], mine: true });
  const ch = res.data.items?.[0];
  if (!ch) throw new Error("No YouTube channel found for this token");
  return ch;
}

async function findDuplicates(youtube, uploadsPlaylistId, title) {
  const target = norm(title);
  const hits = [];
  let pageToken;
  do {
    const res = await youtube.playlistItems.list({
      part: ["snippet"],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });
    for (const item of res.data.items || []) {
      const t = item.snippet?.title || "";
      if (norm(t) === target || norm(t).includes(norm("Chamak Tujh Se Paate"))) {
        hits.push({ videoId: item.snippet.resourceId.videoId, title: t });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return hits;
}

(async () => {
  if (!fs.existsSync(meta.videoPath)) throw new Error(`Video not found: ${meta.videoPath}`);
  const size = fs.statSync(meta.videoPath).size;

  const auth = getAuth();
  const youtube = google.youtube({ version: "v3", auth });

  const channel = await getChannel(youtube);
  console.log(`Channel : ${channel.snippet.title} (${channel.id})  [${CHANNEL.label}]`);
  console.log(`Token   : ${CHANNEL.token}`);
  console.log(`Video   : ${meta.videoPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Title   : ${meta.title}`);
  console.log(`Privacy : ${meta.privacyStatus}`);

  const dupes = await findDuplicates(
    youtube,
    channel.contentDetails.relatedPlaylists.uploads,
    meta.title,
  );
  if (dupes.length) {
    console.log("\nPossible duplicates already on the channel:");
    for (const d of dupes) console.log(`  - ${d.title} -> https://youtu.be/${d.videoId}`);
  } else {
    console.log("\nNo duplicate found on the channel.");
  }

  // The queue wrapper asks us to stop instead of creating another public copy.
  // Exit 4 is a deferral: the wrapper adopts the existing video and records it.
  if (CONFIRM && process.argv.includes("--abort-on-duplicate") && dupes.length) {
    const exact = dupes.find((d) => norm(d.title) === norm(meta.title)) || dupes[0];
    console.log(`\nDUPLICATE_ID=${exact.videoId}`);
    console.log("Aborting — an existing copy already matches this title (use --force to upload anyway).");
    process.exit(4);
  }

  if (!CONFIRM) {
    console.log("\nDRY RUN — nothing uploaded. Re-run with --confirm to upload.");
    return;
  }

  console.log("\nUploading...");
  const res = { data: await resumableUpload(await accessToken(auth), meta, size) };

  const id = res.data?.id;
  if (!id) throw new Error(`upload response had no video id: ${JSON.stringify(res.data).slice(0, 300)}`);
  console.log(`\nUploaded: https://youtu.be/${id}`);

  // Optional custom thumbnail from the same metadata file.
  let thumbnail = null;
  if (meta.thumbPath && fs.existsSync(meta.thumbPath)) {
    try {
      await youtube.thumbnails.set({
        videoId: id,
        media: { body: fs.createReadStream(meta.thumbPath) },
      });
      thumbnail = meta.thumbPath;
      console.log(`Thumbnail set: ${meta.thumbPath}`);
    } catch (err) {
      console.warn(`Thumbnail failed: ${err.message}`);
    }
  }

  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify(
      { videoId: id, url: `https://youtu.be/${id}`, channel: channel.snippet.title, thumbnail, at: new Date().toISOString(), meta },
      null,
      2,
    ),
  );

  if (process.argv.includes("--comment") && process.env.PLAY_STORE_URL) {
    try {
      const app = process.env.APP_NAME || "Owais Raza Qadri";
      const c = await youtube.commentThreads.insert({
        part: ["snippet"],
        requestBody: {
          snippet: {
            videoId: id,
            topLevelComment: {
              snippet: { textOriginal: CHANNEL.comment(app, process.env.PLAY_STORE_URL) },
            },
          },
        },
      });
      console.log(`Comment added: ${c.data.id} (pin manually if desired)`);
    } catch (err) {
      console.warn(`Comment failed: ${err.message}`);
    }
  }

  console.log(`Saved receipt: ${RESULT_PATH}`);
})().catch((e) => {
  console.error("\nERROR:", e.message);
  process.exit(1);
});
