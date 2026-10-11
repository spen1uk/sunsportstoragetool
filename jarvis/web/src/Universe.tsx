import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { api, type Agent } from './api.ts';
import { speechState } from './speech.ts';

export type CoreState = 'idle' | 'working' | 'thinking' | 'speaking' | 'urgent' | 'blocked' | 'disconnected' | 'paused';
export type Route = { level: 'universe' | 'system' | 'dept'; systemId?: string; deptId?: string };
type Pos = Record<string, { x: number; y: number }>;
type Props = {
  agents: Agent[]; coreState: CoreState; quality: 'low' | 'medium' | 'high'; reducedMotion: boolean; route: Route;
  active: Set<string>; navigate: (hash: string) => void; layoutVersion: number;
};

const DEFAULTS: Pos = { ssm: { x: -40, y: 8 }, proj: { x: 38, y: 10 }, investing: { x: -22, y: -26 }, trading: { x: 22, y: -26 }, health: { x: 2, y: 30 } };
const SYS_COLORS = [0xffb86b, 0x6bd0ff, 0x9d8bff, 0x6bffb0, 0xff7aa8, 0xf0e26b];
const STATE_COLORS: Record<CoreState, number> = { idle: 0x4db8ff, working: 0x44f0d0, thinking: 0xb7a6ff, speaking: 0x9fe8ff, urgent: 0xff5a5f, blocked: 0xffb347, disconnected: 0x6a7684, paused: 0xc98a3a };
const TILT = -0.95;

function glowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(80,160,255,0)') {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!; const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(0.25, 'rgba(120,190,255,0.55)'); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
}
function sunTexture(color: number) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d')!;
  const base = new THREE.Color(color); g.fillStyle = `#${base.getHexString()}`; g.fillRect(0, 0, 256, 128);
  let seed = color; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.12})`; g.beginPath(); g.ellipse(rnd() * 256, rnd() * 128, 6 + rnd() * 22, 3 + rnd() * 9, 0, 0, 7); g.fill(); }
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.12})`; g.beginPath(); g.ellipse(rnd() * 256, rnd() * 128, 4 + rnd() * 12, 2 + rnd() * 6, 0, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; return t;
}

const NOISE = `
float h3(vec3 p){ p=fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float n3(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.-2.*f);
  return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm(vec3 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*n3(p); p*=2.02; a*=.5; } return s; }
`;

/** Deep-space nebula on a huge inverted sphere that follows the camera (reads as infinitely far away). */
function nebulaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } }, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec3 vD; void main(){ vD=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec3 vD; uniform float uTime; ${NOISE}
      void main(){ vec3 d=normalize(vD); float n=fbm(d*2.2+vec3(uTime*0.004)); float m=fbm(d*4.6-vec3(uTime*0.006)+7.);
        float cloud=smoothstep(.40,.86,n);
        vec3 c=mix(vec3(.02,.07,.26), vec3(.34,.10,.55), smoothstep(.30,.90,m));
        c=mix(c, vec3(.04,.50,.65), smoothstep(.55,.95,n*m*1.7));
        gl_FragColor=vec4(c*cloud*.17, 1.); }`,
  });
}

/** Animated plasma surface: domain-warped noise + limb glow. */
function sunMaterial(color: number, planned: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uAlpha: { value: planned ? 0.72 : 1 } }, transparent: planned,
    vertexShader: 'varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec3 vN; varying vec3 vP; uniform float uTime; uniform vec3 uColor; uniform float uAlpha; ${NOISE}
      void main(){ vec3 p=vP*.55; float w=fbm(p*2.+uTime*.12); float n=fbm(p*3.4+w*1.8+vec3(0.,0.,uTime*.10));
        float limb=pow(1.-max(dot(vN,vec3(0.,0.,1.)),0.),2.2);
        vec3 hot=mix(uColor*1.25, vec3(1.,.95,.82), .28);
        vec3 c=mix(uColor*.38, hot, smoothstep(.2,.8,n))*1.3 + uColor*limb*1.4;
        gl_FragColor=vec4(c, uAlpha); }`,
  });
}

/** Fresnel atmosphere shell (drawn on a slightly larger back-face sphere). */
function atmosphereMaterial(color: number, strength = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uK: { value: strength } }, side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: 'varying vec3 vN; void main(){ vN=normalize(normalMatrix*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec3 vN; uniform vec3 uColor; uniform float uK; void main(){ float i=pow(max(0.72-dot(vN,vec3(0.,0.,1.)),0.),3.4)*1.5*uK; gl_FragColor=vec4(uColor*i, i); }',
  });
}

function flareTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d')!; g.translate(128, 128);
  for (let i = 0; i < 8; i++) { g.rotate(Math.PI / 4); const gr = g.createLinearGradient(0, 0, 124, 0); gr.addColorStop(0, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, -2.2); g.lineTo(124, 0); g.lineTo(0, 2.2); g.fill(); }
  return new THREE.CanvasTexture(c);
}

export function Universe(props: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const P = useRef(props); P.current = props;
  const positions = useRef<Pos>({ ...DEFAULTS });
  const hovered = useRef<string | null>(null);
  const dragged = useRef(false);
  const api3 = useRef<{ toWorld: (cx: number, cy: number) => THREE.Vector3 | null } | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  // Load saved layout (shared across computers via the server). Re-run when reset.
  useEffect(() => {
    api<Pos>('/api/layout').then((l) => { positions.current = { ...DEFAULTS, ...l }; }).catch(() => { /* defaults */ });
  }, [props.layoutVersion]);

  useEffect(() => {
    const el = mount.current!, lab = labels.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x01030a, 1); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.85; el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x02040a, 0.0016);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    const camGoal = new THREE.Vector3(0, -34, 92), lookGoal = new THREE.Vector3(), look = new THREE.Vector3();
    camera.position.copy(camGoal);
    scene.add(new THREE.AmbientLight(0x8fa6d8, 1.25));
    // Bloom makes every additive glow (corona, ring, suns, links) bleed light like a real HDR scene. Off on "low".
    let composer: EffectComposer | null = null;
    const buildComposer = (q: string) => {
      composer?.dispose(); composer = null; if (q === 'low') return;
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      composer = new EffectComposer(renderer); composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h);
      composer.addPass(new RenderPass(scene, camera));
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), q === 'high' ? 0.7 : 0.5, 0.55, 0.62));
      composer.addPass(new OutputPass());
    };

    // --- deep space: nebula + three layers of twinkling stars (both follow the camera, with a little parallax) ---
    const nebula = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 32), nebulaMaterial()); nebula.renderOrder = -10; nebula.frustumCulled = false; scene.add(nebula);
    const N = 3200, sp = new Float32Array(N * 3), sS = new Float32Array(N), sPh = new Float32Array(N), sC = new Float32Array(N * 3);
    const tints = [[0.75, 0.85, 1], [1, 0.92, 0.8], [0.6, 0.78, 1], [1, 0.75, 0.7]];
    for (let k = 0; k < N; k++) {
      const r = 800, a = Math.random() * 6.283, b = Math.acos(2 * Math.random() - 1);
      sp.set([r * Math.sin(b) * Math.cos(a), r * Math.sin(b) * Math.sin(a), r * Math.cos(b)], k * 3);
      const tier = Math.random(); sS[k] = tier > 0.985 ? 4.2 : tier > 0.9 ? 2.4 : 1.3; sPh[k] = Math.random(); sC.set(tints[(Math.random() * tints.length) | 0], k * 3);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('aS', new THREE.BufferAttribute(sS, 1)); sg.setAttribute('aP', new THREE.BufferAttribute(sPh, 1)); sg.setAttribute('aC', new THREE.BufferAttribute(sC, 3));
    const starU = { uTime: { value: 0 }, uScale: { value: 1 } };
    const stars = new THREE.Points(sg, new THREE.ShaderMaterial({ uniforms: starU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'attribute float aS; attribute float aP; attribute vec3 aC; uniform float uTime; uniform float uScale; varying vec3 vC; varying float vA; void main(){ vC=aC; vA=.5+.5*sin(uTime*(.5+aP*1.5)+aP*60.); gl_PointSize=aS*uScale; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: 'varying vec3 vC; varying float vA; void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard; float a=pow(1.-d*2.,1.5)*(.35+.65*vA); gl_FragColor=vec4(vC*(1.+a), a); }' }));
    stars.frustumCulled = false; scene.add(stars);

    // --- Jarvis core ---
    const core = new THREE.Group(); core.scale.setScalar(1.6); scene.add(core);
    core.add(new THREE.Mesh(new THREE.SphereGeometry(3.2, 48, 32), new THREE.MeshBasicMaterial({ color: 0x000000 })));
    const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: STATE_COLORS.idle, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.42 }));
    corona.scale.set(21, 21, 1); core.add(corona);
    const tilt = new THREE.Group(); tilt.rotation.x = TILT; core.add(tilt);
    const ringU = { uTime: { value: 0 }, uColor: { value: new THREE.Color(STATE_COLORS.idle) }, uFine: { value: 0.15 }, uGain: { value: 1 } };
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.9, 9.5, 160, 1), new THREE.ShaderMaterial({
      uniforms: ringU, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vP; void main(){ vP=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `varying vec2 vP; uniform float uTime; uniform vec3 uColor; uniform float uFine; uniform float uGain;
        void main(){ float r=length(vP); float t=clamp((r-3.9)/5.6,0.,1.); float a=atan(vP.y,vP.x);
          float sw=0.5+0.5*sin(a*7.+uTime*1.6-r*1.7); float fine=0.5+0.5*sin(a*23.-uTime*2.3+r*5.);
          float dop=0.55+0.75*max(0.,cos(a-0.6)); float I=pow(1.-t,0.95)*(0.38+0.5*sw+uFine*fine)*smoothstep(0.,0.05,t)*(1.-smoothstep(.7,1.,t))*uGain*dop*1.15;
          vec3 c=mix(uColor*0.85,vec3(1.,.93,.78),pow(1.-t,3.2)); gl_FragColor=vec4(c*2.0,I*1.0);} `,
    }));
    tilt.add(ring);
    // Gravitational-lens halo: a camera-facing photon ring with a soft glow, like the light bent around the black hole.
    const halo = new THREE.Mesh(new THREE.RingGeometry(3.1, 7, 160, 1), new THREE.ShaderMaterial({
      uniforms: ringU, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vP; void main(){ vP=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: 'varying vec2 vP; uniform vec3 uColor; uniform float uGain; void main(){ float r=length(vP); float ph=exp(-pow((r-3.42)*9.0,2.)); float soft=exp(-(r-3.1)*1.3)*.10; float I=(ph*0.85+soft)*uGain; gl_FragColor=vec4(mix(uColor,vec3(1.),.6)*I, I*.9); }' }));
    halo.renderOrder = 2; core.add(halo);
    for (const r of [13, 18, 24]) {
      const pts = Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.cos((i / 128) * 6.2832) * r, Math.sin((i / 128) * 6.2832) * r, 0));
      tilt.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x2f7fb8, transparent: true, opacity: 0.22 })));
    }
    const pu = { uTime: { value: 0 }, uColor: { value: new THREE.Color(STATE_COLORS.idle) }, uScale: { value: 400 } };
    let particles: THREE.Points | null = null; let particleQ = '';
    const buildParticles = (n: number) => {
      if (particles) { tilt.remove(particles); particles.geometry.dispose(); }
      const g = new THREE.BufferGeometry(), R = new Float32Array(n), V = new Float32Array(n), A = new Float32Array(n), H = new Float32Array(n), pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { R[i] = Math.random() * 12; V[i] = 0.25 + Math.random() * 0.6; A[i] = Math.random() * 6.283; H[i] = (Math.random() - 0.5) * 0.9; }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aR', new THREE.BufferAttribute(R, 1));
      g.setAttribute('aV', new THREE.BufferAttribute(V, 1)); g.setAttribute('aA', new THREE.BufferAttribute(A, 1)); g.setAttribute('aH', new THREE.BufferAttribute(H, 1));
      particles = new THREE.Points(g, new THREE.ShaderMaterial({
        uniforms: pu, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        vertexShader: `attribute float aR; attribute float aV; attribute float aA; attribute float aH; uniform float uTime; uniform float uScale; varying float vF;
          void main(){ float span=12.; float rr=mod(aR-uTime*aV*1.4,span); float r=4.2+rr; float ang=aA+uTime*(2.2/(r*0.35+1.))*aV;
            vF=smoothstep(0.,1.5,rr)*(1.-smoothstep(span-2.5,span,rr));
            vec4 mv=modelViewMatrix*vec4(cos(ang)*r,sin(ang)*r,aH,1.); gl_PointSize=(0.38+aV*0.55)*uScale/-mv.z; gl_Position=projectionMatrix*mv; }`,
        fragmentShader: 'uniform vec3 uColor; varying float vF; void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard; gl_FragColor=vec4(mix(uColor,vec3(1.),.2),(1.-d*2.)*vF*.5);}',
      }));
      particles.frustumCulled = false; tilt.add(particles);
    };

    // --- systems ---
    type Sys = { id: string; group: THREE.Group; sun: THREE.Mesh; sunU: { uTime: { value: number } }; flare: THREE.Sprite; glow: THREE.Sprite; light: THREE.PointLight; planets: { id: string; mesh: THREE.Mesh; r: number; phase: number; speed: number; ring: THREE.LineLoop; comet: THREE.Sprite }[]; pulse?: THREE.Mesh };
    const systems = new Map<string, Sys>(); let builtKey = '';
    const flareTex = flareTexture();
    const links = new Map<string, THREE.Line>();
    const disposeSystems = () => { for (const s of systems.values()) { scene.remove(s.group); s.group.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); } systems.clear(); for (const l of links.values()) { scene.remove(l); l.geometry.dispose(); } links.clear(); };
    const buildSystems = (agents: Agent[]) => {
      disposeSystems();
      const mgrs = agents.filter((a) => a.role === 'manager');
      mgrs.forEach((m, i) => {
        const color = SYS_COLORS[i % SYS_COLORS.length], planned = m.status_kind === 'planned';
        const group = new THREE.Group(); scene.add(group);
        const sunMat = sunMaterial(color, planned); const sun = new THREE.Mesh(new THREE.SphereGeometry(2.4, 48, 32), sunMat);
        group.add(sun);
        const sunAtm = new THREE.Mesh(new THREE.SphereGeometry(2.4 * 1.35, 32, 24), atmosphereMaterial(color, planned ? 0.35 : 0.7)); group.add(sunAtm);
        const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: planned ? 0.16 : 0.38 })); flare.scale.set(15, 15, 1); group.add(flare);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,255,255,0.9)', 'rgba(0,0,0,0)'), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: planned ? 0.22 : 0.5 }));
        glow.scale.set(9, 9, 1); group.add(glow);
        const light = new THREE.PointLight(color, planned ? 160 : 260, 60, 1.2); group.add(light);
        const emps = agents.filter((a) => a.parent_id === m.id);
        const planets = emps.map((e, j) => {
          const r = 5.6 + j * 2.1, ep = e.status_kind === 'planned';
          const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.85, 24, 18), new THREE.MeshLambertMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0x88aaee), 0.35), transparent: ep, opacity: ep ? 0.6 : 1 }));
          group.add(mesh);
          const atm = new THREE.Mesh(new THREE.SphereGeometry(0.85 * 1.28, 24, 18), atmosphereMaterial(new THREE.Color(color).lerp(new THREE.Color(0x66ccff), 0.5).getHex(), ep ? 0.45 : 0.8)); mesh.add(atm);
          const comet = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,255,255,1)', 'rgba(0,0,0,0)'), color: 0xcfeaff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: ep ? 0.4 : 0.9 })); comet.scale.set(0.9, 0.9, 1); group.add(comet);
          const pts = Array.from({ length: 97 }, (_, k) => new THREE.Vector3(Math.cos((k / 96) * 6.2832) * r, Math.sin((k / 96) * 6.2832) * r, 0));
          const og = new THREE.BufferGeometry().setFromPoints(pts);
          const rg = new THREE.LineLoop(og, ep ? new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.5, transparent: true, opacity: 0.35 }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
          if (ep) rg.computeLineDistances();
          group.add(rg);
          return { id: e.id, mesh, r, phase: j * 1.7 + i, speed: 0.35 / Math.sqrt(r / 5), ring: rg, comet };
        });
        const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: 0xbfe9ff })); pulse.visible = false; scene.add(pulse);
        systems.set(m.id, { id: m.id, group, sun, sunU: sunMat.uniforms as any, flare, glow, light, planets, pulse });
        const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]); const ln = new THREE.Line(lg, new THREE.LineDashedMaterial({ color, dashSize: 1.3, gapSize: 1.0, transparent: true, opacity: planned ? 0.25 : 0.6, blending: THREE.AdditiveBlending, depthWrite: false })); scene.add(ln); links.set(m.id, ln);
      });
    };

    // --- labels (DOM, positioned from 3D each frame; stable pixel size, generous hit area) ---
    const els = new Map<string, HTMLElement>();

    const raycaster = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    api3.current = { toWorld: (cx, cy) => {
      const r = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      const out = new THREE.Vector3(); return raycaster.ray.intersectPlane(plane, out) ? out : null;
    } };

    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); composer?.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();

    const clock = new THREE.Clock(); let raf = 0, tAcc = 0, lastRender = 0; const tmp = new THREE.Vector3(), cur = new THREE.Color(STATE_COLORS.idle), goalC = new THREE.Color();
    const sysWorld = (id: string) => { const p = positions.current[id] ?? { x: 0, y: 0 }; return tmp.set(p.x, p.y, 0); };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const p = P.current, dt = Math.min(clock.getDelta(), 0.1), reduced = p.reducedMotion;
      if (reduced && performance.now() - lastRender < 100) return;
      lastRender = performance.now();
      const key = p.agents.map((a) => a.id + a.status_kind).join('|');
      if (key !== builtKey && p.agents.length) { builtKey = key; buildSystems(p.agents); }
      const qn = p.quality === 'low' ? 1200 : p.quality === 'medium' ? 3500 : 8000;
      if (particleQ !== p.quality) { particleQ = p.quality; buildParticles(qn); renderer.setPixelRatio(Math.min(window.devicePixelRatio, p.quality === 'low' ? 1 : p.quality === 'medium' ? 1.5 : 2)); starU.uScale.value = renderer.getPixelRatio(); resize(); buildComposer(p.quality); }
      pu.uScale.value = renderer.domElement.height / 2.2;
      const speed = reduced ? 0 : 1;
      tAcc += dt * speed * (p.coreState === 'working' ? 1.8 : p.coreState === 'urgent' ? 1.4 : p.coreState === 'thinking' ? 1.2 : p.coreState === 'paused' || p.coreState === 'disconnected' ? 0.25 : 1);
      ringU.uTime.value = tAcc; pu.uTime.value = tAcc;
      goalC.setHex(STATE_COLORS[p.coreState]); cur.lerp(goalC, 1 - Math.exp(-dt * 4)); ringU.uColor.value.copy(cur); pu.uColor.value.copy(cur); (corona.material as THREE.SpriteMaterial).color.copy(cur);
      // Per-state motion. Speaking follows REAL speech-synthesis events (start / word boundaries / end), decaying between words.
      const tNow = performance.now(), st = p.coreState; let pulse = 1, gain = 1, fine = 0.15;
      speechState.level *= Math.exp(-dt * 5);
      if (st === 'thinking') { pulse = 1 + 0.07 * Math.sin(tNow / 220); tilt.rotation.z += dt * 0.5 * speed; gain = 1.05; }
      else if (st === 'working') { fine = 0.55; gain = 1.15; }                                  // executing: busier, finer energy pattern
      else if (st === 'speaking') { pulse = 1 + 0.12 * speechState.level; gain = 1 + 0.5 * speechState.level; fine = 0.3; }
      else if (st === 'urgent') { pulse = 1 + 0.1 * Math.abs(Math.sin(tNow / 170)); gain = 1.25; fine = 0.4; }
      else if (st === 'blocked') pulse = 1 + 0.05 * Math.sin(tNow / 600);
      else if (st === 'idle') pulse = 1 + 0.015 * Math.sin(tNow / 1800);                         // gentle, continuous
      if (reduced) { pulse = 1; fine = 0.15; }
      ringU.uFine.value = fine; ringU.uGain.value = gain;
      corona.scale.setScalar(21 * pulse * (st === 'disconnected' ? 0.7 : 1));
      // Background sits at infinity (follows camera) with a hint of parallax; everything shimmers slowly.
      nebula.position.copy(camera.position); stars.position.copy(camera.position);
      nebula.rotation.y = camera.position.x * 0.0004; stars.rotation.y = camera.position.x * 0.0009; stars.rotation.x = camera.position.y * 0.0006;
      (nebula.material as THREE.ShaderMaterial).uniforms.uTime.value = tAcc; starU.uTime.value = tAcc;
      halo.lookAt(camera.position);

      // route → camera goal
      const rt = p.route; let focusPlanet: THREE.Object3D | null = null;
      if (rt.level === 'universe') { camGoal.set(0, -34, 92); lookGoal.set(0, 0, 0); }
      else if (rt.systemId && systems.has(rt.systemId)) {
        const c = sysWorld(rt.systemId);
        if (rt.level === 'dept' && rt.deptId) {
          const pl = systems.get(rt.systemId)!.planets.find((x) => x.id === rt.deptId);
          if (pl) { focusPlanet = pl.mesh; const wp = pl.mesh.getWorldPosition(new THREE.Vector3()); lookGoal.copy(wp); camGoal.set(wp.x - 1.6, wp.y - 3.2, wp.z + 5.2); }
        } else { lookGoal.copy(c); camGoal.set(c.x, c.y - 17, 27); }
      }
      const k = reduced ? 1 : 1 - Math.exp(-dt * 3.2);
      camera.position.lerp(camGoal, k); look.lerp(lookGoal, k); camera.lookAt(look);

      // systems
      const focusedSys = rt.level === 'universe' ? null : rt.systemId;
      for (const [sid, s] of systems) {
        const base = positions.current[sid] ?? { x: 0, y: 0 };
        s.group.position.lerp(tmp.set(base.x, base.y, 0), reduced ? 1 : 1 - Math.exp(-dt * 12));
        s.sun.rotation.y += dt * 0.15 * speed; s.sunU.uTime.value = tAcc; (s.flare.material as THREE.SpriteMaterial).rotation += dt * 0.05 * speed;
        const slow = hovered.current === sid || (focusedSys === sid && rt.level === 'dept') ? 0.12 : 1;
        s.planets.forEach((pl) => {
          pl.phase += dt * pl.speed * slow * speed;
          pl.mesh.position.set(Math.cos(pl.phase) * pl.r, Math.sin(pl.phase) * pl.r, 0);
          pl.mesh.rotation.y += dt * 0.5 * speed;
          const ca = pl.phase * 2.6 + 1; pl.comet.position.set(Math.cos(ca) * pl.r, Math.sin(ca) * pl.r, 0);
        });
        const dim = focusedSys && focusedSys !== sid ? 0.25 : 1;
        (s.glow.material as THREE.SpriteMaterial).opacity = (p.agents.find((a) => a.id === sid)?.status_kind === 'planned' ? 0.22 : 0.5) * dim;
        const ln = links.get(sid)!; const pa = ln.geometry.attributes.position as THREE.BufferAttribute;
        pa.setXYZ(0, 0, 0, 0); pa.setXYZ(1, s.group.position.x, s.group.position.y, 0); pa.needsUpdate = true;
        ln.computeLineDistances(); { const ld = ln.geometry.attributes.lineDistance as THREE.BufferAttribute, off = (tAcc * 2.5) % 2.3; ld.setX(0, -off); ld.setX(1, ld.getX(1) - off); ld.needsUpdate = true; } // light flowing along the data link
        // Communication pulse only while that system has real running work.
        if (s.pulse) { const on = p.active.has(sid) && !reduced; s.pulse.visible = on; if (on) { const u = (tAcc * 0.45) % 1; s.pulse.position.set(s.group.position.x * u, s.group.position.y * u, 0); } }
      }

      // project labels
      const w = el.clientWidth, h = el.clientHeight, v = new THREE.Vector3();
      const place = (id: string, world: THREE.Vector3, show: boolean) => {
        let e = els.get(id); if (!e || !e.isConnected) { e = lab.querySelector<HTMLElement>(`[data-node="${id}"]`) ?? undefined; if (e) els.set(id, e); } if (!e) return; v.copy(world).project(camera);
        const vis = show && v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
        e.style.visibility = vis ? 'visible' : 'hidden'; if (vis) e.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
      };
      place('jarvis', new THREE.Vector3(0, 0, 0), true);
      for (const [sid, s] of systems) {
        place(sid, s.group.position, rt.level === 'universe');
        s.planets.forEach((pl) => place(pl.id, pl.mesh.getWorldPosition(new THREE.Vector3()), rt.level !== 'universe' && rt.systemId === sid));
      }
      void focusPlanet;
      if (composer) composer.render(); else renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); disposeSystems(); composer?.dispose(); renderer.dispose(); renderer.domElement.remove(); };
  }, []);

  const mgrs = props.agents.filter((a) => a.role === 'manager');
  const emps = props.agents.filter((a) => a.role === 'employee');
  const tag = (a: Agent) => (a.status_kind === 'live' || a.status_kind === 'connected' ? null : a.status_kind.toUpperCase());

  const dragProps = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (P.current.route.level !== 'universe') return;
      dragged.current = false; const sx = e.clientX, sy = e.clientY, target = e.currentTarget as HTMLElement; target.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        if (!dragged.current && Math.hypot(m.clientX - sx, m.clientY - sy) < 6) return;
        dragged.current = true; const w = api3.current?.toWorld(m.clientX, m.clientY);
        if (w) positions.current[id] = { x: Math.max(-90, Math.min(90, w.x)), y: Math.max(-50, Math.min(50, w.y)) };
      };
      const up = () => {
        target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
        if (dragged.current) { clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(() => { void api('/api/layout', 'PUT', positions.current).catch(() => {}); }, 400); }
      };
      target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
    },
    onClick: () => { if (dragged.current) { dragged.current = false; return; } props.navigate(`#/system/${id}`); },
    onPointerEnter: () => { hovered.current = id; }, onPointerLeave: () => { hovered.current = null; },
    onFocus: () => { hovered.current = id; }, onBlur: () => { hovered.current = null; },
  });

  return (
    <div className="universe">
      <div ref={mount} className="universe-canvas" />
      <div ref={labels} className="universe-labels">
        <button className="node core" data-node="jarvis" onClick={() => props.navigate('#/universe')} aria-label="Jarvis core — return to universe">
          <span className="hit" /><span className={`lbl core-lbl state-${props.coreState}`}>JARVIS<small>{props.coreState}</small></span>
        </button>
        {mgrs.map((m) => (
          <button key={m.id} className="node sys" data-node={m.id} {...dragProps(m.id)} aria-label={`${m.name} system (${m.status_kind}). Drag to move, Enter to open.`}>
            <span className="hit" /><span className="lbl">{m.name}{tag(m) && <small className={`tag ${m.status_kind}`}>{tag(m)}</small>}</span>
          </button>
        ))}
        {emps.map((e) => (
          <button key={e.id} className="node planet" data-node={e.id} onClick={() => props.navigate(`#/dept/${e.id}`)} aria-label={`${e.name} department (${e.status_kind})`}>
            <span className="hit" /><span className="lbl">{e.name}{tag(e) && <small className={`tag ${e.status_kind}`}>{tag(e)}</small>}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
