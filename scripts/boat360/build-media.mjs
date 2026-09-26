#!/usr/bin/env node
// Optimizes a boat's source photos into responsive WebP/AVIF tiers and writes
// the generated media index consumed by the boat config.
//
//   node scripts/boat360/build-media.mjs --slug harris-kayot-220-classic
//
// Optional real 360° sequence: put numbered frames in
//   media-source/boats/<slug>/360/boat-001.jpg … boat-036.jpg
// They are validated (size, ordering, gaps, duplicates, exposure) and
// written as sm/md/lg WebP tiers. The index then contains a `spin` block.

import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import {
  ROOT,
  PUBLIC_MEDIA_ROOT,
  GENERATED_DATA_ROOT,
  SPIN_TIERS,
  ensureDir,
  toPublicUrl,
  validateSequence,
  writePhotoTiers,
  writeSpinFrame,
} from "./lib.mjs";

const argv = process.argv.slice(2);
const slug = argv[argv.indexOf("--slug") + 1];
if (!slug || argv.indexOf("--slug") === -1) {
  console.error("Missing --slug");
  process.exit(1);
}

const sourceRoot = path.join(ROOT, "media-source", "boats", slug);
const outRoot = path.join(PUBLIC_MEDIA_ROOT, slug);

function escapeXml(s) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}

/** A neutral "photo needed" card. Never mistaken for a photograph. */
function placeholderCard({ title, note }) {
  const W = 1600;
  const H = 1200;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#e8edf3"/>
  <rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="36" fill="none" stroke="#9fb0c5" stroke-width="6" stroke-dasharray="28 20"/>
  <g transform="translate(${W / 2 - 90} ${H / 2 - 250})" fill="none" stroke="#7b8ea8" stroke-width="12" stroke-linejoin="round">
    <rect x="0" y="40" width="180" height="130" rx="18"/><circle cx="90" cy="105" r="38"/><path d="M50 40 L65 10 H115 L130 40"/>
  </g>
  <text x="${W / 2}" y="${H / 2 + 20}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="92" font-weight="700" fill="#0b2545">${escapeXml(title)}</text>
  <text x="${W / 2}" y="${H / 2 + 110}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="44" fill="#51637d">${escapeXml(note)}</text>
  <text x="${W / 2}" y="${H - 110}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="36" font-weight="700" letter-spacing="6" fill="#8a9bb2">PLACEHOLDER · NOT A PHOTOGRAPH</text>
</svg>`);
}

async function buildSpin() {
  const dir = path.join(sourceRoot, "360");
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => /\.(jpe?g|png|webp|avif|heic|tiff?)$/i.test(f)).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const abs = files.map((f) => path.join(dir, f));

  const warnings = await validateSequence(abs);
  if (files.length < 24) warnings.unshift(`Only ${files.length} frames — at least 24 are recommended (36 standard, 48–72 premium).`);
  for (const w of warnings) console.warn(`  ⚠ 360: ${w}`);

  const spinOut = path.join(outRoot, "360");
  const meta = await sharp(abs[0]).rotate().metadata();
  const padLength = Math.max(3, String(files.length).length);
  for (let i = 0; i < abs.length; i++) {
    await writeSpinFrame(abs[i], spinOut, i + 1, padLength);
    process.stdout.write(`\r  360 frame ${i + 1}/${abs.length}`);
  }
  process.stdout.write("\n");
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  return {
    placeholder: false,
    frameCount: files.length,
    width,
    height,
    padLength,
    tiers: SPIN_TIERS.map((t) => ({ name: t.name, width: t.width, urlPattern: `${toPublicUrl(path.join(spinOut, t.name))}/frame-{frame}.webp` })),
    warnings,
  };
}

/**
 * Videos → 720p WebM (VP9/Opus) + H.264/AAC MP4 with faststart, plus a WebP
 * poster. Browsers pick the first source they can decode: WebM for
 * Chrome/Firefox/Edge (incl. builds without H.264), MP4 for Safari/iOS. Needs ffmpeg: on PATH, or FFMPEG=/path/to/ffmpeg.
 */
async function buildVideos(entries) {
  const out = {};
  if (entries.length === 0) return out;
  const ffmpeg = process.env.FFMPEG || "ffmpeg";
  try {
    execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
  } catch {
    console.warn("  ⚠ ffmpeg not found (set FFMPEG=/path/to/ffmpeg) — skipping videos");
    return out;
  }
  for (const v of entries) {
    const input = path.join(sourceRoot, v.source);
    const dir = path.join(outRoot, "video");
    await ensureDir(dir);
    const mp4 = path.join(dir, `${v.id}.mp4`);
    const webm = path.join(dir, `${v.id}.webm`);
    const posterPng = path.join(dir, `${v.id}-poster.png`);
    const poster = path.join(dir, `${v.id}-poster.webp`);
    execFileSync(ffmpeg, [
      "-y", "-loglevel", "error", "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale=-2:720:flags=lanczos,fps=30",
      "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-ac", "2",
      "-movflags", "+faststart", mp4,
    ]);
    execFileSync(ffmpeg, [
      "-y", "-loglevel", "error", "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale=-2:720:flags=lanczos,fps=30",
      "-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
      "-c:a", "libopus", "-b:a", "80k", webm,
    ]);
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", String(v.posterAt ?? 0), "-i", input, "-frames:v", "1", "-vf", "scale=-2:720", posterPng]);
    await sharp(posterPng).webp({ quality: 74 }).toFile(poster);
    await fs.rm(posterPng);
    out[v.id] = {
      id: v.id,
      src: toPublicUrl(mp4),
      sources: [
        { src: toPublicUrl(webm), type: "video/webm" },
        { src: toPublicUrl(mp4), type: "video/mp4" },
      ],
      poster: toPublicUrl(poster),
    };
    const mb = async (f) => ((await fs.stat(f)).size / 1e6).toFixed(1);
    console.log(`  ✓ video ${v.id} (webm ${await mb(webm)} MB, mp4 ${await mb(mp4)} MB)`);
  }
  return out;
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, "manifest.json"), "utf8"));
  const file = path.join(GENERATED_DATA_ROOT, `${slug}.media.json`);
  // --videos-only: keep the existing photo derivatives, just (re)encode videos.
  const videosOnly = argv.includes("--videos-only");
  const assets = videosOnly ? JSON.parse(await fs.readFile(file, "utf8")).assets : {};

  for (const entry of videosOnly ? [] : manifest.assets) {
    const dir = path.join(outRoot, "photos", entry.id);
    const input = entry.placeholder
      ? await sharp(placeholderCard(entry.placeholder)).png().toBuffer()
      : path.join(sourceRoot, entry.source);
    const result = await writePhotoTiers(input, dir, { crop: entry.crop });
    assets[entry.id] = {
      id: entry.id,
      alt: entry.alt,
      placeholder: Boolean(entry.placeholder),
      ...(entry.crop ? { derivedFrom: path.basename(entry.source, path.extname(entry.source)) } : {}),
      ...result,
    };
    console.log(`  ✓ ${entry.id} (${result.width}×${result.height}, ${result.tiers.map((t) => t.name).join("/")})`);
  }

  const videos = await buildVideos(manifest.videos ?? []);
  const spin = await buildSpin();
  await ensureDir(GENERATED_DATA_ROOT);
  await fs.writeFile(
    file,
    JSON.stringify({ $comment: "GENERATED by scripts/boat360/build-media.mjs — do not edit by hand.", slug, assets, videos, spin }, null, 2) + "\n",
  );
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
