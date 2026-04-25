import * as THREE from 'three';
import {
  PLANET_RADIUS,
  MOUNTAIN_HEIGHT,
  WATER_LEVEL,
  heightAt01,
} from './planetHeight.js';

export { PLANET_RADIUS, MOUNTAIN_HEIGHT, WATER_LEVEL };
const DETAIL = 5; // più vertici → silhouette e costa più morbide

// Palette pastello per altitudine (normalizzata 0..1).
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
  const data = new Uint8Array([42, 110, 182, 255]);
  const gradientMap = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

// Direzione del sole coerente con Lighting.js (DirectionalLight sun a 130,95,70).
const SUN_DIR = new THREE.Vector3(130, 95, 70).normalize();

// ── Terrain material: MeshToonMaterial con snow caps shader-driven ────────────
// Usiamo onBeforeCompile per restare compatibili con le 3 direzionali + ambient
// + fog definite in Lighting.js, senza reinventare il modello d'illuminazione.
function createTerrainMaterial() {
  const mat = new THREE.MeshToonMaterial({
    vertexColors: true,
    flatShading: true,
    gradientMap: createToonGradientMap(),
  });

  mat.userData.uniforms = {
    uSnowStart:  { value: 0.55 },
    uSnowEnd:    { value: 0.82 },
    uSnowUpness: { value: 0.45 }, // quanto "piatto" serve essere per prendere neve
    uSnowColor:  { value: new THREE.Color(0xfdfdfd) },
    uRockColor:  { value: new THREE.Color(0x9a8c78) },
    uRockSlope:  { value: 0.42 }, // sopra questa pendenza la roccia si scopre
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aHeight01;
         varying float vHeight01;
         varying float vUpness;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vHeight01 = aHeight01;
         vec3 _worldN = normalize(mat3(modelMatrix) * normal);
         vec3 _worldR = normalize((modelMatrix * vec4(position, 1.0)).xyz);
         vUpness = clamp(dot(_worldN, _worldR), 0.0, 1.0);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uSnowStart;
         uniform float uSnowEnd;
         uniform float uSnowUpness;
         uniform float uRockSlope;
         uniform vec3  uSnowColor;
         uniform vec3  uRockColor;
         varying float vHeight01;
         varying float vUpness;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // Roccia: sui versanti ripidi esce il sottoroccia, più saturo del vertex color.
         float rockMask = smoothstep(1.0 - uRockSlope, 1.0 - uRockSlope - 0.18, vUpness);
         diffuseColor.rgb = mix(diffuseColor.rgb, uRockColor, rockMask * 0.55);
         // Neve: su alta quota e su superfici abbastanza piatte.
         float snowByH = smoothstep(uSnowStart, uSnowEnd, vHeight01);
         float snowByN = smoothstep(uSnowUpness, uSnowUpness + 0.35, vUpness);
         float snowMask = snowByH * snowByN;
         diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, snowMask);`,
      );
  };

  return mat;
}

// ── Water shader: onde Gerstner-like + fresnel + specular solare ─────────────
const WATER_VERT = /* glsl */`
  uniform float uTime;
  varying vec3  vWorldPos;
  varying vec3  vSphereN;   // normale della sfera base (radiale)
  varying float vWaveH;

  float waveH(vec3 dir, float t) {
    float theta = acos(clamp(dir.y, -1.0, 1.0));
    float phi   = atan(dir.z, dir.x);
    float h = 0.0;
    h += sin(phi  * 6.0 + t * 0.95)               * 0.065;
    h += sin(theta * 7.5 - t * 0.70 + phi * 2.7)  * 0.050;
    h += sin((phi + theta) * 11.0 + t * 1.40)     * 0.028;
    return h;
  }

  void main() {
    vec3 nrm = normalize(position);
    float h = waveH(nrm, uTime);
    vec3 p = position + nrm * h;

    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    vSphereN  = normalize(mat3(modelMatrix) * nrm);
    vWaveH    = h;

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WATER_FRAG = /* glsl */`
  uniform vec3  uCameraPos;
  uniform vec3  uSunDir;
  uniform vec3  uShallow;
  uniform vec3  uDeep;
  uniform vec3  uFoam;
  uniform float uOpacity;
  uniform vec3  fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec3  vWorldPos;
  varying vec3  vSphereN;
  varying float vWaveH;

  void main() {
    vec3 V = normalize(uCameraPos - vWorldPos);
    vec3 N = normalize(vSphereN);

    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3  base = mix(uDeep, uShallow, smoothstep(-0.05, 0.08, vWaveH));

    // Specular cartoon: soglia secca per un riflesso "a macchia" sul sole.
    vec3  R = reflect(-uSunDir, N);
    float spec = pow(max(dot(R, V), 0.0), 56.0);
    spec = smoothstep(0.25, 0.6, spec);

    float foam = smoothstep(0.072, 0.098, vWaveH);

    vec3 col = base;
    col += fres * 0.35 * uShallow;
    col = mix(col, uFoam, foam * 0.65);
    col += vec3(1.0, 0.96, 0.88) * spec * 0.9;

    // Fog (sincronizzato con scene.fog)
    float depth = length(uCameraPos - vWorldPos);
    float fogF  = smoothstep(fogNear, fogFar, depth);
    col = mix(col, fogColor, fogF);

    // Alpha varia con fresnel: trasparente guardando dritto, opaco ai bordi.
    float alpha = mix(0.28, 0.72, fres);
    gl_FragColor = vec4(col, alpha);
  }
`;

function createWaterMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:      { value: 0 },
      uCameraPos: { value: new THREE.Vector3() },
      uSunDir:    { value: SUN_DIR.clone() },
      uShallow:   { value: new THREE.Color(0x83c7ea) },
      uDeep:      { value: new THREE.Color(0x1f5a87) },
      uFoam:      { value: new THREE.Color(0xeaf6ff) },
      uOpacity:   { value: 0.62 },
      fogColor:   { value: new THREE.Color(0xcfeaf7) },
      fogNear:    { value: 160 },
      fogFar:     { value: 430 },
    },
    vertexShader:   WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    fog: false, // gestita in shader
  });
}

// ── Atmosfera: fresnel additivo (BackSide) ───────────────────────────────────
const ATM_VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vNormal   = normalize(mat3(modelMatrix) * normal);
    vec4 wp   = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const ATM_FRAG = /* glsl */`
  uniform vec3  uCameraPos;
  uniform vec3  uColor;
  uniform float uIntensity;
  varying vec3  vNormal;
  varying vec3  vWorldPos;
  void main() {
    vec3 V = normalize(uCameraPos - vWorldPos);
    // BackSide: la normale punta all'interno → uso abs per un limb-glow simmetrico
    float f = pow(1.0 - abs(dot(vNormal, V)), 2.4);
    gl_FragColor = vec4(uColor * f * uIntensity, f * uIntensity);
  }
`;

function createAtmosphereMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCameraPos: { value: new THREE.Vector3() },
      uColor:     { value: new THREE.Color(0xbdeaff) },
      uIntensity: { value: 0.28 },
    },
    vertexShader:   ATM_VERT,
    fragmentShader: ATM_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

// ── Factory ───────────────────────────────────────────────────────────────────
export function createPlanet(scene, options = {}) {
  let qualityStage = Math.max(0, options.qualityStage ?? 0);
  const geo = new THREE.IcosahedronGeometry(PLANET_RADIUS, DETAIL);
  const posAttr = geo.attributes.position;
  const count = posAttr.count;

  const colors = new Float32Array(count * 3);
  const heightData = new Float32Array(count);
  const heightAttr = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);

    const len = Math.sqrt(x * x + y * y + z * z);
    const nx = x / len, ny = y / len, nz = z / len;

    const h01 = heightAt01(nx, ny, nz);
    const r = PLANET_RADIUS + h01 * MOUNTAIN_HEIGHT;

    posAttr.setXYZ(i, nx * r, ny * r, nz * r);
    heightData[i] = h01;
    heightAttr[i] = h01;

    const col = altitudeColor(h01 < WATER_LEVEL ? h01 - 0.04 : h01);
    colors[i * 3]     = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }

  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aHeight01', new THREE.BufferAttribute(heightAttr, 1));
  geo.computeVertexNormals();

  const mat = createTerrainMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  // Acqua: ora un guscio leggermente più in basso per non coprire le spiagge,
  // con onde generate in vertex shader.
  const waterSegX = qualityStage >= 2 ? 48 : 64;
  const waterSegY = qualityStage >= 2 ? 24 : 40;
  const waterGeo = new THREE.SphereGeometry(PLANET_RADIUS + 0.02, waterSegX, waterSegY);
  const waterMat = createWaterMaterial();
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.renderOrder = 1;
  scene.add(water);

  const atmosphereGeo = new THREE.SphereGeometry(
    PLANET_RADIUS + 1.1,
    qualityStage >= 2 ? 32 : 48,
    qualityStage >= 2 ? 20 : 32,
  );
  const atmosphereMat = createAtmosphereMaterial();
  const atmosphere = new THREE.Mesh(atmosphereGeo, atmosphereMat);
  atmosphere.renderOrder = 2;
  atmosphere.visible = qualityStage < 2;
  scene.add(atmosphere);

  function setQualityStage(stage) {
    qualityStage = Math.max(qualityStage, stage ?? 0);
    atmosphere.visible = qualityStage < 2;
  }

  function update(delta, cameraWorldPos) {
    if (qualityStage < 2) waterMat.uniforms.uTime.value += delta;
    if (cameraWorldPos) {
      waterMat.uniforms.uCameraPos.value.copy(cameraWorldPos);
      atmosphereMat.uniforms.uCameraPos.value.copy(cameraWorldPos);
    }
  }

  return { mesh, water, atmosphere, heightData, posAttr, update, setQualityStage };
}
