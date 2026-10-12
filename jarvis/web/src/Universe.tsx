import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { api, subscribe, type Agent } from './api.ts';
import { speechState } from './speech.ts';

export type CoreState = 'idle' | 'working' | 'thinking' | 'speaking' | 'urgent' | 'blocked' | 'disconnected' | 'paused';
/** 'core' = the Command Center: camera sits close on Jarvis himself and the systems are hidden. */
export type Route = { level: 'core' | 'universe' | 'system' | 'dept'; systemId?: string; deptId?: string };
type Pos = Record<string, { x: number; y: number }>;
type Props = {
  agents: Agent[]; coreState: CoreState; quality: 'low' | 'medium' | 'high'; reducedMotion: boolean; route: Route;
  active: Set<string>; navigate: (hash: string) => void; layoutVersion: number; onFlightEnd?: () => void;
};

const DEFAULTS: Pos = { ssm: { x: -40, y: 8 }, proj: { x: 38, y: 10 }, investing: { x: -22, y: -26 }, trading: { x: 22, y: -26 }, health: { x: 2, y: 30 } };
const SYS_COLORS = [0xff8a3d, 0x4db8ff, 0xb45cff, 0x3dffc0, 0xff4fa3, 0xffd36b];
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

/**
 * The nebula is LIVE: a generator shader renders it (flowing domain-warped noise) into a small equirectangular texture every frame,
 * and the sky sphere just samples that texture. ~10x fewer pixels than evaluating the noise per screen pixel, so it can animate on modest GPUs.
 */
function nebulaGenMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } }, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }',
    fragmentShader: `varying vec2 vUv; uniform float uTime; ${NOISE}
      void main(){
        float lon=(vUv.x-.5)*6.2831853, lat=(vUv.y-.5)*3.1415927; vec3 d=vec3(cos(lat)*cos(lon), sin(lat), cos(lat)*sin(lon));
        float t=uTime;
        vec3 flow=vec3(t*.035, -t*.022, t*.015);                                      // the whole medium drifts…
        vec3 w=vec3(fbm(d*2.0+flow), fbm(d*2.0+vec3(5.2,1.3,8.1)-flow*1.3), fbm(d*2.0+vec3(2.7,9.2,3.4)+flow*.8));   // …while the warp field churns at different rates
        vec3 q=d*2.3+w*1.9+flow*.6;
        float body=fbm(q), fil=fbm(q*3.4+w*2.0+flow*.5), ridge=1.-abs(2.*fil-1.);
        ridge*=.88+.12*sin(t*.7+fil*9.);                                                // filaments shimmer
        float dens=smoothstep(.47,.86,body)*(.35+1.1*ridge*ridge)*(.93+.07*sin(t*.35+body*6.));   // slow breathing
        float zoneW=smoothstep(.38,.62,fbm(d*1.15+vec3(3.1,.4,2.2)+flow*.18));         // warm side migrates slowly
        float zoneG=smoothstep(.62,.80,fbm(d*1.7+vec3(20.,4.,9.)-flow*.22));
        float zoneM=smoothstep(.45,.70,fbm(d*1.4+vec3(7.,11.,1.)+flow*.15));
        vec3 blue=vec3(.05,.22,.85), cyan=vec3(.08,.65,1.), violet=vec3(.48,.14,.95), magenta=vec3(.95,.18,.58), ember=vec3(1.,.42,.10), gold=vec3(1.,.72,.32), teal=vec3(.10,.95,.62);
        vec3 c=mix(blue, violet, smoothstep(.30,.75,fbm(q*.8+3.)));
        c=mix(c, cyan, smoothstep(.55,.9,ridge)*.55);
        c=mix(c, magenta, zoneM*.75);
        c=mix(c, mix(ember,gold,smoothstep(.7,1.,ridge)*.5), zoneW*.9);
        c=mix(c, teal, zoneG*.7);
        float stars=pow(max(0.,fbm(d*14.+flow*.4)-.62),2.)*14.;
        gl_FragColor=vec4(c*c*dens*.55 + c*stars*dens*.3, 1.); }`,
  });
}
function nebulaSkyMaterial(tex: THREE.Texture) {
  tex.wrapS = THREE.RepeatWrapping; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  return new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex }, uDim: { value: 1 } }, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec3 vD; void main(){ vD=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec3 vD; uniform sampler2D uTex; uniform float uDim; void main(){ vec3 d=normalize(vD); vec2 uv=vec2(atan(d.z,d.x)/6.2831853+.5, asin(clamp(d.y,-1.,1.))/3.1415927+.5); gl_FragColor=vec4(texture2D(uTex,uv).rgb*uDim,1.); }',
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

/** Detailed worlds. 'gas' = swirling storm bands (the blue giant); 'lava' = dark rock, glowing fissures, night-side city lights (the ember worlds). Lit from the system's sun. */
function planetMaterial(a: THREE.Color, b: THREE.Color, kind: 'gas' | 'lava', planned: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uA: { value: a }, uB: { value: b }, uL: { value: new THREE.Vector3(0.6, 0.5, 0.6) }, uKind: { value: kind === 'gas' ? 0 : 1 }, uAlpha: { value: planned ? 0.9 : 1 } }, transparent: planned,
    vertexShader: 'varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec3 vN; varying vec3 vP; uniform float uTime; uniform vec3 uA; uniform vec3 uB; uniform vec3 uL; uniform float uKind; uniform float uAlpha; ${NOISE}
      void main(){ vec3 n=normalize(vN); float ndl=dot(n,normalize(uL)); float day=smoothstep(-.12,.55,ndl);
        vec3 p=vP*1.15; vec3 col; vec3 emis=vec3(0.);
        if(uKind<.5){ float w=fbm(p*3.+uTime*.03); float lat=p.y*5.5+w*3.2+sin(p.x*2.+w*4.)*.6; float bands=.5+.5*sin(lat*2.6); float storm=smoothstep(.55,.8,fbm(p*5.5+w*2.2));
          col=mix(uA,uB,bands); col=mix(col,uB*1.3+.1,storm*.6); col+=vec3(.06,.10,.2)*fbm(p*14.); }
        else { float rock=fbm(p*4.+1.7); float crack=1.-abs(2.*fbm(p*6.5+w3(p))-1.); float lava=smoothstep(.86,.97,crack)*smoothstep(.35,.7,rock);
          col=mix(vec3(.03,.02,.03), uA*.45, rock); emis=vec3(1.,.38,.08)*lava*1.6 + vec3(1.,.55,.15)*lava*lava;
          float city=step(.93,n3(p*46.))*(1.-day)*smoothstep(.45,.75,rock); emis+=vec3(1.,.72,.35)*city*1.3; }
        float rim=pow(1.-max(dot(n,vec3(0.,0.,1.)),0.),3.); vec3 rimC=mix(uB,vec3(.7,.9,1.),.5)*rim*(.25+.9*day);
        vec3 c=col*(.10+day*1.05)+emis*(.45+.55*(1.-day))+rimC; gl_FragColor=vec4(c,uAlpha); }`.replace('w3(p)','fbm(p*2.)*2.'),
  });
}

function ringMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color } }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vP; void main(){ vP=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec2 vP; uniform vec3 uColor; void main(){ float r=length(vP); float t=clamp((r-1.3)/1.05,0.,1.); float bands=.5+.5*sin(t*44.+sin(t*9.)*2.2); float gap=smoothstep(.0,.06,abs(t-.62)-.03);\n float a=(.10+.5*bands)*smoothstep(0.,.07,t)*(1.-smoothstep(.88,1.,t))*gap; vec3 c=mix(uColor,vec3(.85,.8,1.),.35)*(.45+.55*bands); gl_FragColor=vec4(c,a); }',
  });
}

/** Four-point starburst (the glare around the black hole in the reference art). */
function burstTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d')!; g.translate(256, 256);
  for (const rot of [0, Math.PI / 2]) { g.save(); g.rotate(rot); const gr = g.createLinearGradient(-250, 0, 250, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(.5, 'rgba(255,255,255,.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(-250, 0); g.lineTo(0, -2.1); g.lineTo(250, 0); g.lineTo(0, 2.1); g.fill(); g.restore(); }
  const rg = g.createRadialGradient(0, 0, 0, 0, 0, 90); rg.addColorStop(0, 'rgba(255,255,255,.12)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.fillRect(-256, -256, 512, 512);
  return new THREE.CanvasTexture(c);
}

function flareTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d')!; g.translate(128, 128);
  for (let i = 0; i < 8; i++) { g.rotate(Math.PI / 4); const gr = g.createLinearGradient(0, 0, 124, 0); gr.addColorStop(0, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, -2.2); g.lineTo(124, 0); g.lineTo(0, 2.2); g.fill(); }
  return new THREE.CanvasTexture(c);
}

export function Universe(props: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const meteors = useRef<HTMLDivElement>(null);
  const warpEl = useRef<HTMLDivElement>(null), lbTop = useRef<HTMLDivElement>(null), lbBot = useRef<HTMLDivElement>(null);
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
    const camGoal = new THREE.Vector3(0, -34, 92), lookGoal = new THREE.Vector3(), look = new THREE.Vector3(), ctrl = new THREE.Vector3();
    const flight = { active: false, t0: 0, dur: 2000, p0: new THREE.Vector3(), l0: new THREE.Vector3(), key: '', side: 1 };
    const stageEl = el.closest('.stage');
    camera.position.copy(camGoal);
    scene.add(new THREE.AmbientLight(0x8fa6d8, 1.25));
    // Bloom makes every additive glow (corona, ring, suns, links) bleed light like a real HDR scene. Off on "low".
    let composer: EffectComposer | null = null; let bloom: UnrealBloomPass | null = null; let bloomBase = 0.4;
    const buildComposer = (q: string) => {
      composer?.dispose(); composer = null; bloom = null; if (q === 'low') return;
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      composer = new EffectComposer(renderer); composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h);
      composer.addPass(new RenderPass(scene, camera));
      bloomBase = q === 'high' ? 0.5 : 0.36; bloom = new UnrealBloomPass(new THREE.Vector2(w, h), bloomBase, 0.32, 0.7); composer.addPass(bloom);
      composer.addPass(new OutputPass());
    };

    // --- deep space: nebula + three layers of twinkling stars (both follow the camera, with a little parallax) ---
    const nebGen = nebulaGenMaterial(), nebScene = new THREE.Scene(), nebCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    nebScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), nebGen));
    let nebRT: THREE.WebGLRenderTarget | null = null, nebQ = '';
    const nebula = new THREE.Mesh<THREE.SphereGeometry, THREE.Material>(new THREE.SphereGeometry(900, 48, 32), new THREE.MeshBasicMaterial()); nebula.renderOrder = -10; nebula.frustumCulled = false; scene.add(nebula);
    const buildNebulaRT = (q: string) => {
      nebRT?.dispose(); const w = q === 'low' ? 512 : q === 'medium' ? 1024 : 1536;
      nebRT = new THREE.WebGLRenderTarget(w, w / 2, { depthBuffer: false });
      (nebula.material as THREE.Material).dispose(); nebula.material = nebulaSkyMaterial(nebRT.texture);
    };
    let nebT = 0, nebSpin = 0, starSpin = 0, nebFrame = 0, lastWall = performance.now();
    const N = 5600, sp = new Float32Array(N * 3), sS = new Float32Array(N), sPh = new Float32Array(N), sC = new Float32Array(N * 3);
    const tints = [[0.8, 0.9, 1], [1, 0.93, 0.82], [0.62, 0.78, 1], [1, 0.72, 0.68], [0.82, 0.68, 1], [0.7, 1, 0.9]];
    for (let k = 0; k < N; k++) {
      const r = 800, a = Math.random() * 6.283, b = Math.acos(2 * Math.random() - 1);
      sp.set([r * Math.sin(b) * Math.cos(a), r * Math.sin(b) * Math.sin(a), r * Math.cos(b)], k * 3);
      const tier = Math.random(); sS[k] = tier > 0.9975 ? 22 : tier > 0.985 ? 5 : tier > 0.9 ? 2.6 : 1.4; sPh[k] = Math.random(); sC.set(tints[(Math.random() * tints.length) | 0], k * 3);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('aS', new THREE.BufferAttribute(sS, 1)); sg.setAttribute('aP', new THREE.BufferAttribute(sPh, 1)); sg.setAttribute('aC', new THREE.BufferAttribute(sC, 3));
    const starU = { uTime: { value: 0 }, uScale: { value: 1 }, uWarp: { value: 0 } };
    const stars = new THREE.Points(sg, new THREE.ShaderMaterial({ uniforms: starU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'attribute float aS; attribute float aP; attribute vec3 aC; uniform float uTime; uniform float uScale; uniform float uWarp; varying vec3 vC; varying float vA; varying float vBig; void main(){ vC=aC; vBig=step(10.,aS); vA=.5+.5*sin(uTime*(.5+aP*1.5)+aP*60.)+uWarp*.6; gl_PointSize=aS*uScale*(1.+uWarp*1.6); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `varying vec3 vC; varying float vA; varying float vBig; void main(){ vec2 q=gl_PointCoord-.5; float d=length(q);
        if(vBig>.5){ float spike=exp(-abs(q.x)*55.)*exp(-abs(q.y)*5.5)+exp(-abs(q.y)*55.)*exp(-abs(q.x)*5.5); float core=exp(-d*16.); float a=(spike*.9+core*1.3)*(.55+.45*vA); gl_FragColor=vec4(mix(vC,vec3(1.),.5)*a, a); return; }
        if(d>.5) discard; float a=pow(1.-d*2.,1.5)*(.35+.65*vA); gl_FragColor=vec4(vC*(1.+a), a); }` }));
    stars.frustumCulled = false; scene.add(stars);

    // --- Jarvis core ---
    let insideK = 0; const core = new THREE.Group(); core.scale.setScalar(1.6); scene.add(core);
    core.add(new THREE.Mesh(new THREE.SphereGeometry(3.2, 48, 32), new THREE.MeshBasicMaterial({ color: 0x000000 })));
    const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: STATE_COLORS.idle, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.3 }));
    corona.scale.set(21, 21, 1); core.add(corona);
    const tilt = new THREE.Group(); tilt.rotation.x = TILT; core.add(tilt);
    const ringU = { uTime: { value: 0 }, uColor: { value: new THREE.Color(STATE_COLORS.idle) }, uFine: { value: 0.15 }, uGain: { value: 1 } };
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.9, 9.5, 160, 1), new THREE.ShaderMaterial({
      uniforms: ringU, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vP; void main(){ vP=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `varying vec2 vP; uniform float uTime; uniform vec3 uColor; uniform float uFine; uniform float uGain;
        void main(){ float r=length(vP); float t=clamp((r-3.9)/5.6,0.,1.); float a=atan(vP.y,vP.x);
          float sw=0.5+0.5*sin(a*7.+uTime*1.6-r*1.7); float fine=0.5+0.5*sin(a*23.-uTime*2.3+r*5.);
          float dop=0.55+0.75*max(0.,cos(a-0.6)); float st=pow(abs(sin(a*11.+r*2.6-uTime*.8)),14.); float I=pow(1.-t,0.95)*(0.38+0.5*sw+uFine*fine)*smoothstep(0.,0.05,t)*(1.-smoothstep(.7,1.,t))*uGain*dop*1.15; I+=st*(1.-t)*.5*uGain*dop; // spiral streaks (swirling light trails)

          vec3 c=mix(uColor*0.85,vec3(1.,.93,.78),pow(1.-t,3.2)); gl_FragColor=vec4(c*1.55,I*1.0);} `,
    }));
    tilt.add(ring);
    // Gravitational-lens halo: a camera-facing photon ring with a soft glow, like the light bent around the black hole.
    const halo = new THREE.Mesh(new THREE.RingGeometry(3.1, 7, 160, 1), new THREE.ShaderMaterial({
      uniforms: ringU, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vP; void main(){ vP=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: 'varying vec2 vP; uniform vec3 uColor; uniform float uGain; void main(){ float r=length(vP); float ph=exp(-pow((r-3.42)*9.0,2.)); float soft=exp(-(r-3.1)*1.3)*.10; float I=(ph*0.85+soft)*uGain; gl_FragColor=vec4(mix(uColor,vec3(1.),.6)*I, I*.9); }' }));
    halo.renderOrder = 2; core.add(halo);
    const burst = new THREE.Sprite(new THREE.SpriteMaterial({ map: burstTexture(), color: STATE_COLORS.idle, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.34 }));
    burst.scale.set(40, 40, 1); core.add(burst);
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
    type Sys = { id: string; group: THREE.Group; sun: THREE.Mesh; sunU: { uTime: { value: number } }; flare: THREE.Sprite; glow: THREE.Sprite; light: THREE.PointLight; energy: number; flow: number; boost: number; streamT: number; planets: { id: string; mesh: THREE.Object3D; body: THREE.Mesh; r: number; phase: number; speed: number; ring: THREE.LineLoop; comet: THREE.Sprite }[] };
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
          const base = new THREE.Color(color), hsl = { h: 0, s: 0, l: 0 }; base.getHSL(hsl);
          const kind: 'gas' | 'lava' = j % 2 === 0 ? 'gas' : 'lava';
          const cA = new THREE.Color().setHSL(0.64 + j * 0.03, 0.85, 0.13), cB = new THREE.Color().setHSL(0.58 + j * 0.04, 0.9, 0.52);   // blue-violet storms against the system's ember/neon sun
          const mesh = new THREE.Group(); group.add(mesh);
          const body = new THREE.Mesh(new THREE.SphereGeometry(0.85, 48, 36), planetMaterial(kind === 'gas' ? cA : base.clone().multiplyScalar(0.8), kind === 'gas' ? cB : new THREE.Color(0xffa060), kind, ep)); body.rotation.z = 0.35; mesh.add(body);
          if (j % 2 === 0) { const ringM = new THREE.Mesh(new THREE.RingGeometry(1.3, 2.35, 96, 1), ringMaterial(cB.clone())); ringM.rotation.set(1.2, 0.15, 0.45); mesh.add(ringM); }
          const atm = new THREE.Mesh(new THREE.SphereGeometry(0.85 * 1.16, 32, 24), atmosphereMaterial(kind === 'gas' ? 0x3a7bff : 0xff7a2a, ep ? 0.28 : 0.5)); mesh.add(atm);
          const comet = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,255,255,1)', 'rgba(0,0,0,0)'), color: 0xcfeaff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: ep ? 0.4 : 0.9 })); comet.scale.set(0.9, 0.9, 1); group.add(comet);
          const pts = Array.from({ length: 97 }, (_, k) => new THREE.Vector3(Math.cos((k / 96) * 6.2832) * r, Math.sin((k / 96) * 6.2832) * r, 0));
          const og = new THREE.BufferGeometry().setFromPoints(pts);
          const rg = new THREE.LineLoop(og, ep ? new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.5, transparent: true, opacity: 0.35 }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
          if (ep) rg.computeLineDistances();
          group.add(rg);
          return { id: e.id, mesh, body, r, phase: j * 1.7 + i, speed: 0.35 / Math.sqrt(r / 5), ring: rg, comet };
        });
        systems.set(m.id, { id: m.id, group, sun, sunU: sunMat.uniforms as any, flare, glow, light, energy: 0, flow: 0, boost: 0, streamT: 0, planets });
        const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]); const ln = new THREE.Line(lg, new THREE.LineDashedMaterial({ color, dashSize: 1.3, gapSize: 1.0, transparent: true, opacity: planned ? 0.25 : 0.6, blending: THREE.AdditiveBlending, depthWrite: false })); scene.add(ln); links.set(m.id, ln);
      });
    };

    // --- energy packets: REAL events only (server 'pulse' events) + a steady stream while a task is genuinely running ---
    type Packet = { sys: string; dir: 1 | -1; t0: number; dur: number; big: boolean; color: THREE.Color; phase: number; sprites: THREE.Sprite[]; arrived?: boolean };
    const packets: Packet[] = [], impacts: { pos: THREE.Vector3; t0: number; color: THREE.Color; sprite: THREE.Sprite }[] = [], queue: any[] = [];
    const dotTex = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'); let coreBoost = 0;
    const KIND_COLOR: Record<string, number> = { dispatch: 0x4fd0ff, done: 0x1dff94, attention: 0xff9f1a, failed: 0xff2d55, stream: 0x3fc4ff };
    const mkSprite = (c: THREE.Color, o: number) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: o })); scene.add(sp); return sp; };
    const spawn = (sys: string, dir: 1 | -1, kind: string, big: boolean, trailN: number) => {
      if (!systems.has(sys)) return; const color = new THREE.Color(KIND_COLOR[kind] ?? KIND_COLOR.dispatch);
      const sprites = Array.from({ length: trailN + 1 }, () => mkSprite(color, 0));
      const len = systems.get(sys)!.group.position.length();
      packets.push({ sys, dir, t0: performance.now(), dur: Math.min(2300, Math.max(900, (len / 40) * 1000)) * (big ? 1 : 1.25), big, color, phase: Math.random() * 6.28, sprites });
    };
    const impact = (pos: THREE.Vector3, color: THREE.Color) => { const sp = mkSprite(color, 0.9); sp.position.copy(pos); impacts.push({ pos: pos.clone(), t0: performance.now(), color, sprite: sp }); };
    const unsubPulse = subscribe((type, e) => { if (type === 'pulse') queue.push(e); });
    const retire = (sp: THREE.Sprite) => { scene.remove(sp); (sp.material as THREE.SpriteMaterial).dispose(); };

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
      if (particleQ !== p.quality) { particleQ = p.quality; buildParticles(qn); renderer.setPixelRatio(Math.min(window.devicePixelRatio, p.quality === 'low' ? 1 : p.quality === 'medium' ? 1.5 : 2)); starU.uScale.value = renderer.getPixelRatio(); resize(); buildComposer(p.quality); buildNebulaRT(p.quality); }
      pu.uScale.value = renderer.domElement.height / 2.2;
      const speed = reduced ? 0 : 1;
      tAcc += dt * speed * (p.coreState === 'working' ? 1.8 : p.coreState === 'urgent' ? 1.4 : p.coreState === 'thinking' ? 1.2 : p.coreState === 'paused' || p.coreState === 'disconnected' ? 0.25 : 1);
      ringU.uTime.value = tAcc; pu.uTime.value = tAcc;
      goalC.setHex(STATE_COLORS[p.coreState]); cur.lerp(goalC, 1 - Math.exp(-dt * 4)); ringU.uColor.value.copy(cur); pu.uColor.value.copy(cur); (corona.material as THREE.SpriteMaterial).color.copy(cur); (burst.material as THREE.SpriteMaterial).color.copy(cur).lerp(new THREE.Color(1, 1, 1), 0.4);
      // Per-state motion. Speaking follows REAL speech-synthesis events (start / word boundaries / end), decaying between words.
      const tNow = performance.now(), st = p.coreState; let pulse = 1, gain = 1, fine = 0.15;
      speechState.level *= Math.exp(-dt * 5);
      if (st === 'thinking') { pulse = 1 + 0.07 * Math.sin(tNow / 220); tilt.rotation.z += dt * 0.5 * speed; gain = 1.05; }
      else if (st === 'working') { fine = 0.55; gain = 1.15; }                                  // executing: busier, finer energy pattern
      else if (st === 'speaking') { pulse = 1 + 0.12 * speechState.level; gain = 1 + 0.5 * speechState.level; fine = 0.3; }
      else if (st === 'urgent') { pulse = 1 + 0.1 * Math.abs(Math.sin(tNow / 170)); gain = 1.25; fine = 0.4; }
      else if (st === 'blocked') pulse = 1 + 0.05 * Math.sin(tNow / 600);
      else if (st === 'idle') pulse = 1 + 0.015 * Math.sin(tNow / 1800);                         // gentle, continuous
      pulse += coreBoost * 0.14; gain += coreBoost * 0.55; fine += coreBoost * 0.25;   // a result arriving at the core makes it surge
      if (reduced) { pulse = 1; fine = 0.15; }
      ringU.uFine.value = fine; ringU.uGain.value = gain;
      burst.scale.setScalar(40 * (0.92 + 0.08 * pulse) * (st === 'urgent' ? 1.25 : 1)); (burst.material as THREE.SpriteMaterial).rotation += dt * 0.02 * speed;
      corona.scale.setScalar(21 * pulse * (st === 'disconnected' ? 0.7 : 1));
      // Background sits at infinity (follows camera) with a hint of parallax; everything shimmers slowly.
      nebula.position.copy(camera.position); stars.position.copy(camera.position);
      // Everything in the sky moves: the nebula flows (re-rendered each frame), the sky sphere and the stars turn at different slow rates (parallax depth), stars twinkle.
      const wallNow = performance.now(), realDt = Math.min(1, (wallNow - lastWall) / 1000); lastWall = wallNow;   // sky speed uses real elapsed time, so it looks the same at 2 fps or 120 fps
      nebT += realDt * speed; nebSpin += realDt * 0.0035 * speed; starSpin += realDt * -0.0055 * speed;
      nebula.rotation.y = camera.position.x * 0.0004 + nebSpin; nebula.rotation.x = Math.sin(nebT * 0.02) * 0.04;
      stars.rotation.y = camera.position.x * 0.0009 + starSpin; stars.rotation.x = camera.position.y * 0.0006; stars.rotation.z = starSpin * 0.6;
      starU.uTime.value = tAcc;
      if (nebRT && (p.quality !== 'low' || (nebFrame++ & 1) === 0) && !(reduced && nebFrame > 2)) {   // low quality: every other frame; reduced motion: render once, then hold still
        nebGen.uniforms.uTime.value = reduced ? 0 : nebT; renderer.setRenderTarget(nebRT); renderer.render(nebScene, nebCam); renderer.setRenderTarget(null);
      }
      halo.lookAt(camera.position);

      // route → camera goal
      const rt = p.route; let focusPlanet: THREE.Object3D | null = null;
      if (rt.level === 'core') { camGoal.set(0, 0, 0.6); lookGoal.set(0, 6, -30); }   // inside the black hole
      else if (rt.level === 'universe') { camGoal.set(0, -34, 92); lookGoal.set(0, 0, 0); }
      else if (rt.systemId && systems.has(rt.systemId)) {
        const c = sysWorld(rt.systemId);
        if (rt.level === 'dept' && rt.deptId) {
          const pl = systems.get(rt.systemId)!.planets.find((x) => x.id === rt.deptId);
          if (pl) { focusPlanet = pl.mesh; const wp = pl.mesh.getWorldPosition(new THREE.Vector3()); lookGoal.copy(wp); camGoal.set(wp.x - 1.6, wp.y - 3.2, wp.z + 5.2); }
        } else { lookGoal.copy(c); camGoal.set(c.x, c.y - 17, 27); }
      }
      // ---- cinematic flight: a curved swooping arc with ease-in/out, widening FOV, banking, hyperspace streaks and letterbox bars ----
      const goalKey = `${rt.level}:${rt.systemId ?? ''}:${rt.deptId ?? ''}`, nowMs = performance.now();
      if (flight.key !== goalKey) {
        const first = flight.key === ''; flight.key = goalKey;
        if (first || reduced) { camera.position.copy(camGoal); look.copy(lookGoal); flight.active = false; p.onFlightEnd?.(); }
        else {
          flight.active = true; flight.t0 = nowMs; flight.p0.copy(camera.position); flight.l0.copy(look);
          const dist = flight.p0.distanceTo(camGoal) + flight.l0.distanceTo(lookGoal) * 0.6;
          flight.dur = Math.min(3.8, Math.max(1.5, 1.3 + dist / 55)) * 1000; flight.side = camGoal.x - flight.p0.x >= 0 ? 1 : -1;
        }
      }
      let speedS = 0;
      if (flight.active) {
        const u0 = Math.min(1, (nowMs - flight.t0) / flight.dur), u = u0 < 0.5 ? 4 * u0 ** 3 : 1 - (-2 * u0 + 2) ** 3 / 2;   // ease in-out cubic
        const chord = tmp.subVectors(camGoal, flight.p0), len = Math.max(chord.length(), 0.001);
        ctrl.copy(flight.p0).add(camGoal).multiplyScalar(0.5); ctrl.z += len * 0.3 + 6; ctrl.x += (-chord.y / len) * len * 0.2; ctrl.y += (chord.x / len) * len * 0.2;   // swoop up and sideways, then settle
        const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
        camera.position.set(flight.p0.x * a + ctrl.x * b + camGoal.x * c, flight.p0.y * a + ctrl.y * b + camGoal.y * c, flight.p0.z * a + ctrl.z * b + camGoal.z * c);
        look.copy(flight.l0).lerp(lookGoal, u0 * u0 * (3 - 2 * u0));
        speedS = Math.sin(Math.PI * u0);                                       // 0 → 1 → 0 across the flight
        camera.up.set(Math.sin(flight.side * 0.17 * speedS), Math.cos(flight.side * 0.17 * speedS), 0);   // bank into the turn
        if (u0 >= 1) { flight.active = false; camera.up.set(0, 1, 0); p.onFlightEnd?.(); }
      } else {
        camera.position.copy(camGoal); look.copy(lookGoal);
        if (!reduced) { camera.position.x += Math.sin(nowMs / 4200) * 0.45; camera.position.y += Math.cos(nowMs / 5300) * 0.3; }   // slow idle drift
      }
      const fovT = 50 + 17 * speedS; if (Math.abs(camera.fov - fovT) > 0.01) { camera.fov = fovT; camera.updateProjectionMatrix(); }
      camera.lookAt(look);
      // Inside the black hole: once the camera crosses the horizon the core's own scenery is gone (it is all around us, not in front of us); the sky dims to a deep, calm glow.
      { const inside = rt.level === 'core' ? 1 : 0; insideK += (inside - insideK) * (reduced ? 1 : Math.min(1, dt * 2.2));
        core.visible = camera.position.length() > 5.2; const nm = nebula.material as THREE.ShaderMaterial; if (nm.uniforms?.uDim) nm.uniforms.uDim.value = 1 - 0.62 * insideK; }
      starU.uWarp.value = Math.max(speedS, insideK * (reduced ? 0 : 0.22)); if (bloom) bloom.strength = bloomBase * (1 + 0.9 * speedS);
      if (warpEl.current) warpEl.current.style.opacity = (speedS * 0.6).toFixed(3);
      if (lbTop.current && lbBot.current) { const h = `${(speedS * 6).toFixed(2)}%`; lbTop.current.style.height = h; lbBot.current.style.height = h; }
      stageEl?.classList.toggle('flying', speedS > 0.04);

      // systems
      const focusedSys = rt.level === 'universe' || rt.level === 'core' ? null : rt.systemId;
      const showSystems = rt.level !== 'core' || flight.active;
      for (const [sid, s] of systems) {
        const base = positions.current[sid] ?? { x: 0, y: 0 };
        s.group.position.lerp(tmp.set(base.x, base.y, 0), reduced ? 1 : 1 - Math.exp(-dt * 12));
        s.sun.rotation.y += dt * 0.15 * speed; s.sunU.uTime.value = tAcc; (s.flare.material as THREE.SpriteMaterial).rotation += dt * 0.05 * speed;
        const slow = hovered.current === sid || (focusedSys === sid && rt.level === 'dept') ? 0.12 : 1;
        s.planets.forEach((pl) => {
          pl.phase += dt * pl.speed * slow * speed;
          pl.mesh.position.set(Math.cos(pl.phase) * pl.r, Math.sin(pl.phase) * pl.r, 0);
          pl.body.rotation.y += dt * 0.35 * speed; (pl.body.material as THREE.ShaderMaterial).uniforms.uTime.value = tAcc;
          { const ld = new THREE.Vector3(-pl.mesh.position.x, -pl.mesh.position.y, 0).normalize().transformDirection(camera.matrixWorldInverse); (pl.body.material as THREE.ShaderMaterial).uniforms.uL.value.copy(ld); }   // sun direction in view space
          const ca = pl.phase * 2.6 + 1; pl.comet.position.set(Math.cos(ca) * pl.r, Math.sin(ca) * pl.r, 0);
        });
        const dim = focusedSys && focusedSys !== sid ? 0.25 : 1;
        (s.glow.material as THREE.SpriteMaterial).opacity = (p.agents.find((a) => a.id === sid)?.status_kind === 'planned' ? 0.22 : 0.5) * dim;
        s.group.visible = showSystems; const ln = links.get(sid)!; ln.visible = showSystems; const pa = ln.geometry.attributes.position as THREE.BufferAttribute;
        pa.setXYZ(0, 0, 0, 0); pa.setXYZ(1, s.group.position.x, s.group.position.y, 0); pa.needsUpdate = true;
        ln.computeLineDistances(); { const ld = ln.geometry.attributes.lineDistance as THREE.BufferAttribute, off = s.flow % 2.3; ld.setX(0, -off); ld.setX(1, ld.getX(1) - off); ld.needsUpdate = true; } // light flowing along the data link
        // Link energy follows REAL running work: brighter, faster flow, and a stream of small packets while a task executes.
        const working = p.active.has(sid) && !reduced; s.energy += ((working ? 1 : 0) - s.energy) * Math.min(1, dt * 3); s.flow += dt * speed * (2.5 + s.energy * 7);
        (ln.material as THREE.LineDashedMaterial).opacity = (p.agents.find((a) => a.id === sid)?.status_kind === 'planned' ? 0.25 : 0.6) * (1 + s.energy * 0.9);
        if (working) { const wall = performance.now(); if (wall - s.streamT > 850) { s.streamT = wall; spawn(sid, 1, 'stream', false, p.quality === 'low' ? 3 : 6); } }   // wall-clock cadence: same rhythm at any frame rate
        s.boost *= Math.exp(-dt * 3.2); s.flare.scale.setScalar(15 * (1 + s.boost * 0.55)); (s.flare.material as THREE.SpriteMaterial).opacity = (p.agents.find((x) => x.id === sid)?.status_kind === 'planned' ? 0.16 : 0.38) + s.boost * 0.35;
      }

      // drain real events → packets (reduced motion: no packets, the link just lights)
      while (queue.length) {
        const ev = queue.shift(); const sys = ev.system as string; if (!systems.has(sys)) continue;
        if (!showSystems) { coreBoost = Math.max(coreBoost, ev.kind === 'dispatch' ? 0.55 : 1); continue; }   // Command Center: the systems are out of view, so the event shows as the core itself reacting
        if (reduced) { systems.get(sys)!.boost = 1; continue; }
        const tn = p.quality === 'low' ? 5 : 10;
        if (ev.kind === 'dispatch') spawn(sys, 1, 'dispatch', true, tn); else spawn(sys, -1, ev.kind, true, tn);
      }
      for (let k = packets.length - 1; k >= 0; k--) {
        const pk = packets[k], s2 = systems.get(pk.sys); const age = (performance.now() - pk.t0) / pk.dur;
        if (!s2 || age >= 1.12) { pk.sprites.forEach(retire); packets.splice(k, 1); continue; }
        const u = Math.min(1, age), e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2, end = s2.group.position;
        if (!pk.arrived && age >= 1) { pk.arrived = true; impact(pk.dir === 1 ? end.clone() : new THREE.Vector3(), pk.color); if (pk.dir === 1) s2.boost = Math.max(s2.boost, pk.big ? 1 : 0.35); else coreBoost = Math.max(coreBoost, pk.big ? 1 : 0.4); }
        const px = -end.y, py = end.x, pl = Math.max(Math.hypot(px, py), 0.001);   // perpendicular, for a gentle helical weave
        pk.sprites.forEach((sp, idx) => {
          const lag = idx * (pk.big ? 0.026 : 0.034), uu = pk.dir === 1 ? e - lag : 1 - e + lag; const q = Math.min(1, Math.max(0, uu));
          const weave = pk.big ? Math.sin(q * 20 + pk.phase) * 0.42 * (1 - Math.abs(q - 0.5) * 1.2) : 0;
          sp.position.set(end.x * q + (px / pl) * weave, end.y * q + (py / pl) * weave, 0.4);
          const fade = idx === 0 ? 1 : Math.pow(1 - idx / pk.sprites.length, 1.5) * 0.75, vis = showSystems && u < 1 && uu > 0 && uu < 1 ? 1 : 0;
          (sp.material as THREE.SpriteMaterial).opacity = fade * vis * (pk.big ? 1 : 0.8);
          sp.scale.setScalar(idx === 0 ? (pk.big ? 5.4 : 2.7) : (pk.big ? 3.9 : 2.0) * (1 - idx / (pk.sprites.length * 1.3)));
        });
      }
      for (let k = impacts.length - 1; k >= 0; k--) {
        const im = impacts[k], a = (performance.now() - im.t0) / 800;
        if (a >= 1) { retire(im.sprite); impacts.splice(k, 1); continue; }
        im.sprite.scale.setScalar(2 + a * 9); (im.sprite.material as THREE.SpriteMaterial).opacity = showSystems ? (1 - a) * (1 - a) * 0.85 : 0;
      }
      coreBoost *= Math.exp(-dt * 3);

      // project labels
      const w = el.clientWidth, h = el.clientHeight, v = new THREE.Vector3();
      const place = (id: string, world: THREE.Vector3, show: boolean) => {
        let e = els.get(id); if (!e || !e.isConnected) { e = lab.querySelector<HTMLElement>(`[data-node="${id}"]`) ?? undefined; if (e) els.set(id, e); } if (!e) return; v.copy(world).project(camera);
        const vis = show && v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
        e.style.visibility = vis ? 'visible' : 'hidden'; if (vis) e.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
      };
      place('jarvis', new THREE.Vector3(0, 0, 0), rt.level !== 'core');
      for (const [sid, s] of systems) {
        place(sid, s.group.position, rt.level === 'universe');
        s.planets.forEach((pl) => place(pl.id, pl.mesh.getWorldPosition(new THREE.Vector3()), rt.level !== 'universe' && rt.systemId === sid));
      }
      void focusPlanet;
      if (composer) composer.render(); else renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); unsubPulse(); packets.forEach((pk) => pk.sprites.forEach(retire)); impacts.forEach((im) => retire(im.sprite)); ro.disconnect(); disposeSystems(); composer?.dispose(); nebRT?.dispose(); renderer.dispose(); renderer.domElement.remove(); };
  }, []);

  // Occasional shooting stars: purely ambient scenery (never tied to operations).
  useEffect(() => {
    if (props.reducedMotion) return; let t: number;
    const spawn = () => {
      const host = meteors.current; if (host && !document.hidden && host.clientWidth) {
        const m = document.createElement('i'), ang = 15 + Math.random() * 25, dist = 260 + Math.random() * 240, rad = (ang * Math.PI) / 180;
        m.className = 'meteor'; m.style.left = `${Math.random() * 70 + 10}%`; m.style.top = `${Math.random() * 40 + 3}%`;
        m.style.setProperty('--a', `${ang}deg`); m.style.setProperty('--dx', `${Math.cos(rad) * dist}px`); m.style.setProperty('--dy', `${Math.sin(rad) * dist}px`);
        m.addEventListener('animationend', () => m.remove()); host.appendChild(m);
      }
      t = window.setTimeout(spawn, 4000 + Math.random() * 8000);
    };
    t = window.setTimeout(spawn, 2500); return () => clearTimeout(t);
  }, [props.reducedMotion]);

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
      <div ref={meteors} className="meteors" aria-hidden="true" /><div ref={warpEl} className="warp" aria-hidden="true" /><div ref={lbTop} className="lb top" aria-hidden="true" /><div ref={lbBot} className="lb bot" aria-hidden="true" />
      <div ref={labels} className="universe-labels">
        <button className="node core" data-node="jarvis" onClick={() => props.navigate('#/command')} aria-label="Jarvis core — enter the Command Center">
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
