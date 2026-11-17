# Naat queue pipeline

Everything runs from this repo; the `naat-collection/apps/ai-service` code is used
only over HTTP (no changes there).

## Flow

1. `yt-dlp` downloads the best audio → `download/<id>.mp3`
2. Audio is POSTed (multipart) to `http://localhost:8000/detect-segments`
   → explanation ("speech") segments saved to `download/<id>.detect.json`
3. Video is downloaded (max 1080p, merged mp4) → `download/<id>.mp4`
4. The **same** detected segments are removed from the video (and optionally audio)
   → `cut/<id> - <title>.mp4`
5. MP3s are deleted; the detection JSON is kept so more clips can be cut later
   without re-running the model.
6. The cut video is uploaded to YouTube (main channel, public) with a
   **band-styled thumbnail** (the original artwork + "NO EXPLANATION") and the
   Play Store comment; the URL is stored in `queue/jobs.json` as `youtubeUrl`.
7. A comment is left on the **original** naat video pointing at that upload
   (see [Source video comment](#source-video-comment)).
8. The teenage-voice version is generated from the cut audio (+6 semitones) and
   uploaded to the **teenage channel** as a still-image video with the
   "TEENAGE VOICE" band artwork (see [Teenage voice upload](#teenage-voice-upload)).

## Commands

```bash
node scripts/queue.cjs add <youtube-url>   # enqueue
node scripts/queue.cjs list                # status overview (shows the YouTube URL)
node scripts/process-queue.cjs             # drain the queue (cut + upload)
node scripts/process-queue.cjs --one       # single job
node scripts/process-queue.cjs --videos-only   # backfill video cuts for detected jobs
node scripts/process-queue.cjs --keep-audio    # also keep mp3 outputs
node scripts/process-queue.cjs --keep-video    # keep the downloaded source video
node scripts/process-queue.cjs --no-upload     # cut only, no YouTube upload
node scripts/process-queue.cjs --no-source-comment   # upload, don't comment on the source
node scripts/process-queue.cjs --no-teen              # skip the teenage-voice upload

# upload a finished job to the teenage channel by itself
node scripts/upload-queue-video.cjs <id> --channel teenage [--dry-run]

# comment on the original naat video by hand (dry run first!)
node scripts/comment-source-video.cjs <id> --dry-run
node scripts/comment-source-video.cjs <id>
node scripts/comment-source-video.cjs <id> --force    # ignore budget/already-commented

# upload / re-upload one finished job by itself
node scripts/upload-queue-video.cjs <id> [--dry-run]
node scripts/upload-queue-video.cjs <id> --privacy unlisted
node scripts/upload-queue-video.cjs <id> --force      # ignore existing upload + daily cap

# manual cuts from an existing detection file
node scripts/cut-video.cjs download/<id>.detect.json download/<id>.mp4 "cut/<name>.mp4"
node scripts/cut-explanation.cjs download/<id>.detect.json download/<id>.mp3 "cut/<name>.mp3"

# optional: keep a little of the explanation on both sides of each kept range
node scripts/cut-video.cjs download/<id>.detect.json download/<id>.mp4 "cut/<name> [pad .15].mp4" --pad 0.15
```

Cutting trims each kept range and concatenates them (`trim`/`atrim` +
`setpts=PTS-STARTPTS`), so there is **no padding** — the segment boundaries are
exactly what the AI service reports.

`--pad <sec>` (default `0`) grows every kept range by `<sec>` on **each** side,
i.e. it keeps that much of the explanation. Ranges are clamped to the media and
merged when they would overlap, so no frame/audio is ever duplicated.

Every kept segment gets the same fade treatment as the naat-collection
`cut-audio-cron` worker (`FADE_DURATION = 0.3`):

- `afade=t=in:st=0:d=0.3` on every segment except a first segment that starts at 0
- `afade=t=out:st=(segLen-0.3):d=0.3` on every segment, including the last one

This makes the joins between segments smooth instead of hard audio jumps.

## YouTube upload

Uploads go through `yt/upload-video.cjs` (tokens, duplicate check, receipt,
Play Store comment) and are driven by `scripts/upload-queue-video.cjs`, which
builds the metadata from the job and records the result back into
`queue/jobs.json`.

- **channel** `main` → `GOOGLE_REFRESH_TOKEN`, title `[No Explanation] <title>`
- **privacy** `public` (override with `--privacy unlisted|private`)
- **comment** the same `📲 Download the <app> app: <link>` comment, posted after
  the upload (`--no-comment` to skip)
- **thumbnail** the source video's own artwork is fetched (`maxresdefault` →
  `sddefault` → `hqdefault` → `mqdefault`), then `scripts/lib/thumbnail-render.ps1`
  stamps the **band** style on it — bottom gradient, accent rule, yellow
  "NO EXPLANATION" — producing `download/<id>-thumb.jpg` (1280x720). The raw
  original stays at `download/<id>.jpg` so it can be re-rendered.
  Files under 5 KB or over 2 MB (YouTube's limit) are skipped; a missing or
  failed render falls back to the plain original, the upload still happens.
- **resumable transfer**: the upload is a resumable session in 16 MB chunks
  (`Content-Range`), so a dropped connection (ECONNRESET) resumes from the last
  byte the server acknowledged instead of restarting a 500 MB request
- **idempotent**: a job that already has `youtubeUrl` is skipped unless `--force`
- **daily cap**: at most **3 uploads per calendar day** (`NAAT_UPLOADS_PER_DAY`),
  tracked by video id in `queue/uploads.json` (idempotent, so a retried upload
  cannot use two slots). When the slots are gone, `uploadPending()` returns
  nothing and the queue processor stops before cutting more video — jobs stay
  `pending` for the next day. The wrapper exits 3 (a deferral, not a failure) if
  it is called anyway; `--force` overrides. This is separate from YouTube's own
  quota (~6 videos/day).
- **retries**: 3 attempts per job in the pipeline (`NAAT_UPLOAD_ATTEMPTS`), and
  `done` jobs without `youtubeUrl` are picked up again by the next queue run
  (an upload failure is recorded as `uploadError`, the cut video is kept)
- **quota**: `videos.insert` costs 1600 units, so ~6 uploads/day on the default
  10,000-unit quota

Receipts and per-job metadata live in `yt/queue-uploads/<id>.meta.json` and
`…-result.json`.

## Teenage voice upload

Every main upload also gets a teenage-voice sibling on the **teenage channel**.
The pipeline (`ensureTeenVideo()` / `teenUploadJob()` in `process-queue.cjs`)
builds it from the already-cut video, so the explanation is removed here too:

1. the cut video's audio is extracted to a temporary `.m4a`
2. pitch-shifted **+6 semitones, tempo unchanged**, using exactly the
   naat-collection convention (`asetrate=44100*ratio`, `aresample=44100`,
   `atempo=1/ratio`, AAC 256k) — see `scripts/lib/teen-voice.cjs`
3. the audio is married to the **"TEENAGE VOICE" band artwork**
   (`download/<id>-teen-thumb.jpg`) as a still-image MP4
   (`libx264 -preset ultrafast -tune stillimage`, AAC 192k, 1280x720) →
   `cut/<id> - <title> [teenage voice].mp4`
4. the temporary audio files are deleted immediately; only the MP4 and the
   artwork stay on disk
5. the MP4 is uploaded to the **teenage channel** with
   `upload-queue-video.cjs <id> --channel teenage`: title
   `[Teenage Voice] <title>`, **public**, the same Play Store app comment, and
   the teen thumbnail. The original/source video is **not** commented on for
   teenage uploads.

State lives beside the main upload in `queue/jobs.json`:
`teenVideoOutput`, `teenThumbPath`, `teenSemitones`, `teenYoutubeUrl`,
`teenYoutubeVideoId`, `teenUploadedAt`, `teenUploadReceipt`,
`teenThumbnailSet`, `teenUploadError`.

Command and caps:

```bash
node scripts/process-queue.cjs --no-teen     # skip the teenage channel
node scripts/upload-queue-video.cjs <id> --channel teenage --dry-run
```

- **separate daily budget**: at most **3 teenage uploads per day**
  (`NAAT_TEEN_UPLOADS_PER_DAY`), tracked under `teenage` in
  `queue/uploads.json` — a teenage upload never consumes a main-channel slot
  (and vice versa). `--force` overrides.
- a teenage upload is retried on the next queue run while its
  `teenYoutubeUrl` is missing; failures are recorded as `teenUploadError` and
  never affect the main upload or the source comment
- YouTube has no audio-only uploads, hence the still-image video. The teen MP4
  is small (the image never changes), so the daily budget, not disk, is the
  limit.

## Source video comment

Opt-in: comments are enabled by `NAAT_SOURCE_COMMENT=on` in
`scripts\run-queue.cmd` (currently on). Run
`scripts/comment-source-video.cjs <id> --dry-run` to preview the exact text;
manual runs of that script always post.

After a successful upload the pipeline leaves **one** comment on the original
naat video (the source id) linking to our no-explanation cut:

```
Assalamu alaikum. I removed the explanation part from "<naat title>" and kept
only the naat — sharing in case someone wants to listen without the talk in
between: https://youtu.be/<our video>
```

YouTube treats repeated comments containing links as spam, so the comment text
is not fixed:

- it quotes the naat's own title, so no two comments are identical
- one of four phrasings is chosen per video (stable hash of the id), rotated so
  consecutive videos do not repeat
- exactly one link, no hashtags, no emojis, no "subscribe" wording
- at most **3 per day** (`NAAT_SOURCE_COMMENTS_PER_DAY`), counted in
  `queue/source-comments.json`
- never on our own videos; skipped when the source has comments disabled or
  when our channel already has a top-level comment on it
- one comment per source video, status kept in `queue/jobs.json`
  (`sourceCommentStatus` = `commented` | `skipped` | `pending`)

The mechanics live in `yt/comment-external.cjs` (checks the source video, walks
its comment threads, posts one top-level comment) and
`scripts/comment-source-video.cjs` (text, budget, queue state). Skipped and
failed comments never affect the upload; `pending` ones are retried by the next
queue run, and `done` jobs whose comment is still owed are picked up even when
there is nothing left to cut.

Cost: `commentThreads.list` ≈ 1 unit per page, `commentThreads.insert` = 50
units — negligible next to the 1600-unit upload.

Note: the AI service container's Appwrite poller currently fails with
`402 Payment Required — project is in readonly mode`, so the queue-based worker
path is unusable; the HTTP endpoint still works and is what this pipeline uses.

## Background task (Windows logon)

`install-startup-task.ps1` registers the scheduled task **Naat Research Queue**
which drains `queue/jobs.json` automatically:

```powershell
# one-time setup (registers + starts it immediately)
powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1

# check state + tail the newest log
powershell -ExecutionPolicy Bypass -File scripts\task-status.ps1

# remove it again
powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup-task.ps1
```

How it runs:

- triggers: **at logon** (+2 min delay, so PATH/Docker/AI service are up) and
  **every 30 min** afterwards (`-RepeatMinutes` to change)
- hidden — `wscript.exe` → `scripts\run-queue-hidden.vbs` → `scripts\run-queue.cmd`,
  no console window
- logs every run to `queue\logs\queue-<timestamp>.log` (20 newest kept)
- only one instance at a time: Task Scheduler `IgnoreNew` plus the lock file
  `queue\.processor.lock` used by `process-queue.cjs`
- a run killed mid-job (service restart, reboot) is resumed next time, because
  `pending` / `detecting` / `video-pending` jobs are all re-processed
- detection is retried up to 5 times (`NAAT_DETECT_ATTEMPTS`), waiting for
  `/health` between attempts — survives AI container restarts
- jobs are only marked `failed` after all retries; requeue one with
  `node scripts/queue.cjs set <id> pending`
- uploads happen in the same run, right after the cut; each run also uploads any
  `done` job that still has no `youtubeUrl` (failed uploads retry automatically),
  but never more than **3 main-channel uploads per calendar day** — once the
  day's slots are used the run stops before cutting more video and keeps the
  remaining jobs pending for tomorrow
- the teenage-voice version is generated and uploaded right after the main
  upload, under its **own 3-per-day budget**; when those slots are gone the
  teenage work is deferred (the MP4 stays on disk) while main uploads continue
- source comments follow the same pattern but are **off unless**
  `NAAT_SOURCE_COMMENT=on`: posted right after the upload, and any `done` job
  whose comment is still `pending` is retried on the next run (the daily budget
  keeps the channel under 3 link comments per day)

