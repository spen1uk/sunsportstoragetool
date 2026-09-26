#!/usr/bin/env node
// Downloads a boat's original photos/videos from Google Drive into
// media-source/boats/<slug>/ (git-ignored), using the Drive file ids in the
// boat's manifest.json. Originals are large (3–10 MB each), so they live in
// Drive and only optimized derivatives are committed.
//
// The Drive files must be shared "Anyone with the link" (Viewer is enough),
// and the machine needs network access to drive.usercontent.google.com.
//
//   node scripts/boat360/fetch-drive.mjs --slug harris-kayot-220-classic

import fs from "node:fs/promises";
import path from "node:path";
import { ROOT, ensureDir } from "./lib.mjs";

const argv = process.argv.slice(2);
const slug = argv[argv.indexOf("--slug") + 1];
if (!slug || argv.indexOf("--slug") === -1) {
  console.error("Missing --slug");
  process.exit(1);
}

const sourceRoot = path.join(ROOT, "media-source", "boats", slug);
const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, "manifest.json"), "utf8"));
const entries = [...(manifest.assets ?? []), ...(manifest.videos ?? [])].filter((e) => e.drive && e.source);

// De-duplicate: several assets may share one source file.
const bySource = new Map(entries.map((e) => [e.source, e.drive]));

async function exists(file) {
  try {
    return (await fs.stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function download(fileId, dest) {
  const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
  const res = await fetch(url);
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || type.includes("text/html")) {
    throw new Error(`HTTP ${res.status} (${type}) — is the file shared "Anyone with the link"?`);
  }
  await ensureDir(path.dirname(dest));
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

let fetched = 0;
let failed = 0;
const queue = [...bySource.entries()];
async function worker() {
  while (queue.length) {
    const [source, fileId] = queue.shift();
    const dest = path.join(sourceRoot, source);
    if (await exists(dest)) continue;
    try {
      await download(fileId, dest);
      fetched++;
      console.log(`  ↓ ${source}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${source}: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`${fetched} downloaded, ${bySource.size - fetched - failed} already present, ${failed} failed`);
process.exit(failed ? 1 : 0);
