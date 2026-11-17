/**
 * Teenage-voice version of a cut naat.
 *
 * Mirrors the naat-collection pipeline so both channels sound identical:
 *   apps/ai-service/voice_worker.py → pitch_shift()
 *   scripts/youtube-upload/upload-teenage-to-youtube.js → createVideo()
 *
 * Pitch only, tempo untouched:
 *   asetrate=44100*ratio, aresample=44100, atempo=1/ratio   (ratio = 2^(n/12))
 *
 * The audio comes from our already-cut video, so the teenage version has the
 * explanation removed too. Audio-only uploads do not exist on YouTube, so the
 * band thumbnail becomes a still image and the MP3 rides underneath it.
 */
const { execFileSync } = require("child_process");

const SEMITONES = 6;
const SAMPLE_RATE = 44100;
const AUDIO_BITRATE = "256k";
const VIDEO_AUDIO_BITRATE = "192k";

function run(args) {
  execFileSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
}

/** Pull the (already explanation-free) audio out of the cut video. */
function extractAudio(videoPath, outPath) {
  run(["-y", "-i", videoPath, "-vn", "-c:a", "aac", "-b:a", AUDIO_BITRATE, outPath]);
  return outPath;
}

/** Pitch-shift without changing duration, exactly like the AI voice worker. */
function pitchShift(inputPath, outPath, semitones = SEMITONES) {
  const ratio = 2 ** (Number(semitones) / 12);
  const filter = `asetrate=${Math.round(SAMPLE_RATE * ratio)},aresample=${SAMPLE_RATE},atempo=${1 / ratio}`;
  run(["-y", "-i", inputPath, "-filter:a", filter, "-vn", "-c:a", "aac", "-b:a", AUDIO_BITRATE, outPath]);
  return outPath;
}

/** Still image + audio, encoded the same way as the naat-collection uploader. */
function buildStillVideo(audioPath, imagePath, outPath) {
  run([
    "-y",
    "-loop", "1", "-i", imagePath,
    "-i", audioPath,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage",
    "-c:a", "aac", "-b:a", VIDEO_AUDIO_BITRATE,
    "-pix_fmt", "yuv420p",
    "-shortest", "-movflags", "+faststart",
    outPath,
  ]);
  return outPath;
}

module.exports = { extractAudio, pitchShift, buildStillVideo, SEMITONES };
