import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';

export const PLANET_RADIUS = 50;
const DETAIL = 4;         // suddivisione icosahedron
const NOISE_SCALE = 0.7;
const MOUNTAIN_HEIGHT = 5.2;
const WATER_LEVEL = 0.05; // altitudine normalizzata al di sotto della quale = acqua

// Palette pastello per altitudine (normalizzata 0..1)
const COLORS = [
  { h: -0.02, color: new THREE.Color(0x3f88c6) }, // acqua profonda
  { h:  0.00, color: new THREE.Color(0x5ea8d9) }, // acqua
  { h:  0.04, color: new THREE.Color(0xf5df9f) }, // spiaggia
  { h:  0.11, color: new THREE.Color(0x8ecf73) }, // pianura
  { h:  0.30, color: new THREE.Color(0x6eb25c) }, // colline
  { h:  0.58, color: new THREE.Color(0xb09c86) }, // roccia
  { h:  0.86, color: new THREE.Color(0xfff9f1) }, // neve
  { h:  1.00, color: new THREE.Color(0xffffff) },
];

function altitudeColor(normalizedH) {
  for (let i = 0; i < COLORS.length - 1; i++) {
    const a = COLORS[i], b = COLORS[i + 1];
    if (normalizedH <= b.h) {
      const t = THREE.MathUtils.clamp((normalizedH - a.h) / (b.h - a.h), 0, 1);
      const smoothT = t * t * (3 - 2 * t);
      return new THREE.Color().lerpColors(a.color, b.color, smoothT);
    }
  }
  return COLORS[COLORS.length - 1].color.clone();
}

function createToonGradientMap() {
  // 4 gradini morbidi per uno shading cartoon leggero.
  const data = new Uint8Array([42, 110, 182, 255]);
  const gradientMap = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

export function createPlanet(scene) {
  const noise3D = createNoise3D(() => 0.42); // seed fisso

  const geo = new THREE.IcosahedronGeometry(PLANET_RADIUS, DETAIL);
  const posAttr = geo.attributes.position;
  const count = posAttr.count;

  const colors = new Float32Array(count * 3);
  // Salviamo l'altitudine normalizzata per ogni vertice (per il posizionamento decorazioni)
  const heightData = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);

    // Direzione normalizzata
    const len = Math.sqrt(x * x + y * y + z * z);
    const nx = x / len, ny = y / len, nz = z / len;

    // Profilo terreno più morbido: rilievi ampi + micro-dettaglio attenuato.
    const base = noise3D(nx * NOISE_SCALE, ny * NOISE_SCALE, nz * NOISE_SCALE);
    const broad = noise3D(nx * 1.8, ny * 1.8, nz * 1.8);
    const detail = noise3D(nx * 3.0, ny * 3.0, nz * 3.0);
    const n = (base * 1.0 + broad * 0.25 + detail * 0.06) / 1.31;

    // Rimappa in [0,1] e comprime i picchi per ridurre pendenze locali estreme.
    const n01 = THREE.MathUtils.clamp((n + 1) * 0.5, 0, 1);
    const shaped = Math.pow(THREE.MathUtils.smoothstep(n01, 0.46, 0.92), 1.85);
    const displacement = shaped * MOUNTAIN_HEIGHT;
    const r = PLANET_RADIUS + displacement;

    posAttr.setXYZ(i, nx * r, ny * r, nz * r);

    const normalizedH = displacement / MOUNTAIN_HEIGHT;
    heightData[i] = normalizedH;

    const col = altitudeColor(normalizedH < WATER_LEVEL ? normalizedH - 0.04 : normalizedH);
    colors[i * 3]     = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshToonMaterial({
    vertexColors: true,
    flatShading: true,
    gradientMap: createToonGradientMap(),
  });

  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  // Sfera acqua
  const waterGeo = new THREE.SphereGeometry(PLANET_RADIUS + 0.05, 32, 32);
  const waterMat = new THREE.MeshPhongMaterial({
    color: 0x73b6e0,
    emissive: 0x1b4360,
    emissiveIntensity: 0.2,
    specular: 0xcde9ff,
    transparent: true,
    opacity: 0.58,
    shininess: 45,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  scene.add(water);

  const atmosphereGeo = new THREE.SphereGeometry(PLANET_RADIUS + 0.9, 32, 32);
  const atmosphereMat = new THREE.MeshBasicMaterial({
    color: 0xbdeaff,
    transparent: true,
    opacity: 0.12,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const atmosphere = new THREE.Mesh(atmosphereGeo, atmosphereMat);
  scene.add(atmosphere);

  return { mesh, water, atmosphere, heightData, posAttr };
}
