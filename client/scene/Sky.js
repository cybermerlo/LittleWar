import * as THREE from 'three';
import { FLY_ALTITUDE } from '../../shared/constants.js';

/**
 * Velocità del ciclo giorno/notte.
 * Unità: "transizioni di stato al secondo". Con 5 stati in skyStates:
 *  - 0.015 → ciclo completo ~5:30 min
 *  - 0.03  → ciclo completo ~2:45 min  (default)
 *  - 0.06  → ciclo completo ~1:20 min
 *  - 0.09  → ciclo completo ~55 sec    (frenetico)
 * Modifica questo valore per regolare la velocità del cielo/luci/stelle.
 */
const CYCLE_SPEED = 0.03;

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
  uniform vec3 bottomColor; // epicentro (dietro al pianeta)
  varying vec3 vWorldPosition;

  void main() {
    vec3 viewDir = normalize(vWorldPosition - cameraPosition);
    vec3 centerDir = normalize(-cameraPosition); // direzione verso (0,0,0) dove c'è il pianeta
    float dotProduct = dot(viewDir, centerDir);
    float angle = acos(clamp(dotProduct, -1.0, 1.0));
    // regola l'ampiezza del gradiente: valori più alti = transizione più larga e visibile
    float mixFactor = clamp(angle / 1.8, 0.0, 1.0);
    mixFactor = smoothstep(0.0, 1.0, mixFactor);
    gl_FragColor = vec4(mix(bottomColor, topColor, mixFactor), 1.0);
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
  }
`;

// top = bordi schermo, bottom = epicentro luminoso dietro al pianeta
const skyStates = [
  // 1. Giorno Alieno (viola scuro ai bordi, ottanio neon al centro)
  { top: new THREE.Color(0x2b0f4c), bottom: new THREE.Color(0x00f2fe), lightInt: 1.2, ambInt: 0.6, starOpacity: 0.2 },
  // 2. Tramonto Synthwave (magenta ai bordi, arancio al centro)
  { top: new THREE.Color(0xd500f9), bottom: new THREE.Color(0xff9100), lightInt: 1.0, ambInt: 0.5, starOpacity: 0.4 },
  // 3. Crepuscolo Scarlatto (cremisi ai bordi, rosso al centro)
  { top: new THREE.Color(0x5d001e), bottom: new THREE.Color(0xff1744), lightInt: 0.6, ambInt: 0.3, starOpacity: 0.8 },
  // 4. Notte Abissale (blu cosmico ai bordi, smeraldo oscuro al centro)
  { top: new THREE.Color(0x050514), bottom: new THREE.Color(0x00332a), lightInt: 0.1, ambInt: 0.2, starOpacity: 1.0 },
  // 5. Alba Eterea (indaco ai bordi, menta tenue al centro)
  { top: new THREE.Color(0x1a237e), bottom: new THREE.Color(0x64ffda), lightInt: 0.8, ambInt: 0.4, starOpacity: 0.5 },
];

/**
 * Cielo con gradiente radiale dinamico + campo stellare.
 * Il ciclo passa tra `skyStates` interpolando top/bottom color, intensità luci
 * (ambient/sun, con fill/rim scalati proporzionalmente), opacità stelle e fog.
 *
 * @param {THREE.Scene} scene
 * @param {{ambient:THREE.Light, sun:THREE.Light, fill?:THREE.Light, rim?:THREE.Light}} lights
 *        Restituite da `setupLighting(scene)` — necessarie per il ciclo giorno/notte.
 * @returns {{sky:THREE.Mesh, stars:THREE.Points, cloudRoot:THREE.Group, update:(delta:number)=>void}}
 */
export function createSky(scene, lights) {
  // Il cielo shader copre tutta la vista: niente scene.background.
  scene.background = null;

  const skyUniforms = {
    topColor:    { value: skyStates[0].top.clone() },
    bottomColor: { value: skyStates[0].bottom.clone() },
  };

  const skyGeo = new THREE.SphereGeometry(400, 32, 32);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: skyVertexShader,
    fragmentShader: skyFragmentShader,
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // ── Nebulosa / via lattea stilizzata (sfera dietro alle stelle) ───────────
  const nebulaGeo = new THREE.SphereGeometry(368, 40, 40);
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
  scene.add(nebula);

  // ── Campo stellare: colori e dimensioni variabili + twinkle in shader ─────
  const starsCount = 1800;
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

  // ── Nuvole low-poly (poco sopra il raggio di volo, così restano “basse”) ───
  const CLOUD_SHELL_R = FLY_ALTITUDE + 12;
  const puffGeo = new THREE.SphereGeometry(1, 7, 5);
  const cloudMat = new THREE.MeshBasicMaterial({
    color: 0xeef2fb,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
    fog: true,
  });
  const cloudTintScratch = new THREE.Color();
  const cloudRoot = new THREE.Group();
  cloudRoot.frustumCulled = false;
  cloudRoot.renderOrder = 0;

  const _cloudNormal = new THREE.Vector3();
  const _qAlignCloud = new THREE.Quaternion();
  const _qSpinCloud = new THREE.Quaternion();

  function addCumulusCloud(parent) {
    const group = new THREE.Group();
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    const sinP = Math.sin(phi);
    group.position.set(
      CLOUD_SHELL_R * sinP * Math.cos(theta),
      CLOUD_SHELL_R * Math.cos(phi),
      CLOUD_SHELL_R * sinP * Math.sin(theta)
    );
    // Asse locale +Y = normale uscente dal pianeta → nuvola “sdraiata” sul tangente
    _cloudNormal.copy(group.position).normalize();
    _qAlignCloud.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _cloudNormal);
    _qSpinCloud.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    group.quaternion.copy(_qAlignCloud).multiply(_qSpinCloud);

    const blobs = 3 + Math.floor(Math.random() * 3);
    for (let b = 0; b < blobs; b++) {
      const mesh = new THREE.Mesh(puffGeo, cloudMat);
      mesh.position.set(
        (Math.random() - 0.5) * 3.2,
        (Math.random() - 0.5) * 0.75,
        (Math.random() - 0.5) * 3.2
      );
      const sWide = 2.4 + Math.random() * 4.2;
      const sThin = sWide * (0.28 + Math.random() * 0.16);
      const sWideB = sWide * (0.75 + Math.random() * 0.35);
      mesh.scale.set(sWideB, sThin, sWide);
      group.add(mesh);
    }
    parent.add(group);
  }

  const cloudCount = 12;
  for (let c = 0; c < cloudCount; c++) addCumulusCloud(cloudRoot);
  scene.add(cloudRoot);

  // Intensità base di fill/rim per poterle scalare col "giorno"
  const baseFill = lights?.fill?.intensity ?? 0;
  const baseRim  = lights?.rim?.intensity  ?? 0;
  const maxLightInt = skyStates.reduce((m, s) => Math.max(m, s.lightInt), 0);

  // ── Stelle cadenti ──────────────────────────────────────────────────────────
  const shootingStars = [];
  let shootingStarTimer = 2 + Math.random() * 3;

  function spawnShootingStar() {
    const R = 348;
    const phi   = Math.acos(2 * Math.random() - 1);
    const theta = 2 * Math.PI * Math.random();
    const start = new THREE.Vector3(
      R * Math.sin(phi) * Math.cos(theta),
      R * Math.cos(phi),
      R * Math.sin(phi) * Math.sin(theta)
    );

    // Direzione tangente casuale alla sfera
    const radial = start.clone().normalize();
    const up = Math.abs(radial.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const t1 = up.clone().cross(radial).normalize();
    const t2 = radial.clone().cross(t1).normalize();
    const a   = Math.random() * 2 * Math.PI;
    const dir = t1.clone().multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a));

    const speed       = 140 + Math.random() * 100;
    const trailLength = 18  + Math.random() * 22;
    const duration    = 0.9 + Math.random() * 0.6;

    const geo = new THREE.BufferGeometry().setFromPoints([start.clone(), start.clone()]);
    const trailHue = [0xffffff, 0xcceeff, 0xaaffff, 0xffe8f8, 0xeeccff][Math.floor(Math.random() * 5)];
    const mat = new THREE.LineBasicMaterial({
      color: trailHue,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 0;
    scene.add(line);

    shootingStars.push({ line, geo, mat, start, dir, speed, trailLength, duration, age: 0 });
  }

  function updateShootingStars(delta, nightFactor) {
    shootingStarTimer -= delta;
    if (shootingStarTimer <= 0) {
      spawnShootingStar();
      shootingStarTimer = 7 + Math.random() * 10;
    }

    for (let i = shootingStars.length - 1; i >= 0; i--) {
      const s = shootingStars[i];
      s.age += delta;
      const t = s.age / s.duration;

      if (t >= 1) {
        scene.remove(s.line);
        s.geo.dispose();
        s.mat.dispose();
        shootingStars.splice(i, 1);
        continue;
      }

      const head = s.start.clone().addScaledVector(s.dir, s.speed * s.age);
      const tailOffset = Math.min(s.trailLength, s.speed * s.age);
      const tail = head.clone().addScaledVector(s.dir, -tailOffset);

      const pos = s.geo.attributes.position;
      pos.setXYZ(0, tail.x, tail.y, tail.z);
      pos.setXYZ(1, head.x, head.y, head.z);
      pos.needsUpdate = true;

      // fade-in rapido, fade-out sull'ultimo 35%
      const fadeIn  = Math.min(t * 8, 1);
      const fadeOut = t > 0.65 ? Math.max(1 - (t - 0.65) / 0.35, 0) : 1;
      s.mat.opacity = fadeIn * fadeOut * 0.9 * Math.max(nightFactor, 0.45);
    }
  }

  let time = 0;
  let lastNightFactor = 0;

  function update(delta) {
    time += delta * CYCLE_SPEED;
    const total = skyStates.length;
    const phase = ((time % total) + total) % total;
    const idx = Math.floor(phase);
    const next = (idx + 1) % total;
    let t = phase - idx;
    t = THREE.MathUtils.smoothstep(t, 0, 1);

    const cur = skyStates[idx];
    const nxt = skyStates[next];

    skyUniforms.topColor.value.lerpColors(cur.top, nxt.top, t);
    skyUniforms.bottomColor.value.lerpColors(cur.bottom, nxt.bottom, t);

    const sunInt = THREE.MathUtils.lerp(cur.lightInt, nxt.lightInt, t);
    const ambInt = THREE.MathUtils.lerp(cur.ambInt,   nxt.ambInt,   t);
    if (lights?.sun)     lights.sun.intensity     = sunInt;
    if (lights?.ambient) lights.ambient.intensity = ambInt;

    // Scala fill/rim proporzionalmente al sole per coerenza visiva
    const dayFactor = sunInt / maxLightInt;
    if (lights?.fill) lights.fill.intensity = baseFill * dayFactor;
    if (lights?.rim)  lights.rim.intensity  = baseRim  * dayFactor;

    const fieldOpacity = THREE.MathUtils.lerp(cur.starOpacity, nxt.starOpacity, t);
    starUniforms.uOpacity.value = fieldOpacity;
    lastNightFactor = fieldOpacity;
    // Soglie alte: la nebulosa sale solo in tarda sera / notte piena
    nebulaUniforms.uOpacity.value = THREE.MathUtils.smoothstep(fieldOpacity, 0.78, 1.0) * 0.95;

    starUniforms.uTime.value += delta;
    nebulaUniforms.uTime.value += delta * 0.4;

    // Fog color segue il bordo del cielo per transizione fluida sull'orizzonte
    if (scene.fog) scene.fog.color.copy(skyUniforms.topColor.value);

    // Lenta rotazione della volta stellata (frame-rate independent)
    stars.rotation.y += 0.012 * delta;
    stars.rotation.x += 0.006 * delta;
    nebula.rotation.y += 0.0055 * delta;
    nebula.rotation.x -= 0.003 * delta;

    // Nuvole: tint verso il cielo, quasi invisibili quando le stelle sono al massimo
    // Stessa “notte” delle stelle (0=giorno, 1=notte): nuvole spariscono in morbida
    const nf = fieldOpacity;
    // smoothstep(x, min, max): 0 se x<=min, 1 se x>=max — x deve essere nf
    const cloudNightFade = 1.0 - THREE.MathUtils.smoothstep(nf, 0.2, 0.9);
    cloudMat.opacity = 0.52 * cloudNightFade;
    cloudTintScratch.set(0xf0f5ff).lerp(skyUniforms.topColor.value, 0.2 + nf * 0.14);
    cloudMat.color.copy(cloudTintScratch);

    cloudRoot.rotation.y += 0.005 * delta;
    cloudRoot.rotation.x += 0.0025 * delta;

    updateShootingStars(delta, fieldOpacity);
  }

  return {
    sky,
    stars,
    cloudRoot,
    update,
    /** 0..1: 0=giorno, 1=notte (derivato da opacità stelle) */
    getNightFactor: () => lastNightFactor,
  };
}
