import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLY_ALTITUDE, PLANET_RADIUS } from '../../shared/constants.js';

// Temporaries for shooting star animation — no per-frame allocation
const _ssHead = new THREE.Vector3();
const _ssTail = new THREE.Vector3();
// Temporanei per setView (una volta per frame)
const _viewUp = new THREE.Vector3();
const _sunH = new THREE.Vector3();
const _side = new THREE.Vector3();

/**
 * Velocità del ciclo giorno/notte, in "unità di ciclo" al secondo. Il ciclo
 * intero dura quanto la somma di hold + blend degli stati (5 unità), quindi:
 *  - 0.015 → ciclo completo ~5:30 min
 *  - 0.03  → ciclo completo ~2:45 min  (default)
 *  - 0.06  → ciclo completo ~1:20 min
 * Modifica questo valore per regolare la velocità del cielo/luci/stelle.
 */
const CYCLE_SPEED = 0.03;

/** Altezza del disco del sole/luna sopra il bordo del pianeta (rad). */
const DISC_LIFT = 0.14;
/**
 * Nebbia come prospettiva aerea. Parte poco sotto la camera e segue la sua
 * quota: così scala da sola con lo zoom e con la vista in orbita. Dalla
 * camera di gioco il terreno più lontano (il bordo del pianeta) sta a ~37–45
 * unità: lì deve già velarsi, l'aereo a 14 unità no. Salendo la fascia si
 * allarga (radice della quota): dall'orbita il pianeta resta nitido e il
 * bordo lo sfuma già l'atmosfera.
 */
const FOG_NEAR_OFFSET = 8;
const FOG_RANGE = 62;
/** Quota della camera di gioco sopra il raggio del pianeta. */
const FOG_REF_ALTITUDE = 12;

const skyVertexShader = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFragmentShader = /* glsl */ `
  uniform vec3 topColor;    // bordi esterni schermo
  uniform vec3 midColor;    // banda orizzonte (bassa quota)
  uniform vec3 bottomColor; // epicentro (dietro al pianeta)
  uniform vec3  uSunH;      // azimut del sole nel piano tangente della camera
  uniform float uLimb;      // angolo del bordo del pianeta dal nadir
  uniform vec3  uGlowColor;
  uniform float uGlow;
  uniform vec3  uDiscDir;   // centro del disco (sole o luna), sopra il bordo
  uniform vec3  uShadowDir; // centro dell'ombra che fa la falce di luna
  uniform vec3  uDiscColor;
  uniform float uDisc;
  uniform float uDiscSize;  // raggio del disco (rad)
  uniform float uCrescent;
  varying vec3 vWorldPosition;

  #include <common>
  #include <dithering_pars_fragment>

  void main() {
    vec3 viewDir = normalize(vWorldPosition - cameraPosition);
    vec3 centerDir = normalize(-cameraPosition);
    float dotProduct = dot(viewDir, centerDir);
    float angle = acos(clamp(dotProduct, -1.0, 1.0));
    float f = clamp(angle / 1.8, 0.0, 1.0);
    f = smoothstep(0.0, 1.0, f);

    // Tre bande: bottom → mid (orizzonte a ~55%) → top
    vec3 col;
    float mid = 0.55;
    if (f < mid) {
      col = mix(bottomColor, midColor, f / mid);
    } else {
      col = mix(midColor, topColor, (f - mid) / (1.0 - mid));
    }

    // Bagliore del sole sull'orizzonte: dice da dove arriva la luce.
    vec3 hz = viewDir + centerDir * dotProduct;
    float az = max(dot(hz * inversesqrt(max(dot(hz, hz), 1e-8)), uSunH), 0.0);
    float band = exp(-max(angle - uLimb, 0.0) * 5.0);
    col += uGlowColor * (band * az * az * az * uGlow);

    // Disco appoggiato sul bordo del pianeta: sole all'alba e al tramonto,
    // luna (a falce) di notte. HDR, così il bloom lo fa brillare; il terreno
    // lo copre da solo, perché il cielo è disegnato per primo.
    // Distanze come corde, non coseni: vicino a 1 il coseno perde precisione.
    // Ramo su una uniform (coerente su tutta la GPU): di giorno non costa nulla.
    if (uDisc > 0.001) {
      float dc = length(viewDir - uDiscDir);
      float disc = 1.0 - smoothstep(uDiscSize - 0.0025, uDiscSize + 0.0015, dc);
      float shade = 1.0 - smoothstep(uDiscSize - 0.0025, uDiscSize + 0.0015, length(viewDir - uShadowDir));
      disc *= 1.0 - shade * uCrescent;
      float halo = exp(-dc * 16.0) * 0.35 + exp(-dc * 60.0) * 0.5;
      col += uDiscColor * ((disc * 1.8 + halo) * uDisc);
    }

    gl_FragColor = vec4(col, 1.0);
    // In qualità alta sono vuoti (si disegna nel render target del composer e
    // tone mapping e sRGB li fa il GradePass); in bassa si disegna a schermo e
    // senza questi il cielo usciva in lineare: blu notte anche a mezzogiorno.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <dithering_fragment>
  }
`;

/** Nebulose / polvere galattica dietro alle stelle (solo notte, blending additivo). */
const nebulaVertexShader = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldDir = normalize(worldPosition.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const nebulaFragmentShader = /* glsl */ `
  uniform float uOpacity;
  uniform float uTime;
  uniform vec3 uGalaxyPole;
  varying vec3 vWorldDir;

  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n = i.x + i.y * 57.0 + 113.0 * i.z;
    return mix(
      mix(mix(hash13(vec3(n + 0.0)), hash13(vec3(n + 1.0)), f.x),
          mix(hash13(vec3(n + 57.0)), hash13(vec3(n + 58.0)), f.x), f.y),
      mix(mix(hash13(vec3(n + 113.0)), hash13(vec3(n + 114.0)), f.x),
          mix(hash13(vec3(n + 170.0)), hash13(vec3(n + 171.0)), f.x), f.y),
      f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.55;
    vec3 shift = vec3(100.0, 31.0, 67.0);
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = p * 2.12 + shift;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vWorldDir);
    float galLat = abs(dot(d, uGalaxyPole));
    float band = smoothstep(0.92, 0.35, galLat);
    vec3 drift = d * 1.7 + vec3(0.11, 0.07, 0.13) * uTime;
    float n1 = fbm(drift);
    float n2 = fbm(drift.yzx * 1.4 + 2.1);
    float n3 = fbm(d * 3.3 + uTime * 0.02);
    float clouds = pow(n1 * 0.55 + n2 * 0.35 + n3 * 0.25, 1.35);
    float veil = pow(max(0.0, fbm(d * 1.1 + uTime * 0.015)), 2.2) * 0.65;

    vec3 deep = vec3(0.08, 0.04, 0.22);
    vec3 dustCyan = vec3(0.12, 0.42, 0.55);
    vec3 dustRose = vec3(0.42, 0.15, 0.32);
    vec3 core = vec3(0.55, 0.38, 0.72);
    float hue = fract(n2 * 0.37 + n3 * 0.21);
    vec3 col = mix(deep, dustCyan, smoothstep(0.15, 0.75, n1));
    col = mix(col, dustRose, smoothstep(0.35, 0.9, n2) * 0.55);
    col = mix(col, core, smoothstep(0.5, 0.95, n3) * 0.4);
    col += vec3(0.15, 0.12, 0.22) * hue * 0.35;

    float intensity = (clouds * 0.85 + veil * 0.45) * band;
    intensity = smoothstep(0.08, 1.0, intensity) * 0.55;
    vec3 outRgb = col * intensity * uOpacity;
    gl_FragColor = vec4(outRgb, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const starsVertexShader = /* glsl */ `
  attribute vec3 starColor;
  attribute float starSize;
  varying vec3 vStarColor;
  varying float vTwinkle;
  uniform float uTime;

  void main() {
    vStarColor = starColor;
    float id = abs(position.x * 0.13 + position.y * 0.37 + position.z * 0.21);
    vTwinkle = sin(uTime * (2.0 + fract(id) * 3.0) + id * 6.28) * 0.5 + 0.5;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = max(10.0, -mvPosition.z);
    gl_PointSize = starSize * (280.0 / dist);
    gl_PointSize = clamp(gl_PointSize, 1.2, 18.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const starsFragmentShader = /* glsl */ `
  varying vec3 vStarColor;
  varying float vTwinkle;
  uniform float uOpacity;

  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float r = length(c);
    if (r > 0.52) discard;
    float core = 1.0 - smoothstep(0.0, 0.22, r);
    float halo = 1.0 - smoothstep(0.12, 0.5, r);
    float glow = mix(0.75, 1.15, vTwinkle);
    vec3 rgb = vStarColor * glow * (core * 1.15 + halo * 0.35);
    float a = (core * 0.95 + halo * 0.45) * uOpacity;
    gl_FragColor = vec4(rgb, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const C = (hex) => new THREE.Color(hex);
const L = (r, g, b) => new THREE.Color(r, g, b); // valori lineari, per il grading

/**
 * Stati del ciclo. top = bordi schermo, mid = orizzonte, bottom = epicentro
 * luminoso dietro al pianeta.
 *
 * `hold` e `blend` sono in unità di ciclo: per `hold` lo stato resta puro,
 * per `blend` sfuma nel successivo. Prima ogni stato durava uguale e si
 * sfumava per tutta la sua durata, così solo ~1/5 del ciclo aveva il cielo
 * azzurro (la fase 0.35, detta "giorno", era già magenta). Ora, contando metà
 * delle sfumature, il giorno azzurro è ~40% del ciclo e la notte ~23%.
 *
 * Per ogni stato anche colore e intensità di sole e ambiente, esposizione e
 * grading: prima cambiavano solo le intensità, di notte il terreno era quasi
 * nero e al tramonto ACES spingeva tutto il frame verso un rosso saturo.
 * `night` è il vecchio "fattore notte" (0 giorno, 1 notte) che leggono aerei,
 * torrette e ombre: i suoi valori non sono cambiati.
 */
const skyStates = [
  // 1. Giorno: azzurro pieno, alone chiaro dietro al pianeta.
  {
    hold: 1.6, blend: 0.45,
    top: C(0x3a74cc), mid: C(0x6fc2f2), bottom: C(0xc4ecff),
    lightInt: 1.2, ambInt: 0.6, sun: C(0xffe7bf), amb: C(0xfff3e6), elevation: 0.9,
    night: 0.2, starOpacity: 0.0, exposure: 1.03, atmosphere: 0.55,
    grade: { sat: 1.08, contrast: 0.08, vignette: 0.2, white: L(1, 1, 1), lift: L(0, 0, 0) },
    glow: C(0xfff1c8), glowInt: 0.3, disc: C(0xfff4d6), discInt: 0, discSize: 0.05, crescent: 0,
  },
  // 2. Tramonto dorato: arancio all'orizzonte, viola in alto, sole sul bordo.
  //    Prima era cremisi + arancio fuoco: con ACES tutto il frame diventava rosso.
  {
    hold: 0.35, blend: 0.35,
    top: C(0x2e2466), mid: C(0xff8f52), bottom: C(0xffd98f),
    lightInt: 1.05, ambInt: 0.5, sun: C(0xffae6b), amb: C(0xffcfb0), elevation: 1.12,
    night: 0.4, starOpacity: 0.12, exposure: 1.0, atmosphere: 0.6,
    grade: { sat: 0.94, contrast: 0.1, vignette: 0.24, white: L(1.0, 0.98, 0.95), lift: L(0.012, 0.004, 0.018) },
    glow: C(0xffb347), glowInt: 0.9, disc: C(0xff8a30), discInt: 1.0, discSize: 0.05, crescent: 0,
  },
  // 3. Crepuscolo: rosa brace all'orizzonte, cielo che si spegne.
  {
    hold: 0.15, blend: 0.35,
    top: C(0x100b2c), mid: C(0xb54a5c), bottom: C(0xff8d5a),
    lightInt: 0.65, ambInt: 0.38, sun: C(0xff8a5a), amb: C(0x9a8cc8), elevation: 1.2,
    night: 0.8, starOpacity: 0.7, exposure: 1.12, atmosphere: 0.42,
    grade: { sat: 0.9, contrast: 0.1, vignette: 0.26, white: L(0.98, 0.96, 1.02), lift: L(0.01, 0.006, 0.024) },
    glow: C(0xff5a2a), glowInt: 0.6, disc: C(0xff6a2a), discInt: 0.6, discSize: 0.052, crescent: 0,
  },
  // 4. Notte di luna: blu e leggibile, non più un terreno quasi nero.
  {
    hold: 0.8, blend: 0.4,
    top: C(0x040817), mid: C(0x0c1a3c), bottom: C(0x1b3d62),
    lightInt: 0.45, ambInt: 0.42, sun: C(0x9fb8ff), amb: C(0x5a6aa8), elevation: 0.8,
    night: 1.0, starOpacity: 1.0, exposure: 1.18, atmosphere: 0.26,
    grade: { sat: 0.82, contrast: 0.1, vignette: 0.28, white: L(0.86, 0.95, 1.15), lift: L(0.004, 0.01, 0.03) },
    glow: C(0xbcd4ff), glowInt: 0.15, disc: C(0xdbe7ff), discInt: 0.55, discSize: 0.034, crescent: 0.82,
  },
  // 5. Alba: lavanda rosata all'orizzonte, pesca tenue al centro.
  {
    hold: 0.25, blend: 0.3,
    top: C(0x1d2a80), mid: C(0xff9fb0), bottom: C(0xffdcc0),
    lightInt: 0.85, ambInt: 0.44, sun: C(0xffc8a0), amb: C(0xffe0e8), elevation: 1.1,
    night: 0.5, starOpacity: 0.3, exposure: 1.05, atmosphere: 0.5,
    grade: { sat: 1.0, contrast: 0.08, vignette: 0.22, white: L(1.02, 0.98, 1.0), lift: L(0.01, 0.006, 0.014) },
    glow: C(0xffc2a0), glowInt: 0.7, disc: C(0xffb070), discInt: 0.8, discSize: 0.05, crescent: 0,
  },
];

/** Inizio di ogni stato nella timeline, in unità di ciclo. */
const stateStart = [];
let CYCLE_LENGTH = 0;
for (const st of skyStates) {
  stateStart.push(CYCLE_LENGTH);
  CYCLE_LENGTH += st.hold + st.blend;
}

/**
 * Cielo con gradiente radiale dinamico + campo stellare.
 * Il ciclo passa tra `skyStates` interpolando colori del cielo, colore,
 * intensità ed elevazione delle luci (fill/rim scalati col sole), stelle,
 * esposizione, grading e disco di sole/luna. `setView` (una volta per frame,
 * dopo il movimento della camera) orienta bagliore e disco e regola la nebbia.
 *
 * @param {THREE.Scene} scene
 * @param {{ambient:THREE.Light, sun:THREE.Light, fill?:THREE.Light, rim?:THREE.Light, setSunElevation?:(rad:number)=>void}} lights
 *        Restituite da `setupLighting(scene)` — necessarie per il ciclo giorno/notte.
 * @param {{lowQuality?:boolean}} [options]  qualità bassa: niente nebulosa, stelle né nuvole
 */
export function createSky(scene, lights, options = {}) {
  const qualityStage = options.lowQuality ? 2 : 0;
  // Il cielo shader copre tutta la vista: niente scene.background.
  scene.background = null;

  const skyUniforms = {
    topColor:    { value: skyStates[0].top.clone() },
    midColor:    { value: skyStates[0].mid.clone() },
    bottomColor: { value: skyStates[0].bottom.clone() },
    uSunH:       { value: new THREE.Vector3(1, 0, 0) },
    uLimb:       { value: 0.9 },
    uGlowColor:  { value: skyStates[0].glow.clone() },
    uGlow:       { value: 0 },
    uDiscDir:    { value: new THREE.Vector3(0, -1, 0) },
    uShadowDir:  { value: new THREE.Vector3(0, -1, 0) },
    uDiscColor:  { value: skyStates[0].disc.clone() },
    uDisc:       { value: 0 },
    uDiscSize:   { value: 0.05 },
    uCrescent:   { value: 0 },
  };

  const skyGeo = new THREE.SphereGeometry(400, qualityStage >= 2 ? 20 : 28, qualityStage >= 2 ? 16 : 24);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: skyVertexShader,
    fragmentShader: skyFragmentShader,
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    // In bassa il cielo va dritto a 8 bit e i gradienti fanno bande; in alta
    // il dithering lo fa il GradePass sull'immagine finale.
    dithering: qualityStage >= 2,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // ── Nebulosa / via lattea stilizzata (sfera dietro alle stelle) ───────────
  const nebulaGeo = new THREE.SphereGeometry(368, qualityStage >= 2 ? 20 : 28, qualityStage >= 2 ? 16 : 24);
  const galaxyPole = new THREE.Vector3(0.22, 0.91, 0.12).normalize();
  const nebulaUniforms = {
    uOpacity: { value: 0 },
    uTime: { value: 0 },
    uGalaxyPole: { value: galaxyPole.clone() },
  };
  const nebulaMat = new THREE.ShaderMaterial({
    vertexShader: nebulaVertexShader,
    fragmentShader: nebulaFragmentShader,
    uniforms: nebulaUniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });
  const nebula = new THREE.Mesh(nebulaGeo, nebulaMat);
  nebula.frustumCulled = false;
  nebula.renderOrder = -1;
  nebula.visible = qualityStage < 1;
  scene.add(nebula);

  // ── Campo stellare: colori e dimensioni variabili + twinkle in shader ─────
  const starsCount = qualityStage >= 2 ? 600 : 1200;
  const starPos = new Float32Array(starsCount * 3);
  const starColors = new Float32Array(starsCount * 3);
  const starSizes = new Float32Array(starsCount);
  const starRadius = 360;
  const _c = new THREE.Color();
  const starPalette = [
    0xffffff, 0xe8f4ff, 0xd4e8ff, 0xfff8f0, 0xffeedd,
    0xaaccff, 0x88ddff, 0xffcc88, 0xffaa99, 0xdd99ff,
    0xaaeecc, 0xffb6c8, 0x9fb7ff, 0x7fdfff,
  ];
  for (let i = 0; i < starsCount; i++) {
    const theta = 2 * Math.PI * Math.random();
    const phi = Math.acos(2 * Math.random() - 1);
    const j = i * 3;
    starPos[j]     = starRadius * Math.sin(phi) * Math.cos(theta);
    starPos[j + 1] = starRadius * Math.cos(phi);
    starPos[j + 2] = starRadius * Math.sin(phi) * Math.sin(theta);
    const roll = Math.random();
    let hex;
    if (roll < 0.58) hex = starPalette[Math.floor(Math.random() * 4)];
    else if (roll < 0.88) hex = starPalette[4 + Math.floor(Math.random() * 6)];
    else hex = starPalette[10 + Math.floor(Math.random() * 4)];
    _c.setHex(hex);
    const sat = 0.88 + Math.random() * 0.12;
    _c.multiplyScalar(sat);
    starColors[j]     = _c.r;
    starColors[j + 1] = _c.g;
    starColors[j + 2] = _c.b;
    const sRoll = Math.random();
    if (sRoll < 0.72) starSizes[i] = 1.0 + Math.random() * 1.35;
    else if (sRoll < 0.94) starSizes[i] = 2.2 + Math.random() * 1.8;
    else starSizes[i] = 4.0 + Math.random() * 2.5;
  }
  const starsGeo = new THREE.BufferGeometry();
  starsGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starsGeo.setAttribute('starColor', new THREE.BufferAttribute(starColors, 3));
  starsGeo.setAttribute('starSize', new THREE.BufferAttribute(starSizes, 1));
  const starUniforms = {
    uOpacity: { value: 0 },
    uTime: { value: 0 },
  };
  const starsMat = new THREE.ShaderMaterial({
    vertexShader: starsVertexShader,
    fragmentShader: starsFragmentShader,
    uniforms: starUniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const stars = new THREE.Points(starsGeo, starsMat);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  scene.add(stars);

  // ── Nuvole low-poly ─────────────────────────────────────────────────────────
  // Poco sopra la quota di volo: passano sopra la testa e danno profondità
  // all'orizzonte. Ogni nuvola è un grappolo di icosaedri schiacciati, con
  // flatShading e illuminazione vera (pancia in ombra, cima al sole). Tutte le
  // nuvole sono fuse in un'unica geometria: una sola draw call.
  const cloudMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0x8a96b4,
    flatShading: true,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
    fog: true,
  });
  const cloudTintScratch = new THREE.Color();
  const cloudRoot = new THREE.Group();
  cloudRoot.frustumCulled = false;
  cloudRoot.renderOrder = 0;

  const cloudCount = qualityStage >= 2 ? 0 : 16;
  if (cloudCount > 0) {
    const puffBase = new THREE.IcosahedronGeometry(1, 1);
    const pieces = [];
    const n = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
    const m = new THREE.Matrix4(), basis = new THREE.Matrix4(), q = new THREE.Quaternion();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3();
    for (let c = 0; c < cloudCount; c++) {
      n.set(Math.random() * 2 - 1, (Math.random() * 2 - 1) * 0.85, Math.random() * 2 - 1).normalize();
      u.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
      v.crossVectors(n, u);
      const yaw = Math.random() * Math.PI * 2;
      u.multiplyScalar(Math.cos(yaw)).addScaledVector(v.clone(), Math.sin(yaw));
      // Terna destrorsa (u, n, u × n): una mancina sarebbe una riflessione e
      // setFromRotationMatrix ne ricaverebbe un quaternione senza senso.
      v.crossVectors(u, n);
      basis.makeBasis(u, n, v);
      q.setFromRotationMatrix(basis);
      const R = FLY_ALTITUDE + 9 + Math.random() * 5;
      const size = 1.3 + Math.random() * 1.3;
      const puffs = 4 + Math.floor(Math.random() * 4);
      for (let p = 0; p < puffs; p++) {
        const along = (p / (puffs - 1) - 0.5) * 5.2 * size;
        const bulge = 1 - Math.abs(p / (puffs - 1) - 0.5) * 1.1; // più gonfie al centro
        const r = size * (0.9 + 0.8 * bulge) * (0.8 + Math.random() * 0.4);
        pos.copy(n).multiplyScalar(R)
          .addScaledVector(u, along)
          .addScaledVector(v, (Math.random() - 0.5) * 1.6 * size)
          .addScaledVector(n, r * 0.25 * bulge);
        scl.set(r * 1.25, r * 0.7, r);
        m.compose(pos, q, scl);
        pieces.push(puffBase.clone().applyMatrix4(m));
      }
    }
    const merged = mergeGeometries(pieces, false);
    for (const g of pieces) g.dispose();
    puffBase.dispose();
    const clouds = new THREE.Mesh(merged, cloudMat);
    clouds.frustumCulled = false;
    cloudRoot.add(clouds);
  }
  cloudRoot.visible = cloudCount > 0;
  scene.add(cloudRoot);

  // Intensità base di fill/rim per poterle scalare col "giorno"
  const baseFill = lights?.fill?.intensity ?? 0;
  const baseRim  = lights?.rim?.intensity  ?? 0;
  const maxLightInt = skyStates.reduce((m, s) => Math.max(m, s.lightInt), 0);

  // ── Stelle cadenti ──────────────────────────────────────────────────────────
  // Pool fisso: un solo LineSegments con uno slot per stella, creato qui e mai
  // rimosso. Prima ogni stella cadente creava geometria, materiale e linea e li
  // distruggeva alla fine: allocazioni in partita e un materiale nuovo da
  // compilare. La coda sfuma nel nero via colore di vertice (blending additivo).
  const SHOOTING_SLOTS = 2;
  const ssPos = new Float32Array(SHOOTING_SLOTS * 6);
  const ssCol = new Float32Array(SHOOTING_SLOTS * 6);
  const ssGeo = new THREE.BufferGeometry();
  const ssPosAttr = new THREE.BufferAttribute(ssPos, 3).setUsage(THREE.DynamicDrawUsage);
  const ssColAttr = new THREE.BufferAttribute(ssCol, 3).setUsage(THREE.DynamicDrawUsage);
  ssGeo.setAttribute('position', ssPosAttr);
  ssGeo.setAttribute('color', ssColAttr);
  const ssMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const ssLines = new THREE.LineSegments(ssGeo, ssMat);
  ssLines.frustumCulled = false;
  ssLines.renderOrder = 0;
  ssLines.visible = false;
  scene.add(ssLines);

  const shootingStars = Array.from({ length: SHOOTING_SLOTS }, () => ({
    active: false,
    start: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    color: new THREE.Color(),
    speed: 0, trailLength: 0, duration: 1, age: 0,
  }));
  const SHOOTING_HUES = [0xffffff, 0xcceeff, 0xaaffff, 0xffe8f8, 0xeeccff].map(h => new THREE.Color(h));
  let shootingStarTimer = 2 + Math.random() * 3;

  function spawnShootingStar() {
    const s = shootingStars.find(x => !x.active);
    if (!s) return;
    const R = 348;
    const phi   = Math.acos(2 * Math.random() - 1);
    const theta = 2 * Math.PI * Math.random();
    s.start.set(
      R * Math.sin(phi) * Math.cos(theta),
      R * Math.cos(phi),
      R * Math.sin(phi) * Math.sin(theta)
    );

    // Direzione tangente casuale alla sfera
    _ssHead.copy(s.start).normalize(); // radiale
    _ssTail.set(Math.abs(_ssHead.y) < 0.9 ? 0 : 1, Math.abs(_ssHead.y) < 0.9 ? 1 : 0, 0)
      .cross(_ssHead).normalize();      // t1
    const a = Math.random() * 2 * Math.PI;
    s.dir.crossVectors(_ssHead, _ssTail).multiplyScalar(Math.sin(a)) // t2 · sin
      .addScaledVector(_ssTail, Math.cos(a));

    s.speed       = 140 + Math.random() * 100;
    s.trailLength = 18  + Math.random() * 22;
    s.duration    = 0.9 + Math.random() * 0.6;
    s.age = 0;
    s.color.copy(SHOOTING_HUES[Math.floor(Math.random() * SHOOTING_HUES.length)]);
    s.active = true;
  }

  function updateShootingStars(delta, nightFactor) {
    if (qualityStage >= 2) return;
    shootingStarTimer -= delta;
    if (shootingStarTimer <= 0) {
      // Solo dal tramonto in poi: nel cielo azzurro sarebbero righe bianche.
      if (nightFactor > 0.35) spawnShootingStar();
      shootingStarTimer = 7 + Math.random() * 10;
    }

    let any = false;
    for (let i = 0; i < SHOOTING_SLOTS; i++) {
      const s = shootingStars[i];
      const o = i * 6;
      if (s.active) {
        s.age += delta;
        if (s.age >= s.duration) s.active = false;
      }
      if (!s.active) {
        ssCol.fill(0, o, o + 6);
        continue;
      }
      any = true;
      const t = s.age / s.duration;
      _ssHead.copy(s.start).addScaledVector(s.dir, s.speed * s.age);
      const tailOffset = Math.min(s.trailLength, s.speed * s.age);
      _ssTail.copy(_ssHead).addScaledVector(s.dir, -tailOffset);
      ssPos[o] = _ssTail.x; ssPos[o + 1] = _ssTail.y; ssPos[o + 2] = _ssTail.z;
      ssPos[o + 3] = _ssHead.x; ssPos[o + 4] = _ssHead.y; ssPos[o + 5] = _ssHead.z;

      // fade-in rapido, fade-out sull'ultimo 35%
      const fadeIn  = Math.min(t * 8, 1);
      const fadeOut = t > 0.65 ? Math.max(1 - (t - 0.65) / 0.35, 0) : 1;
      const k = fadeIn * fadeOut * 0.9 * Math.max(nightFactor, 0.45);
      ssCol[o] = ssCol[o + 1] = ssCol[o + 2] = 0; // coda
      ssCol[o + 3] = s.color.r * k; ssCol[o + 4] = s.color.g * k; ssCol[o + 5] = s.color.b * k;
    }
    ssLines.visible = any;
    if (any) {
      ssPosAttr.needsUpdate = true;
      ssColAttr.needsUpdate = true;
    }
  }

  // ── Stato interpolato del ciclo (oggetti riusati: niente allocazioni) ──────
  const grade = {
    sat: 1, contrast: 0, vignette: 0.2,
    white: new THREE.Color(1, 1, 1),
    lift: new THREE.Color(0, 0, 0),
  };
  let exposure = skyStates[0].exposure;
  let atmosphere = skyStates[0].atmosphere;

  let time = 0;
  let lastNightFactor = 0;

  /** Stato corrente e successivo della timeline, più il peso di sfumatura. */
  const _loc = { idx: 0, next: 1, t: 0 };
  function locate(tm) {
    const phase = ((tm % CYCLE_LENGTH) + CYCLE_LENGTH) % CYCLE_LENGTH;
    let idx = skyStates.length - 1;
    for (let i = 1; i < skyStates.length; i++) {
      if (phase < stateStart[i]) { idx = i - 1; break; }
    }
    const st = skyStates[idx];
    const local = phase - stateStart[idx];
    _loc.idx = idx;
    _loc.next = (idx + 1) % skyStates.length;
    _loc.t = local <= st.hold ? 0 : THREE.MathUtils.smoothstep((local - st.hold) / st.blend, 0, 1);
    return _loc;
  }

  function update(delta) {
    time += delta * CYCLE_SPEED;
    const { idx, next, t } = locate(time);
    const cur = skyStates[idx];
    const nxt = skyStates[next];
    const lerp = THREE.MathUtils.lerp;

    skyUniforms.topColor.value.lerpColors(cur.top, nxt.top, t);
    skyUniforms.midColor.value.lerpColors(cur.mid, nxt.mid, t);
    skyUniforms.bottomColor.value.lerpColors(cur.bottom, nxt.bottom, t);
    skyUniforms.uGlowColor.value.lerpColors(cur.glow, nxt.glow, t);
    skyUniforms.uGlow.value = lerp(cur.glowInt, nxt.glowInt, t);
    skyUniforms.uDiscColor.value.lerpColors(cur.disc, nxt.disc, t);
    skyUniforms.uDisc.value = lerp(cur.discInt, nxt.discInt, t);
    skyUniforms.uDiscSize.value = lerp(cur.discSize, nxt.discSize, t);
    skyUniforms.uCrescent.value = lerp(cur.crescent, nxt.crescent, t);

    const sunInt = lerp(cur.lightInt, nxt.lightInt, t);
    const ambInt = lerp(cur.ambInt,   nxt.ambInt,   t);
    if (lights?.sun) {
      lights.sun.intensity = sunInt;
      lights.sun.color.lerpColors(cur.sun, nxt.sun, t);
    }
    if (lights?.ambient) {
      lights.ambient.intensity = ambInt;
      lights.ambient.color.lerpColors(cur.amb, nxt.amb, t);
    }
    lights?.setSunElevation?.(lerp(cur.elevation, nxt.elevation, t));

    // Scala fill/rim proporzionalmente al sole per coerenza visiva
    const dayFactor = sunInt / maxLightInt;
    if (lights?.fill) lights.fill.intensity = baseFill * dayFactor;
    if (lights?.rim)  lights.rim.intensity  = baseRim  * dayFactor;

    exposure = lerp(cur.exposure, nxt.exposure, t);
    atmosphere = lerp(cur.atmosphere, nxt.atmosphere, t);
    grade.sat = lerp(cur.grade.sat, nxt.grade.sat, t);
    grade.contrast = lerp(cur.grade.contrast, nxt.grade.contrast, t);
    grade.vignette = lerp(cur.grade.vignette, nxt.grade.vignette, t);
    grade.white.lerpColors(cur.grade.white, nxt.grade.white, t);
    grade.lift.lerpColors(cur.grade.lift, nxt.grade.lift, t);

    const nf = lerp(cur.night, nxt.night, t);
    lastNightFactor = nf;
    const starOpacity = qualityStage >= 2 ? 0 : lerp(cur.starOpacity, nxt.starOpacity, t);
    starUniforms.uOpacity.value = starOpacity;
    // Soglie alte: la nebulosa sale solo in tarda sera / notte piena
    const nebulaOpacity = qualityStage >= 1 ? 0 : THREE.MathUtils.smoothstep(nf, 0.78, 1.0) * 0.8;
    nebulaUniforms.uOpacity.value = nebulaOpacity;

    // probeHidden: la sonda F9 li sta spegnendo per misurarne il costo.
    stars.visible = starOpacity > 0.03 && !stars.userData.probeHidden;
    nebula.visible = nebulaOpacity > 0.03 && !nebula.userData.probeHidden;
    if (stars.visible) starUniforms.uTime.value += delta;
    if (nebula.visible) nebulaUniforms.uTime.value += delta * 0.4;

    // Lenta rotazione della volta stellata (frame-rate independent)
    if (stars.visible) {
      stars.rotation.y += 0.012 * delta;
      stars.rotation.x += 0.006 * delta;
    }
    if (nebula.visible) {
      nebula.rotation.y += 0.0055 * delta;
      nebula.rotation.x -= 0.003 * delta;
    }

    // Nuvole: tint verso il cielo, quasi invisibili a notte piena
    // smoothstep(x, min, max): 0 se x<=min, 1 se x>=max — x deve essere nf
    const cloudNightFade = 1.0 - THREE.MathUtils.smoothstep(nf, 0.25, 0.95);
    cloudMat.opacity = 0.94 * cloudNightFade;
    cloudRoot.visible = cloudCount > 0 && cloudMat.opacity > 0.03 && !cloudRoot.userData.probeHidden;
    cloudTintScratch.set(0xffffff).lerp(skyUniforms.midColor.value, 0.12 + nf * 0.2);
    cloudMat.color.copy(cloudTintScratch);
    cloudMat.emissive.set(0x8a96b4).lerp(skyUniforms.midColor.value, 0.25).multiplyScalar(1 - nf * 0.65);

    if (cloudRoot.visible) {
      cloudRoot.rotation.y += 0.005 * delta;
      cloudRoot.rotation.x += 0.0025 * delta;
    }

    updateShootingStars(delta, nf);
  }

  /**
   * Colore del cielo in una direzione a `angle` rad dal nadir: stesso
   * gradiente dello shader, calcolato sulla CPU.
   */
  function skyColorAt(angle, out) {
    let f = THREE.MathUtils.clamp(angle / 1.8, 0, 1);
    f = f * f * (3 - 2 * f);
    const u = skyUniforms;
    if (f < 0.55) return out.lerpColors(u.bottomColor.value, u.midColor.value, f / 0.55);
    return out.lerpColors(u.midColor.value, u.topColor.value, (f - 0.55) / 0.45);
  }

  /**
   * Orienta bagliore e disco rispetto a camera e sole, e porta la nebbia al
   * colore del cielo proprio dietro l'orizzonte del pianeta: prima copiava il
   * colore del bordo schermo (scuro), e con quelle distanze non toccava nulla.
   * La chiama il cielo stesso appena prima di essere disegnato (vedi sotto).
   * @param {THREE.Vector3} camPos
   */
  function setView(camPos) {
    const r = camPos.length();
    if (r < 1e-3) return;
    _viewUp.copy(camPos).divideScalar(r);
    const limb = Math.asin(Math.min(1, PLANET_RADIUS / r));
    const u = skyUniforms;
    u.uLimb.value = limb;

    const sunDir = lights?.sun?.position;
    if (sunDir) _sunH.copy(sunDir).addScaledVector(_viewUp, -sunDir.dot(_viewUp));
    if (!sunDir || _sunH.lengthSq() < 1e-8) {
      // Sole allo zenit (o assente): un azimut qualsiasi, purché tangente.
      _sunH.set(1, 0, 0);
      if (Math.abs(_viewUp.x) > 0.9) _sunH.set(0, 1, 0);
      _sunH.addScaledVector(_viewUp, -_sunH.dot(_viewUp));
    }
    _sunH.normalize();
    u.uSunH.value.copy(_sunH);

    // Disco poco sopra il bordo, nella direzione del sole (centro = −su).
    const a = limb + DISC_LIFT;
    u.uDiscDir.value.copy(_viewUp).multiplyScalar(-Math.cos(a)).addScaledVector(_sunH, Math.sin(a));
    // Ombra della falce: spostata di lato e un filo in alto rispetto al disco.
    _side.crossVectors(_viewUp, _sunH);
    const off = u.uDiscSize.value * 0.75;
    u.uShadowDir.value.copy(u.uDiscDir.value)
      .addScaledVector(_side, off)
      .addScaledVector(_viewUp, off * 0.35)
      .normalize();

    const fog = scene.fog;
    if (fog) {
      const altitude = Math.max(2, r - PLANET_RADIUS);
      skyColorAt(limb + 0.04, fog.color);
      fog.near = altitude + FOG_NEAR_OFFSET;
      fog.far = fog.near + FOG_RANGE * Math.sqrt(Math.max(1, altitude / FOG_REF_ALTITUDE));
    }
  }

  // Il cielo è disegnato per primo (renderOrder −1, opaco): orientarlo qui
  // vale per qualunque camera lo stia disegnando (anche le inquadrature libere
  // dei test) e la nebbia è già giusta per tutti gli oggetti che seguono.
  const _camPos = new THREE.Vector3();
  sky.onBeforeRender = (_renderer, _scene, cam) => {
    setView(_camPos.setFromMatrixPosition(cam.matrixWorld));
  };

  return {
    sky,
    stars,
    nebula,
    cloudRoot,
    update,
    setView,
    /** 0..1: 0=giorno, 1=notte */
    getNightFactor: () => lastNightFactor,
    /**
     * Solo per test e screenshot: salta a una fase del ciclo. La parte intera
     * è lo stato (0 giorno, 1 tramonto, 2 crepuscolo, 3 notte, 4 alba), la
     * frazione la posizione dentro la sua durata: 0.35 è giorno pieno, 1.35
     * tramonto, 3.1 notte, come prima del ribilanciamento.
     */
    setPhase(p) {
      const n = skyStates.length;
      const i = ((Math.floor(p) % n) + n) % n;
      const st = skyStates[i];
      time = stateStart[i] + (p - Math.floor(p)) * (st.hold + st.blend);
    },
    /** Colore del cielo all'orizzonte (tinge l'atmosfera del pianeta). */
    horizonColor: skyUniforms.midColor.value,
    /** Esposizione della fase corrente: va in renderer.toneMappingExposure. */
    get exposure() { return exposure; },
    /**
     * Intensità dell'alone atmosferico del pianeta per la fase corrente: di
     * notte brillava quanto a mezzogiorno, una fascia chiara attorno al buio.
     */
    get atmosphere() { return atmosphere; },
    /** Grading della fase corrente, per il GradePass (qualità alta). */
    grade,
  };
}
