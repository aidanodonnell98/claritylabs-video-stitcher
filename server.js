import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
app.get("/", (req, res) => {
  res.status(200).send("OK");
});
app.listen(process.env.PORT || 8080);
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.API_KEY; // set in Railway variables

function safeTmp(name) {
  // ensure only filename-ish
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${code}): ${stderr}`));
    });
  });
}

// Downloads via ffmpeg (handles redirects better than node-fetch for media URLs)
async function downloadToFile(url, outPath) {
  // -y overwrite, -loglevel error to keep clean
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", url, "-c", "copy", outPath]);
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/stitch", async (req, res) => {
  try {
    // Simple auth (optional but recommended)
    if (API_KEY) {
      const got = req.header("x-api-key");
      if (!got || got !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
    }

    const { videos, narrationUrl, outWidth = 1080, outHeight = 1920 } = req.body;

    if (!Array.isArray(videos) || videos.length !== 3) {
      return res.status(400).json({ error: "videos must be an array of exactly 3 URLs" });
    }
    if (!narrationUrl || typeof narrationUrl !== "string") {
      return res.status(400).json({ error: "narrationUrl is required" });
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stitch-"));
    const v1 = path.join(tmp, safeTmp("v1.mp4"));
    const v2 = path.join(tmp, safeTmp("v2.mp4"));
    const v3 = path.join(tmp, safeTmp("v3.mp4"));
    const a1 = path.join(tmp, safeTmp("narration.mp3"));
    const out = path.join(tmp, safeTmp("final.mp4"));

    // Download inputs
    await downloadToFile(videos[0], v1);
    await downloadToFile(videos[1], v2);
    await downloadToFile(videos[2], v3);
    await downloadToFile(narrationUrl, a1);

    // FFmpeg: loop each clip, concat hard cuts, crop/scale to 9:16, add narration, stop at narration end
    const filter = `[0:v][1:v][2:v]concat=n=3:v=1:a=0,` +
      `scale=${outWidth}:${outHeight}:force_original_aspect_ratio=increase,` +
      `crop=${outWidth}:${outHeight},setsar=1[v]`;

    const args = [
      "-y", "-loglevel", "error",
      "-stream_loop", "-1", "-i", v1,
      "-stream_loop", "-1", "-i", v2,
      "-stream_loop", "-1", "-i", v3,
      "-i", a1,
      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "3:a",
      "-shortest",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      out
    ];

    await run("ffmpeg", args);

    // Return the MP4 binary
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="final.mp4"');

    const stream = fs.createReadStream(out);
    stream.on("close", () => {
      // cleanup best-effort
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    });
    stream.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("stitcher running");
});
