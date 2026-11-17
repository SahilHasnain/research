const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");

dotenv.config({ path: path.join("D:/Projects/naat-collection", ".env.naat-collection") });

async function check(label, refreshToken) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "urn:ietf:wg:oauth:2.0:oob",
  );
  auth.setCredentials({ refresh_token: refreshToken });
  const youtube = google.youtube({ version: "v3", auth });
  const res = await youtube.channels.list({
    part: ["snippet", "statistics", "contentDetails"],
    mine: true,
  });
  const ch = res.data.items?.[0];
  if (!ch) return console.log(`${label}: no channel`);
  console.log(`${label}:`);
  console.log(`  title:   ${ch.snippet.title}`);
  console.log(`  id:      ${ch.id}`);
  console.log(`  handle:  ${ch.snippet.customUrl || "(none)"}`);
  console.log(`  videos:  ${ch.statistics.videoCount}`);
  console.log(`  uploads: ${ch.contentDetails.relatedPlaylists.uploads}`);
}

(async () => {
  await check("GOOGLE_REFRESH_TOKEN", process.env.GOOGLE_REFRESH_TOKEN);
  await check("GOOGLE_REFRESH_TOKEN_TEENAGE", process.env.GOOGLE_REFRESH_TOKEN_TEENAGE);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
