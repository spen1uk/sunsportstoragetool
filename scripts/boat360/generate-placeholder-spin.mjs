#!/usr/bin/env node
// Generates a clearly-labelled PLACEHOLDER 360° frame sequence.
//
// These frames are NOT photographs and are not derived from any photograph.
// They are flat-shaded renders of a generic pontoon-on-trailer model, drawn
// so the viewer's rotation, preloading and hotspot tracking can be exercised
// end-to-end before a real turntable/walk-around sequence has been shot.
// Every frame carries a "PLACEHOLDER" watermark and caption.
//
// Because we know the model's geometry, this script also emits the exact
// per-frame screen position + visibility of a set of generic anchor points
// (engine, helm, bow, trailer …). Boat configs map their hotspots onto these
// tracks while the placeholder sequence is in use.
//
// Usage:
//   node scripts/boat360/generate-placeholder-spin.mjs --slug harris-kayot-220-classic --frames 36

import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { PUBLIC_MEDIA_ROOT, GENERATED_DATA_ROOT, ensureDir, writeSpinFrame, SPIN_TIERS, toPublicUrl } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const slug = args.slug;
const frameCount = Number(args.frames ?? 36);
if (!slug) {
  console.error("Missing --slug");
  process.exit(1);
}

const W = 1600;
const H = 1200;

// ---------------------------------------------------------------------------
// Tiny 3D toolkit
// ---------------------------------------------------------------------------
const v = (x, y, z) => ({ x, y, z });
const add = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a, s) => v(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const norm = (a) => mul(a, 1 / Math.hypot(a.x, a.y, a.z));

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Split a quad into an nu × nv grid so painter's sorting behaves on big faces. */
function quadGrid(a, b, c, d, normal, color, maxSize = 2.2) {
  const lenU = Math.hypot(...Object.values(sub(b, a)));
  const lenV = Math.hypot(...Object.values(sub(d, a)));
  const nu = Math.max(1, Math.ceil(lenU / maxSize));
  const nv = Math.max(1, Math.ceil(lenV / maxSize));
  const lerp = (p, q, t) => add(p, mul(sub(q, p), t));
  const at = (u, w) => lerp(lerp(a, b, u), lerp(d, c, u), w);
  const faces = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      faces.push({
        pts: [at(i / nu, j / nv), at((i + 1) / nu, j / nv), at((i + 1) / nu, (j + 1) / nv), at(i / nu, (j + 1) / nv)],
        normal,
        color,
      });
    }
  }
  return faces;
}

/** Axis-aligned box. `color` is a hex string or { top, bottom, side }. */
function box(x0, x1, y0, y1, z0, z1, color) {
  const c = typeof color === "string" ? { top: color, bottom: color, side: color } : color;
  return [
    ...quadGrid(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1), v(0, 1, 0), c.top),
    ...quadGrid(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1), v(0, -1, 0), c.bottom),
    ...quadGrid(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), v(0, 0, 1), c.side),
    ...quadGrid(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0), v(0, 0, -1), c.side),
    ...quadGrid(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0), v(1, 0, 0), c.side),
    ...quadGrid(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), v(-1, 0, 0), c.side),
  ];
}

/**
 * Tube along the x axis from x0 to x1 (radius r, centre cy/cz), with an
 * optional tapered, raised nose cone from x1 to noseX (pontoon bow).
 */
function tubeX(x0, x1, cy, cz, r, color, nose) {
  const seg = 18;
  const faces = [];
  const ring = (x, rr, dy) => Array.from({ length: seg }, (_, i) => {
    const a = (i / seg) * Math.PI * 2;
    return v(x, cy + dy + Math.cos(a) * rr, cz + Math.sin(a) * rr);
  });
  const sections = [ring(x0, r, 0)];
  const xs = [x0];
  const bodySteps = Math.ceil((x1 - x0) / 2.2);
  for (let s = 1; s <= bodySteps; s++) {
    xs.push(x0 + ((x1 - x0) * s) / bodySteps);
    sections.push(ring(xs[xs.length - 1], r, 0));
  }
  if (nose) {
    const steps = 4;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      xs.push(x1 + (nose.x - x1) * t);
      sections.push(ring(xs[xs.length - 1], r + (nose.r - r) * t, nose.lift * t * t));
    }
  }
  for (let k = 0; k < sections.length - 1; k++) {
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const a = ((i + 0.5) / seg) * Math.PI * 2;
      faces.push({
        pts: [sections[k][i], sections[k + 1][i], sections[k + 1][j], sections[k][j]],
        normal: norm(v(k >= bodySteps ? 0.35 : 0, Math.cos(a), Math.sin(a))),
        color,
      });
    }
  }
  faces.push({ pts: [...sections[0]].reverse(), normal: v(-1, 0, 0), color });
  faces.push({ pts: sections[sections.length - 1], normal: v(1, 0, 0), color });
  return faces;
}

/** Wheel: short cylinder along z. */
function wheel(cx, cy, z0, z1, r) {
  const seg = 20;
  const faces = [];
  const ring = (z, rr) => Array.from({ length: seg }, (_, i) => {
    const a = (i / seg) * Math.PI * 2;
    return v(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z);
  });
  const r0 = ring(z0, r);
  const r1 = ring(z1, r);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const a = ((i + 0.5) / seg) * Math.PI * 2;
    faces.push({ pts: [r0[i], r1[i], r1[j], r0[j]], normal: v(Math.cos(a), Math.sin(a), 0), color: "#16181c" });
  }
  const outer = z1 > 0 ? z1 : z0;
  const inner = z1 > 0 ? z0 : z1;
  const dir = z1 > 0 ? 1 : -1;
  faces.push({ pts: ring(outer, r), normal: v(0, 0, dir), color: "#1c1f24" });
  faces.push({ pts: ring(outer + dir * 0.01, r * 0.55), normal: v(0, 0, dir), color: "#aab1ba" });
  faces.push({ pts: ring(inner, r), normal: v(0, 0, -dir), color: "#1c1f24" });
  return faces;
}

// ---------------------------------------------------------------------------
// Generic pontoon-on-trailer model (feet). +x = bow, +y = up, +z = starboard.
// ---------------------------------------------------------------------------
const C = {
  tube: "#cfd5dc",
  deckEdge: "#a3acb6",
  carpet: "#3b4f7d",
  beige: "#d8c59c",
  navy: "#1f2f5e",
  rail: "#c4cad1",
  seat: "#e6d7b6",
  canopy: "#1a2749",
  motor: "#6b7280",
  trailer: "#23272e",
};

function buildModel() {
  const f = [];
  // Trailer
  for (const z of [-3.3, 3.3]) f.push(...box(-11, 11, 1.3, 1.6, z - 0.18, z + 0.18, C.trailer));
  for (const x of [-9, -4, 1, 6, 10.5]) f.push(...box(x - 0.15, x + 0.15, 1.1, 1.3, -3.3, 3.3, C.trailer));
  f.push(...box(10.5, 15.6, 1.0, 1.3, -0.2, 0.2, C.trailer));
  f.push(...box(13.6, 13.9, 1.3, 4.4, -0.15, 0.15, C.trailer));
  for (const x of [-3.4, -1.5]) {
    f.push(...wheel(x, 0.8, 2.35, 2.95, 0.8));
    f.push(...wheel(x, 0.8, -2.35, -2.95, 0.8));
  }
  // Pontoons
  for (const z of [-3.3, 3.3]) f.push(...tubeX(-10.6, 9.4, 2.6, z, 1.0, C.tube, { x: 11.6, r: 0.35, lift: 0.7 }));
  // Deck
  f.push(...box(-11, 11.2, 3.6, 3.9, -4.3, 4.3, { top: C.carpet, bottom: C.deckEdge, side: C.deckEdge }));
  // Fence — side panels with navy stripe
  const fenceBands = [
    [3.9, 5.1, C.beige],
    [5.1, 5.7, C.navy],
    [5.7, 6.3, C.beige],
    [6.3, 6.5, C.rail],
  ];
  for (const [y0, y1, col] of fenceBands) {
    f.push(...box(-9.6, 8.6, y0, y1, 4.05, 4.18, col));
    f.push(...box(-9.6, 8.6, y0, y1, -4.18, -4.05, col));
    for (const [z0, z1] of [[-4.18, -1.0], [1.0, 4.18]]) {
      f.push(...box(8.5, 8.62, y0, y1, z0, z1, col));
      f.push(...box(-9.72, -9.6, y0, y1, z0, z1, col));
    }
  }
  // Seating
  const seat = { top: C.seat, bottom: C.seat, side: C.seat };
  for (const [z0, z1] of [[-4.0, -1.2], [1.2, 4.0]]) {
    f.push(...box(-9.5, -7.9, 3.9, 5.0, z0, z1, seat));
    f.push(...box(-9.6, -9.2, 5.0, 6.7, z0, z1, seat));
    f.push(...box(6.8, 8.45, 3.9, 5.0, z0, z1, seat));
    f.push(...box(8.1, 8.5, 5.0, 6.6, z0, z1, seat));
  }
  f.push(...box(-7.9, -1.6, 3.9, 5.0, -4.0, -2.6, seat));
  f.push(...box(-7.9, -1.6, 5.0, 6.6, -4.05, -3.7, seat));
  f.push(...box(0.8, 6.6, 3.9, 5.0, 2.6, 4.0, seat));
  f.push(...box(0.8, 6.6, 5.0, 6.6, 3.7, 4.05, seat));
  for (const x of [2.4, 4.6]) {
    f.push(...box(x, x + 1.5, 3.9, 5.0, -3.7, -2.3, seat));
    f.push(...box(x + 1.2, x + 1.5, 5.0, 6.3, -3.7, -2.3, seat));
  }
  // Helm console (starboard) + helm seat
  f.push(...box(-3.2, -1.2, 3.9, 6.1, 2.0, 3.9, { top: "#cbbd9c", bottom: "#cbbd9c", side: "#d3c4a2" }));
  f.push(...box(-3.4, -3.2, 5.9, 6.7, 2.6, 3.3, "#2a2a2a"));
  f.push(...box(-5.2, -3.8, 3.9, 5.2, 2.3, 3.7, seat));
  f.push(...box(-5.45, -5.15, 5.2, 6.5, 2.3, 3.7, seat));
  // Bimini
  f.push(...box(-8.5, -2.5, 8.6, 8.8, -4.0, 4.0, C.canopy));
  for (const x of [-7.9, -3.1]) {
    for (const z of [-4.15, 4.05]) f.push(...box(x, x + 0.14, 6.5, 8.6, z, z + 0.1, "#dfe3e8"));
  }
  // Outboard
  f.push(...box(-12.8, -11.3, 4.4, 6.6, -0.75, 0.75, C.motor));
  f.push(...box(-12.3, -11.6, 2.0, 4.4, -0.35, 0.35, "#5d636c"));
  f.push(...box(-12.6, -11.5, 1.4, 2.0, -0.3, 0.3, "#5d636c"));
  f.push(...box(-12.95, -12.75, 1.0, 2.4, -0.9, 0.9, "#e5e7eb"));
  return f;
}

// Anchor tracks exported for hotspots. Several candidate points per track:
// the most camera-facing one wins, so e.g. the trailer hotspot sits on
// whichever wheel set is facing the customer.
const ANCHORS = {
  engine: { threshold: -0.35, points: [{ p: v(-12.05, 5.7, 0), n: v(-1, 0.2, 0) }] },
  prop: { threshold: 0.3, points: [{ p: v(-12.85, 1.7, 0), n: v(-1, 0, 0) }] },
  helm: { threshold: 0.05, points: [{ p: v(-2.3, 6.3, 2.95), n: norm(v(0, 0.6, 1)) }] },
  bimini: { threshold: 0.0, points: [{ p: v(-5.5, 8.8, 0), n: v(0, 1, 0) }] },
  seating: { threshold: 0.0, points: [{ p: v(4.2, 5.5, -3.0), n: norm(v(0, 0.5, -1)) }, { p: v(3.6, 5.5, 3.3), n: norm(v(0, 0.5, 1)) }] },
  bow: { threshold: 0.0, points: [{ p: v(11.0, 4.0, 0), n: norm(v(1, 0.2, 0)) }] },
  trailer: { threshold: 0.25, points: [{ p: v(-2.45, 0.8, 3.0), n: v(0, 0, 1) }, { p: v(-2.45, 0.8, -3.0), n: v(0, 0, -1) }] },
  pontoons: { threshold: 0.35, points: [{ p: v(-4, 2.6, 4.32), n: v(0, 0, 1) }, { p: v(-4, 2.6, -4.32), n: v(0, 0, -1) }] },
};

// ---------------------------------------------------------------------------
// Camera + render
// ---------------------------------------------------------------------------
const TARGET = v(1.2, 4.2, 0);
const DIST = 52;
const ELEV = (13 * Math.PI) / 180;
const FOCAL = 2550;
const LIGHT = norm(v(-0.3, 0.85, 0.45));

function camera(azimuthDeg) {
  const a = (azimuthDeg * Math.PI) / 180;
  const pos = add(TARGET, v(DIST * Math.cos(ELEV) * Math.cos(a), DIST * Math.sin(ELEV), DIST * Math.cos(ELEV) * Math.sin(a)));
  const f = norm(sub(TARGET, pos));
  const r = norm(cross(f, v(0, 1, 0)));
  const u = cross(r, f);
  return {
    pos,
    project(p) {
      const d = sub(p, pos);
      const zc = dot(d, f);
      return { x: W / 2 + (FOCAL * dot(d, r)) / zc, y: H * 0.52 - (FOCAL * dot(d, u)) / zc, depth: zc };
    },
  };
}

function shade(hexColor, normal) {
  const k = 0.58 + 0.42 * Math.max(0, dot(normal, LIGHT));
  const [r, g, b] = hex(hexColor);
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

const MODEL = buildModel();
const ptsAttr = (pts) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

function renderFrame(frame, azimuth) {
  const cam = camera(azimuth);
  const ground = Array.from({ length: 72 }, (_, i) => {
    const a = (i / 72) * Math.PI * 2;
    return cam.project(v(1.2 + Math.cos(a) * 18, 0, Math.sin(a) * 18));
  });
  const shadow = [v(-12.5, 0.01, -4.6), v(15.5, 0.01, -1.2), v(15.5, 0.01, 1.2), v(-12.5, 0.01, 4.6)].map(cam.project);

  const polys = [];
  for (const face of MODEL) {
    const centroid = mul(face.pts.reduce(add, v(0, 0, 0)), 1 / face.pts.length);
    if (dot(face.normal, sub(cam.pos, centroid)) <= 0) continue; // back-face
    const projected = face.pts.map(cam.project);
    const depth = projected.reduce((s, p) => s + p.depth, 0) / projected.length;
    const fill = shade(face.color, face.normal);
    polys.push({ depth, svg: `<polygon points="${ptsAttr(projected)}" fill="${fill}" stroke="${fill}" stroke-width="0.8" stroke-linejoin="round"/>` });
  }
  polys.sort((a, b) => b.depth - a.depth);

  const deg = Math.round(azimuth);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e9eef5"/><stop offset="0.62" stop-color="#d5dde8"/><stop offset="1" stop-color="#bcc7d5"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <polygon points="${ptsAttr(ground)}" fill="#c5ced9" stroke="#aeb9c7" stroke-width="3"/>
  <polygon points="${ptsAttr(shadow)}" fill="rgba(15,23,42,0.18)"/>
  ${polys.map((p) => p.svg).join("\n")}
  <text x="${W / 2}" y="${H / 2 + 40}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="150" font-weight="700" fill="rgba(11,37,69,0.07)" transform="rotate(-18 ${W / 2} ${H / 2})">PLACEHOLDER</text>
  <rect x="${W / 2 - 400}" y="34" width="800" height="54" rx="27" fill="rgba(11,37,69,0.82)"/>
  <text x="${W / 2}" y="70" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="25" font-weight="700" fill="#ffffff">PLACEHOLDER FRAME ${String(frame).padStart(2, "0")}/${frameCount} · ${deg}° · NOT A PHOTOGRAPH</text>
</svg>`;
  return { svg, cam };
}

function anchorTrack(cam) {
  const out = {};
  for (const [id, anchor] of Object.entries(ANCHORS)) {
    let best = null;
    for (const pt of anchor.points) {
      const facing = dot(pt.n, norm(sub(cam.pos, pt.p)));
      if (!best || facing > best.facing) best = { facing, pt };
    }
    if (best.facing > anchor.threshold) {
      const s = cam.project(best.pt.p);
      out[id] = { x: +((s.x / W) * 100).toFixed(1), y: +((s.y / H) * 100).toFixed(1) };
    }
  }
  return out;
}

async function main() {
  const outRoot = path.join(PUBLIC_MEDIA_ROOT, slug, "360-placeholder");
  await ensureDir(outRoot);
  const tracks = Object.fromEntries(Object.keys(ANCHORS).map((id) => [id, { visibleFrames: [], positions: {} }]));

  for (let frame = 1; frame <= frameCount; frame++) {
    // Frame 1 = bow-on, rotating toward starboard (frame N/4+1 ≈ starboard side).
    const azimuth = ((frame - 1) / frameCount) * 360;
    const { svg, cam } = renderFrame(frame, azimuth);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    await writeSpinFrame(png, outRoot, frame);
    for (const [id, pos] of Object.entries(anchorTrack(cam))) {
      tracks[id].visibleFrames.push(frame);
      tracks[id].positions[frame] = pos;
    }
    process.stdout.write(`\rframe ${frame}/${frameCount}`);
  }
  process.stdout.write("\n");

  await ensureDir(GENERATED_DATA_ROOT);
  const data = {
    $comment: "GENERATED by scripts/boat360/generate-placeholder-spin.mjs — placeholder renders, not photographs. Do not edit by hand.",
    placeholder: true,
    frameCount,
    width: W,
    height: H,
    padLength: 3,
    tiers: SPIN_TIERS.map((t) => ({ name: t.name, width: t.width, urlPattern: `${toPublicUrl(path.join(outRoot, t.name))}/frame-{frame}.webp` })),
    anchorTracks: tracks,
  };
  const file = path.join(GENERATED_DATA_ROOT, `${slug}.placeholder-spin.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
