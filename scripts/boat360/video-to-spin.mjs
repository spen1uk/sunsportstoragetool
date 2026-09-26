#!/usr/bin/env node
// Turns a walkaround video into a numbered 360° frame sequence
// (media-source/boats/<slug>/360/boat-001.jpg …), ready for build-media.mjs.
//
// Frames are sampled evenly in time, so walk around the boat at a steady
// pace, at a steady distance, and keep the whole boat in frame. Use
// --reverse when the walk went the opposite way to the viewer's convention
// (dragging right should move the camera the way the walk went).
//
//   FFMPEG=/path/to/ffmpeg node scripts/boat360/video-to-spin.mjs \
//     --slug harris-kayot-220-classic --video video/IMG_5189.MOV --frames 48 --reverse
//
// Options: --start <sec> --end <sec> to trim, --width <px> (default 1920).

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, ensureDir, pad } from "./lib.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const slug = arg("slug");
const video = arg("video");
if (!slug || !video) {
  console.error("Usage: video-to-spin.mjs --slug <slug> --video <path relative to media-source/boats/<slug>> [--frames 48] [--reverse]");
  process.exit(1);
}
const frames = Number(arg("frames", 48));
const width = Number(arg("width", 1920));
const reverse = argv.includes("--reverse");
const ffmpeg = process.env.FFMPEG || "ffmpeg";

const sourceRoot = path.join(ROOT, "media-source", "boats", slug);
const input = path.join(sourceRoot, video);

const probe = (() => {
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-i", input], { stdio: "pipe" });
  } catch (err) {
    return String(err.stderr);
  }
  return "";
})();
const m = probe.match(/Duration: (\d+):(\d+):([\d.]+)/);
if (!m) {
  console.error(`Could not read ${input} (is ffmpeg installed? set FFMPEG=…)`);
  process.exit(1);
}
const duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
const start = Number(arg("start", 0));
const end = Math.min(duration, Number(arg("end", duration)));
const span = end - start;

const outDir = path.join(sourceRoot, "360");
await ensureDir(outDir);
for (const f of await fs.readdir(outDir)) if (/^boat-\d+\.jpg$/.test(f)) await fs.unlink(path.join(outDir, f));

const tmp = path.join(outDir, ".extract");
await ensureDir(tmp);
execFileSync(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-ss", String(start), "-t", String(span), "-i", input,
  "-vf", `fps=${frames}/${span},scale=${width}:-2:flags=lanczos`,
  "-frames:v", String(frames), "-q:v", "2",
  path.join(tmp, "f%04d.jpg"),
]);
const extracted = (await fs.readdir(tmp)).sort();
const padLength = Math.max(3, String(extracted.length).length);
for (const [i, f] of extracted.entries()) {
  const n = reverse ? extracted.length - i : i + 1;
  await fs.rename(path.join(tmp, f), path.join(outDir, `boat-${pad(n, padLength)}.jpg`));
}
await fs.rmdir(tmp);
console.log(`wrote ${extracted.length} frames to ${path.relative(ROOT, outDir)}${reverse ? " (reversed)" : ""}`);
