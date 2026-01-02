import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Health + root
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Optional simple auth (set API_KEY in Railway Variables if you want)
const API_KEY = process.env.API_KEY || "";

// In-memory map so Make can GET the finished MP4
const results = new Map(); // id -> { filePath, expiresAt }
const RESULT_TTL_MS = 30 * 60 * 1000; // 30 min

function cleanupResults() {
  const now = Date.now();
  for (const [id, meta] of results.entries()) {
    if (meta.expiresAt <= now) {
      try { fs.unlinkSync(meta.filePath); } catch {}
      results.delete(id);
    }
  }
}
setInterval(cleanupResults, 60 * 1000).unref();

async function downloadToTmp(url, filename) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to download ${url} (HTTP ${res.status})`);
  if (!res.body) throw new Error(`No response body for ${url}`);

  const filePath = path.join(os.tmpdir(), filename);
  const nodeStream = Readable.fromWeb(res.body);
  await pipeline(nodeStream, fs.createWriteStream(filePath));
  return filePath;
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    // IMPORTANT: this catches "ffmpeg not found"
    p.on("error", (err) => {
      reject(new Error(`spawn ffmpeg failed: ${err.code || ""} ${err.message}`));
    });

    // IMPORTANT: this tells us if Railway killed it (SIGKILL etc.)
    p.on("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `ffmpeg exited code=${code} signal=${signal}\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`
        )
      );
    });
  });
}

/**
 * POST /stitch
 * Accepts either:
 *  - { audioUrl, videoUrls: [..3..] }   (your current Make naming)
 *  - { narrationUrl, videos: [..3..] }  (alternate)
 *
 * Returns:
 *  - { ok: true, resultUrl }  where resultUrl is GET /result/:id
 */
app.post("/stitch", async (req, res) => {
  try {
    // Optional auth
    if (API_KEY) {
      const got = req.header("x-api-key");
      if (!got || got !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
    }

    // Support both payload styles
    const audioUrl = req.body?.audioUrl ?? req.body?.narrationUrl;
    const videoUrls = req.body?.videoUrls ?? req.body?.videos;

    console.log("REQ BODY:", JSON.stringify(req.body, null, 2));

    if (!audioUrl || typeof audioUrl !== "string" || !audioUrl.startsWith("http")) {
      return res.status(400).json({ error: "audioUrl/narrationUrl missing/invalid", audioUrl });
    }
    if (!Array.isArray(videoUrls) || videoUrls.length !== 3) {
      return res.status(400).json({ error: "videoUrls/videos must be an array of exactly 3 URLs", videoUrls });
    }
    const bad = videoUrls.find(v => !v || typeof v !== "string" || !v.startsWith("http"));
    if (bad) return res.status(400).json({ error: "One of the video URLs is invalid", bad });

    // Unique IDs + temp files
    const id = crypto.randomBytes(8).toString("hex");
    const v1 = await downloadToTmp(videoUrls[0], `v1_${id}.mp4`);
    const v2 = await downloadToTmp(videoUrls[1], `v2_${id}.mp4`);
    const v3 = await downloadToTmp(videoUrls[2], `v3_${id}.mp4`);
    const a1 = await downloadToTmp(audioUrl, `narr_${id}.mp3`);

    // Create concat playlist file for looping v1->v2->v3
    const listPath = path.join(os.tmpdir(), `list_${id}.txt`);
    // IMPORTANT: concat demuxer needs "file 'path'"
    const listTxt =
      `file '${v1.replace(/'/g, "'\\''")}'\n` +
      `file '${v2.replace(/'/g, "'\\''")}'\n` +
      `file '${v3.replace(/'/g, "'\\''")}'\n`;
    await fs.promises.writeFile(listPath, listTxt, "utf8");

    // Output file
    const outPath = path.join(os.tmpdir(), `final_${id}.mp4`);

    // Make a normalized base (v1->v2->v3) at 1080x1920 once,
// then loop that single base video until narration ends.
// This is usually more stable and less CPU than looping concat demuxer forever.

const basePath = path.join(os.tmpdir(), `base_${id}.mp4`);

// Step 1) Build base.mp4 from your 3 clips (hard cuts)
const baseArgs = [
  "-y",
  "-loglevel", "error",

  // concat list as input (no looping here)
  "-f", "concat",
  "-safe", "0",
  "-i", listPath,

  "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30",

  "-an",
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "28",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  basePath
];

await runFFmpeg(baseArgs);

// Step 2) Loop base.mp4 until narration ends, and mux narration audio
const finalArgs = [
  "-y",
  "-loglevel", "error",

  "-stream_loop", "-1",
  "-i", basePath,

  "-i", a1,

  "-map", "0:v:0",
  "-map", "1:a:0",
  "-shortest",

  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "28",
  "-pix_fmt", "yuv420p",

  "-c:a", "aac",
  "-b:a", "192k",

  "-movflags", "+faststart",
  outPath
];

await runFFmpeg(finalArgs);

// cleanup base
try { fs.unlinkSync(basePath); } catch {}

    // Store result for GET
    results.set(id, { filePath: outPath, expiresAt: Date.now() + RESULT_TTL_MS });

    // Best-effort cleanup of intermediate files
    for (const p of [v1, v2, v3, a1, listPath]) {
      try { fs.unlinkSync(p); } catch {}
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const resultUrl = `${baseUrl}/result/${id}`;

    return res.json({ ok: true, resultUrl, id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// Download endpoint Make can use
app.get("/result/:id", (req, res) => {
  const id = req.params.id;
  const meta = results.get(id);
  if (!meta) return res.status(404).send("Not found (expired or missing)");

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="final_${id}.mp4"`);

  const stream = fs.createReadStream(meta.filePath);
  stream.on("error", () => res.status(500).end());
  stream.pipe(res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("stitcher running on", PORT);
});
