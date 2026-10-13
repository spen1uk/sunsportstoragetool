// Bot City - the 3D view. Each coin is a tower around the Vault.
//   beam   : green = in a long trade, red = short, violet pulse = setup forming, none = scanning
//   ring   : one segment per entry rule; lit segments = rules currently met
//   coins  : gold coin flies tower -> vault on a winning trade, red coin vault -> tower on a loss
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const COIN_COLORS = [0x3987e5, 0xd95926, 0x199e70, 0xc98500, 0xd55181];
const NEON = { long: 0x2bff88, short: 0xff3b5c, setup: 0x9a8cff, halted: 0xff3b3b, ringOn: 0xb9b0ff, ringOff: 0x2a2552 };
const SIGNS = [["UT BOT", "#2bff88"], ["EMA RIBBON", "#ffb020"], ["SMMA 50", "#e9e6ff"], ["STOCH RSI", "#ff4fa3"], ["1D CANDLES", "#5bd2ff"], ["PAPER $100", "#b9b0ff"]];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function windowTexture(seed, lit = 0.45) {
  const r = rng(seed), c = document.createElement("canvas");
  c.width = 64; c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#07051a"; g.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 124; y += 8) for (let x = 4; x < 60; x += 8) {
    if (r() > lit) continue;
    g.fillStyle = r() > 0.75 ? "#7ad7ff" : r() > 0.5 ? "#ffd27a" : "#fff3d6";
    g.globalAlpha = 0.55 + r() * 0.45; g.fillRect(x, y, 4, 5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.NearestFilter;
  return t;
}

function signTexture(text, color) {
  const c = document.createElement("canvas"); c.width = 512; c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(8,6,28,0.85)"; g.fillRect(0, 0, 512, 128);
  g.strokeStyle = color; g.lineWidth = 8; g.shadowColor = color; g.shadowBlur = 18; g.strokeRect(10, 10, 492, 108);
  g.fillStyle = color; g.font = "800 64px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 256, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createCity(container, { onSelect } = {}) {
  // ---------------------------------------------------------------- renderer & scene
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  if (!renderer.getContext()) throw new Error("WebGL unavailable");
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = "label-layer";
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07051a);
  scene.fog = new THREE.FogExp2(0x0b0826, 0.0085);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 900);
  camera.position.set(0, 50, 96);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.autoRotate = true; controls.autoRotateSpeed = 0.45;
  controls.maxPolarAngle = 1.38; controls.minDistance = 18; controls.maxDistance = 170; controls.target.set(0, 9, 0);

  scene.add(new THREE.HemisphereLight(0x6f5cff, 0x0a0620, 0.9));
  const key = new THREE.DirectionalLight(0xb0a6ff, 0.8); key.position.set(30, 60, 20); scene.add(key);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.05, 0.55, 0.18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---------------------------------------------------------------- ground, roads, sky
  const ground = new THREE.Mesh(new THREE.CircleGeometry(130, 96), new THREE.MeshStandardMaterial({ color: 0x120d36, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const grid = new THREE.PolarGridHelper(120, 24, 12, 96, 0x3a2f8f, 0x1d1650); grid.position.y = 0.02; scene.add(grid);
  const roads = [11, 30, 48].map((r, i) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, i === 1 ? 0.35 : 0.22, 8, 200), new THREE.MeshBasicMaterial({ color: i === 1 ? 0x7a6bff : 0x4fd2ff }));
    m.rotation.x = Math.PI / 2; m.position.y = 0.06; scene.add(m); return m;
  });

  const traffic = (() => { // glowing cars circling the roads
    const n = 180, pos = new Float32Array(n * 3), meta = [];
    for (let i = 0; i < n; i++) meta.push({ r: [30, 48, 11][i % 3] + (Math.random() - 0.5) * 0.6, a: Math.random() * Math.PI * 2, v: (0.08 + Math.random() * 0.12) * (i % 2 ? 1 : -1) });
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xe8e4ff, size: 0.7, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(pts);
    return { step(dt) { meta.forEach((m, i) => { m.a += (m.v * dt) / (m.r * 0.05); pos[i * 3] = Math.cos(m.a) * m.r; pos[i * 3 + 1] = 0.35; pos[i * 3 + 2] = Math.sin(m.a) * m.r; }); geo.attributes.position.needsUpdate = true; } };
  })();

  (() => { // stars
    const n = 900, p = new Float32Array(n * 3), r = rng(7);
    for (let i = 0; i < n; i++) { const th = r() * Math.PI * 2, ph = Math.acos(r() * 0.9), R = 380; p[i * 3] = R * Math.sin(ph) * Math.cos(th); p[i * 3 + 1] = R * Math.cos(ph); p[i * 3 + 2] = R * Math.sin(ph) * Math.sin(th); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfc8ff, size: 1.2, sizeAttenuation: false, fog: false })));
  })();

  (() => { // background skyline (instanced)
    const r = rng(42), n = 340, tex = windowTexture(3, 0.35);
    tex.repeat.set(1, 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1446, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.55, roughness: 0.8 });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let k = 0;
    while (k < n) {
      const a = r() * Math.PI * 2, d = 34 + r() * 80;
      if (Math.abs(d - 48) < 3 || Math.abs(d - 30) < 3) continue; // keep roads clear
      const h = 2 + Math.pow(r(), 2.2) * (d > 60 ? 26 : 12), w = 1.5 + r() * 3;
      s.set(w, h, 1.5 + r() * 3); p.set(Math.cos(a) * d, h / 2, Math.sin(a) * d);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI); m4.compose(p, q, s); mesh.setMatrixAt(k++, m4);
    }
    scene.add(mesh);
  })();

  SIGNS.forEach(([text, col], i) => { // floating neon signs (Calvin's indicators)
    const a = (i / SIGNS.length) * Math.PI * 2 + 0.3, d = 58, y = 14 + (i % 2) * 6;
    const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: signTexture(text, col), transparent: true, color: 0xb8b8b8 })); // always faces the camera
    sign.scale.set(14, 3.5, 1); sign.position.set(Math.cos(a) * d, y, Math.sin(a) * d); scene.add(sign);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, y - 1.7, 6), new THREE.MeshBasicMaterial({ color: 0x2a2552 }));
    pole.position.set(sign.position.x, (y - 1.7) / 2, sign.position.z); scene.add(pole);
  });

  // ---------------------------------------------------------------- the vault
  const vault = new THREE.Group(); scene.add(vault);
  vault.add(new THREE.Mesh(new THREE.CylinderGeometry(6.5, 7, 1.4, 48), new THREE.MeshStandardMaterial({ color: 0x1b1550, emissive: 0x2a1f7a, emissiveIntensity: 0.4 })));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4.6, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xfff0d8, emissive: 0xffe2b0, emissiveIntensity: 1.25 }));
  dome.position.y = 0.7; vault.add(dome);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2, col = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.6, 8), new THREE.MeshStandardMaterial({ color: 0x8a5a3c, emissive: 0x3a1f10 }));
    col.position.set(Math.cos(a) * 5.4, 2.4, Math.sin(a) * 5.4); vault.add(col);
  }
  const vaultRing = new THREE.Mesh(new THREE.TorusGeometry(7.2, 0.12, 8, 96), new THREE.MeshBasicMaterial({ color: 0x5bd2ff }));
  vaultRing.rotation.x = Math.PI / 2; vaultRing.position.y = 0.8; vault.add(vaultRing);
  const vaultLabelEl = document.createElement("div"); vaultLabelEl.className = "city-label vault-label";
  const vaultLabel = new CSS2DObject(vaultLabelEl); vaultLabel.position.set(0, 10, 0); vault.add(vaultLabel);

  // ---------------------------------------------------------------- towers
  const towers = new Map(); // symbol -> tower
  const pickables = [];
  const tierMat = (seed) => new THREE.MeshStandardMaterial({ color: 0x17123f, emissive: 0xffffff, emissiveMap: windowTexture(seed, 0.5), emissiveIntensity: 0.85, roughness: 0.6 });

  function buildTower(w, idx, total) {
    const a = -Math.PI / 2 + (idx / Math.max(total, 1)) * Math.PI * 2, R = 21;
    const g = new THREE.Group(); g.position.set(Math.cos(a) * R, 0, Math.sin(a) * R); scene.add(g);
    const col = COIN_COLORS[(w.slot - 1) % COIN_COLORS.length];
    const tiers = [[6, 9], [4.6, 7], [3.4, 5], [2, 3]];
    let y = 0;
    for (const [sz, h] of tiers) {
      const m = tierMat(w.slot * 11 + h); m.emissiveMap.repeat.set(sz / 4, h / 6);
      const box = new THREE.Mesh(new THREE.BoxGeometry(sz, h, sz), m); box.position.y = y + h / 2; box.userData.symbol = w.symbol;
      g.add(box); pickables.push(box);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: col }));
      edges.position.copy(box.position); g.add(edges);
      y += h;
    }
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.35, 6, 8), new THREE.MeshBasicMaterial({ color: col }));
    spire.position.y = y + 3; g.add(spire);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), new THREE.MeshBasicMaterial({ color: col })); tip.position.y = y + 6.2; g.add(tip);
    const pad = new THREE.Mesh(new THREE.TorusGeometry(5.2, 0.16, 8, 64), new THREE.MeshBasicMaterial({ color: col }));
    pad.rotation.x = Math.PI / 2; pad.position.y = 0.1; g.add(pad);
    const top = y;

    // road to the vault
    const toVault = new THREE.Vector3(-g.position.x, 0, -g.position.z).normalize();
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3().addScaledVector(toVault, 5.2).setY(0.12), new THREE.Vector3().addScaledVector(toVault, R - 7.4).setY(0.12)]);
    g.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.6 })));

    // charge ring (rebuilt when the rule count changes)
    const ring = new THREE.Group(); ring.position.y = top + 2.2; g.add(ring);
    // beam
    const beam = new THREE.Group(); beam.position.y = top + 6;
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 180, 24, 1, true), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 180, 12, 1, true), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    outer.position.y = core.position.y = 90; beam.add(outer, core); g.add(beam);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.12, 8, 64), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }));
    halo.rotation.x = Math.PI / 2; halo.position.y = top + 6; g.add(halo);

    const el = document.createElement("div"); el.className = "city-label";
    el.addEventListener("click", () => select(w.symbol, true));
    const label = new CSS2DObject(el); label.position.y = top + 8.5; g.add(label);
    const t = { group: g, ring, ringCount: -1, beam, outer, core, halo, el, top, color: col, symbol: w.symbol, state: null, pad };
    towers.set(w.symbol, t);
    return t;
  }

  function setRing(t, checklist) {
    if (t.ringCount !== checklist.length) {
      t.ring.clear(); t.ringCount = checklist.length;
      const n = Math.max(1, checklist.length), gap = 0.18, arc = (Math.PI * 2) / n - gap;
      for (let i = 0; i < n; i++) {
        const seg = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.28, 8, 32, arc), new THREE.MeshBasicMaterial({ color: NEON.ringOff }));
        seg.rotation.x = Math.PI / 2; seg.rotation.z = i * (arc + gap); t.ring.add(seg);
      }
    }
    checklist.forEach((c, i) => t.ring.children[i] && t.ring.children[i].material.color.setHex(c.ok ? NEON.ringOn : NEON.ringOff));
  }

  // ---------------------------------------------------------------- coins (money flowing to the vault)
  const coins = [];
  const coinGeo = new THREE.CylinderGeometry(0.9, 0.9, 0.22, 24);
  function spawnCoin(symbol, win, delay = 0) {
    const t = towers.get(symbol); if (!t) return;
    const from = t.group.position.clone().setY(t.top + 2), to = new THREE.Vector3(0, 6, 0);
    const m = new THREE.Mesh(coinGeo, new THREE.MeshBasicMaterial({ color: win ? 0xffcf4a : 0xff3b5c }));
    m.visible = false; scene.add(m);
    coins.push({ m, a: win ? from : to, b: win ? to : from, t: -delay, dur: 2.4 });
  }
  function stepCoins(dt) {
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i]; c.t += dt;
      if (c.t < 0) continue;
      const k = Math.min(1, c.t / c.dur);
      c.m.visible = true;
      c.m.position.lerpVectors(c.a, c.b, k); c.m.position.y += Math.sin(k * Math.PI) * 14;
      c.m.rotation.x += dt * 6; c.m.rotation.z += dt * 3;
      if (k >= 1) { scene.remove(c.m); c.m.material.dispose(); coins.splice(i, 1); }
    }
  }

  // ---------------------------------------------------------------- state -> scene
  let seen = null, last = null;
  function update(s) {
    last = s;
    const syms = s.workers.map((w) => w.symbol);
    if ([...towers.keys()].join() !== syms.join()) {
      towers.forEach((t) => scene.remove(t.group)); towers.clear(); pickables.length = 0;
      s.workers.forEach((w, i) => buildTower(w, i, s.workers.length));
    }
    for (const w of s.workers) {
      const t = towers.get(w.symbol);
      setRing(t, w.checklist);
      const kind = w.status_kind, side = w.position && w.position.side;
      t.state = kind === "manage" ? (side === "SHORT" ? "short" : "long") : kind === "fire" || kind === "setup" ? "setup" : kind === "halted" ? "halted" : null;
      const col = t.state ? NEON[t.state] : 0x000000;
      t.outer.material.color.setHex(col); t.core.material.color.setHex(col); t.halo.material.color.setHex(col);
      t.beam.visible = t.halo.visible = !!t.state;
      const earned = w.all.earned, pos = w.position;
      t.el.innerHTML = `<div class="cl-name" style="--c:#${t.color.toString(16).padStart(6, "0")}"><i></i>${w.name}</div>
        <div class="cl-status s-${kind}">${w.status}</div>
        <div class="cl-row">${Math.round(w.charge * 100)}% charged</div>
        ${pos ? `<div class="cl-row ${pos.upnl >= 0 ? "up" : "down"}">open ${pos.upnl >= 0 ? "+" : "−"}$${Math.abs(pos.upnl).toFixed(2)}</div>` : ""}
        <div class="cl-row ${earned > 0 ? "up" : earned < 0 ? "down" : ""}">earned ${earned >= 0 ? "+" : "−"}$${Math.abs(earned).toFixed(2)}</div>`;
    }
    const v = s.vault;
    vaultLabelEl.innerHTML = `<div class="vl-k">THE VAULT</div><div class="vl-v">$${v.equity.toFixed(2)}</div>
      <div class="vl-s ${v.today > 0 ? "up" : v.today < 0 ? "down" : ""}">today ${v.today >= 0 ? "+" : "−"}$${Math.abs(v.today).toFixed(2)}</div>
      <div class="vl-s">${s.workers.length} workers on shift</div>`;
    // money flow for trades we haven't seen yet
    const ids = new Set(s.trades.map((t) => t.id));
    if (seen) {
      s.trades.filter((t) => !seen.has(t.id)).forEach((t, i) => spawnCoin(t.symbol, t.pnl > 0, i * 0.6));
    } else if (s.demo) {
      s.trades.slice(0, 4).forEach((t, i) => spawnCoin(t.symbol, t.pnl > 0, 1 + i * 0.9)); // show the effect in demo mode
    }
    seen = ids;
  }

  // ---------------------------------------------------------------- picking & focus
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let focus = null, downAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; // a drag, not a click
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (hit) select(hit.object.userData.symbol, true);
  });
  function select(symbol, notify = false) {
    focus = symbol ? towers.get(symbol) || null : null;
    towers.forEach((t) => t.pad.scale.setScalar(t === focus ? 1.25 : 1));
    if (notify && symbol && onSelect) onSelect(symbol);
  }

  // ---------------------------------------------------------------- loop
  let active = true, raf = 0;
  const clock = new THREE.Clock(), goal = new THREE.Vector3(0, 9, 0);
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    traffic.step(dt); stepCoins(dt);
    roads[1].material.color.setHSL(0.69, 0.9, 0.55 + Math.sin(t * 1.5) * 0.08);
    vaultRing.rotation.z += dt * 0.3;
    towers.forEach((tw) => {
      tw.ring.rotation.y += dt * 0.6;
      if (tw.state === "setup") { const p = 0.5 + Math.sin(t * 3 + tw.top) * 0.5; tw.outer.material.opacity = 0.06 + p * 0.14; tw.core.material.opacity = 0.25 + p * 0.5; }
      else if (tw.state) { tw.outer.material.opacity = 0.2; tw.core.material.opacity = 0.9; }
      tw.halo.scale.setScalar(1 + Math.sin(t * 2.4) * 0.08);
    });
    goal.copy(focus ? focus.group.position.clone().setY(10) : new THREE.Vector3(0, 9, 0));
    controls.target.lerp(goal, 0.06);
    controls.update(dt);
    composer.render(); labels.render(scene, camera);
  }
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h); labels.setSize(w, h); composer.setSize(w, h); bloom.setSize(w, h);
    camera.aspect = w / h; camera.fov = w < 700 ? 64 : 50; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container); resize();
  frame();

  return {
    update,
    select: (sym) => select(sym, false),
    setAutoRotate: (on) => (controls.autoRotate = on),
    setActive(on) {
      if (on === active) return; active = on;
      if (on) { clock.getDelta(); frame(); resize(); } else cancelAnimationFrame(raf);
    },
  };
}
