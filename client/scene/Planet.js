import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';

export const PLANET_RADIUS = 50;
const DETAIL = 4;         // suddivisione icosahedron
const NOISE_SCALE = 0.8;
const MOUNTAIN_HEIGHT = 7;
const WATER_LEVEL = 0.05; // altitudine normalizzata al di sotto della quale = acqua

// Palette colori per altitudine (normalizzata 0..1)
const COLORS = [
  { h: -0.02, color: new THREE.Color(0x1a5fa8) }, // acqua profonda
  { h:  0.00, color: new THREE.Color(0x2277cc) }, // acqua
  { h:  0.03, color: new THREE.Color(0xf0d080) }, // spiaggia
  { h:  0.08, color: new THREE.Color(0x5aaa44) }, // pianura
  { h:  0.25, color: new THREE.Color(0x3d7a2e) }, // colline
  { h:  0.55, color: new THREE.Color(0x8a8070) }, // roccia
  { h:  0.85, color: new THREE.Color(0xfafafa) }, // neve
  { h:  1.00, color: new THREE.Color(0xffffff) },
];

function altitudeColor(normalizedH) {
  for (let i = 0; i < COLORS.length - 1; i++) {
    const a = COLORS[i], b = COLORS[i + 1];
    if (normalizedH <= b.h) {
      const t = (normalizedH - a.h) / (b.h - a.h);
      return new THREE.Color().lerpColors(a.color, b.color, Math.max(0, t));
    }
  }
  return COLORS[COLORS.length - 1].color.clone();
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

    // Noise multi-ottava
    const n = (
      noise3D(nx * NOISE_SCALE, ny * NOISE_SCALE, nz * NOISE_SCALE) * 1.0 +
      noise3D(nx * 2.2, ny * 2.2, nz * 2.2) * 0.4 +
      noise3D(nx * 4.5, ny * 4.5, nz * 4.5) * 0.15
    ) / 1.55;

    const displacement = Math.max(0, n) * MOUNTAIN_HEIGHT;
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

  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  // Sfera acqua
  const waterGeo = new THREE.SphereGeometry(PLANET_RADIUS + 0.05, 32, 32);
  const waterMat = new THREE.MeshPhongMaterial({
    color: 0x2277cc,
    transparent: true,
    opacity: 0.65,
    shininess: 80,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  scene.add(water);

  return { mesh, water, heightData, posAttr };
}
