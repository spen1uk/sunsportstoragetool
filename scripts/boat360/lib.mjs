// Shared helpers for the boat 360° media pipeline.
//
// Everything here runs at build/authoring time (Node + sharp), never in the
// browser. The viewer only ever sees the optimized derivatives this writes.

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const PUBLIC_MEDIA_ROOT = path.join(ROOT, "public", "boat-media");
export const GENERATED_DATA_ROOT = path.join(ROOT, "lib", "boats", "generated");

/**
 * Responsive tiers for still photos. `lg` is the zoom tier and is only
 * fetched when a customer actually zooms in.
 */
export const PHOTO_TIERS = [
  { name: "thumb", width: 400, formats: ["webp"], quality: 70 },
  { name: "sm", width: 768, formats: ["avif", "webp"], quality: 74 },
  { name: "md", width: 1440, formats: ["avif", "webp"], quality: 76 },
  { name: "lg", width: 2400, formats: ["avif", "webp"], quality: 80 },
];

/**
 * Tiers for 360° frame sequences. The viewer paints frames onto a canvas via
 * `Image.decode()`, so every browser we target needs to decode the format —
 * WebP is universal on current Safari/Chrome/Firefox, AVIF is not yet safe
 * for canvas-heavy sequences on older iOS, so frames ship WebP only.
 */
export const SPIN_TIERS = [
  { name: "sm", width: 640, quality: 70 },
  { name: "md", width: 1280, quality: 76 },
  { name: "lg", width: 1920, quality: 80 },
];

export function pad(n, len = 3) {
  return String(n).padStart(len, "0");
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export function toPublicUrl(absPath) {
  return "/" + path.relative(path.join(ROOT, "public"), absPath).split(path.sep).join("/");
}

async function encode(pipeline, format, quality) {
  if (format === "avif") return pipeline.avif({ quality: Math.round(quality * 0.75), effort: 4 });
  return pipeline.webp({ quality, effort: 5 });
}

/**
 * Write every tier of one still image. Never upscales: tiers wider than the
 * (cropped) source are skipped, and the largest remaining tier is capped at
 * the source width so zooming always has the best pixels available.
 */
export async function writePhotoTiers(input, outDir, { crop } = {}) {
  await ensureDir(outDir);
  // .rotate() applies EXIF orientation; sharp strips EXIF (incl. GPS) on output.
  // Work from a lossless raw buffer so crops are never re-compressed twice.
  const { data, info } = await sharp(input).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rawOpts = { raw: { width: info.width, height: info.height, channels: info.channels } };
  let srcW = info.width;
  let srcH = info.height;
  let buffer = await sharp(data, rawOpts).png({ compressionLevel: 0 }).toBuffer();

  if (crop) {
    const left = Math.round((crop.x / 100) * srcW);
    const top = Math.round((crop.y / 100) * srcH);
    const width = Math.min(srcW - left, Math.round((crop.w / 100) * srcW));
    const height = Math.min(srcH - top, Math.round((crop.h / 100) * srcH));
    buffer = await sharp(buffer).extract({ left, top, width, height }).png({ compressionLevel: 0 }).toBuffer();
    srcW = width;
    srcH = height;
  }
  const tiers = [];
  for (const tier of PHOTO_TIERS) {
    const width = Math.min(tier.width, srcW);
    const height = Math.round((srcH / srcW) * width);
    const entry = { name: tier.name, width, height };
    for (const format of tier.formats) {
      const file = path.join(outDir, `${tier.name}.${format}`);
      await (await encode(sharp(buffer).resize({ width }), format, tier.quality)).toFile(file);
      entry[format] = toPublicUrl(file);
    }
    tiers.push(entry);
    // Source exhausted: larger tiers would just be upscales.
    if (tier.name !== "thumb" && tier.width >= srcW) break;
  }

  const blur = await sharp(buffer).resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
  return {
    width: srcW,
    height: srcH,
    tiers,
    blurDataURL: `data:image/webp;base64,${blur.toString("base64")}`,
  };
}

/** Write sm/md/lg WebP tiers for a single 360° frame. */
export async function writeSpinFrame(input, outRoot, frameNumber, padLength = 3) {
  const results = [];
  for (const tier of SPIN_TIERS) {
    const dir = path.join(outRoot, tier.name);
    await ensureDir(dir);
    const file = path.join(dir, `frame-${pad(frameNumber, padLength)}.webp`);
    await sharp(input).rotate().resize({ width: tier.width }).webp({ quality: tier.quality, effort: 5 }).toFile(file);
    results.push(file);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Sequence validation
// ---------------------------------------------------------------------------

/** 64-bit difference hash, used to catch duplicate / near-duplicate frames. */
async function dHash(input) {
  const { data } = await sharp(input).rotate().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? "1" : "0";
  }
  return bits;
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Check an uploaded 360° sequence before it is turned into a viewer.
 * Returns human-readable warnings; an empty array means it looks healthy.
 *
 * - dimensions: all frames should share (nearly) the same size/aspect
 * - ordering / missing frames: numbered file names must be contiguous
 * - duplicates: consecutive frames that are visually identical
 * - exposure: frames whose brightness is far from the sequence median
 */
export async function validateSequence(files) {
  const warnings = [];
  const numbers = files.map((f) => Number((path.basename(f).match(/(\d+)(?=\.[a-z]+$)/i) || [])[1]));
  if (numbers.some((n) => Number.isNaN(n))) {
    warnings.push("Some files are not numbered (expected e.g. boat-001.jpg); ordering is by file name.");
  } else {
    const sorted = [...numbers].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) warnings.push(`Frame number ${sorted[i]} appears twice.`);
      for (let n = sorted[i - 1] + 1; n < sorted[i]; n++) warnings.push(`Frame ${n} is missing.`);
    }
  }

  const stats = [];
  for (const file of files) {
    const img = sharp(file).rotate();
    const meta = await img.metadata();
    const s = await img.stats();
    const luminance = 0.2126 * s.channels[0].mean + 0.7152 * s.channels[1].mean + 0.0722 * s.channels[2].mean;
    stats.push({ file, width: meta.autoOrient?.width ?? meta.width, height: meta.autoOrient?.height ?? meta.height, luminance, hash: await dHash(file) });
  }

  const ref = stats[0];
  for (const s of stats) {
    const aspectDiff = Math.abs(s.width / s.height - ref.width / ref.height);
    if (aspectDiff > 0.02) warnings.push(`${path.basename(s.file)} has a different aspect ratio (${s.width}×${s.height}).`);
    else if (Math.abs(s.width - ref.width) / ref.width > 0.1) warnings.push(`${path.basename(s.file)} is a different size (${s.width}×${s.height}).`);
  }

  for (let i = 0; i < stats.length; i++) {
    const next = stats[(i + 1) % stats.length];
    if (stats.length > 1 && hamming(stats[i].hash, next.hash) <= 2) {
      warnings.push(`${path.basename(stats[i].file)} and ${path.basename(next.file)} look identical (duplicate frame?).`);
    }
  }

  const lums = stats.map((s) => s.luminance).sort((a, b) => a - b);
  const median = lums[Math.floor(lums.length / 2)];
  for (const s of stats) {
    if (Math.abs(s.luminance - median) > 35) {
      warnings.push(`${path.basename(s.file)} is much ${s.luminance > median ? "brighter" : "darker"} than the rest of the sequence.`);
    }
  }
  return warnings;
}
