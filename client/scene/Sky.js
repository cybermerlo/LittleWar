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

  // ── Campo stellare uniforme sulla sfera ──────────────────────────────────
  const starsCount = 1500;
  const starPos = new Float32Array(starsCount * 3);
  const starRadius = 360;
  for (let i = 0; i < starsCount; i++) {
    const theta = 2 * Math.PI * Math.random();
    const phi = Math.acos(2 * Math.random() - 1);
    const j = i * 3;
    starPos[j]     = starRadius * Math.sin(phi) * Math.cos(theta);
    starPos[j + 1] = starRadius * Math.cos(phi);
    starPos[j + 2] = starRadius * Math.sin(phi) * Math.sin(theta);
  }
  const starsGeo = new THREE.BufferGeometry();
  starsGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starsMat = new THREE.PointsMaterial({
    size: 1.4,
    color: 0xffffff,
    transparent: true,
    opacity: 0,
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
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
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

    starsMat.opacity = THREE.MathUtils.lerp(cur.starOpacity, nxt.starOpacity, t);
    lastNightFactor = starsMat.opacity;

    // Fog color segue il bordo del cielo per transizione fluida sull'orizzonte
    if (scene.fog) scene.fog.color.copy(skyUniforms.topColor.value);

    // Lenta rotazione della volta stellata (frame-rate independent)
    stars.rotation.y += 0.012 * delta;
    stars.rotation.x += 0.006 * delta;

    // Nuvole: tint verso il cielo, quasi invisibili quando le stelle sono al massimo
    // Stessa “notte” delle stelle (0=giorno, 1=notte): nuvole spariscono in morbida
    const nf = starsMat.opacity;
    // smoothstep(x, min, max): 0 se x<=min, 1 se x>=max — x deve essere nf
    const cloudNightFade = 1.0 - THREE.MathUtils.smoothstep(nf, 0.2, 0.9);
    cloudMat.opacity = 0.52 * cloudNightFade;
    cloudTintScratch.set(0xf0f5ff).lerp(skyUniforms.topColor.value, 0.2 + nf * 0.14);
    cloudMat.color.copy(cloudTintScratch);

    cloudRoot.rotation.y += 0.005 * delta;
    cloudRoot.rotation.x += 0.0025 * delta;

    updateShootingStars(delta, starsMat.opacity);
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
