import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PLANET_RADIUS } from '../../../shared/planetField.js';
import { sampleGround, makeSurfaceHit, fitGroundPlane, SEA_SURFACE_RADIUS } from '../planetSurface.js';
import { BIOME, biomeAt } from '../planetBiomes.js';
import { mulberry32, withLifeUniforms, nightRamp, tangentBasis, offsetDir, lampLambertMaterial } from './lifeShared.js';

/**
 * Fari a strisce sui promontori, con due fasci che ruotano sul mare di notte.
 *
 * Nessuna luce vera (vedi CLAUDE.md, "il conteggio delle luci cambiava di
 * continuo"): la lanterna si accende con un'emissione aggiunta al materiale
 * Lambert dei fari, i fasci e l'alone sono geometria additiva calcolata nel
 * vertex shader.
 *
 * Draw call: 1 per i corpi (tutti fusi, colori per vertice), 1 per fasci e
 * aloni, solo di notte. CPU per frame: due uniform.
 *
 * I siti si scelgono sulla superficie renderizzata: terra bassa e piana con
 * il mare su almeno cinque lati su dodici (un capo, non una spiaggia dritta).
 * Il terreno è già stato popolato e fuso quando arriviamo, e gli alberi non
 * sono esposti: un sito viene scartato se un vertice qualsiasi di alberi o case
 * cade dentro la sua impronta (vedi `isSiteClear`). Riservare i siti a quota
 * < 0.45, dove Terrain.js non pianta alberi, sarebbe stato più semplice, ma su
 * questo pianeta i capi a quella quota sono quasi inesistenti (1 su 78).
 */

const MAX_LIGHTHOUSES = 5;
const MIN_SEPARATION = 0.6;     // rad fra due fari
const TOWN_CLEARANCE = 0.2;     // rad dal centro di un paese
/** Nessun vertice del terreno (alberi, case) entro questa distanza dal piede. */
const OBSTACLE_CLEARANCE = 1.0;

const PLINTH_H = 0.32, TOWER_H = 2.5, GALLERY_H = 0.07, ROOM_H = 0.3, DOME_H = 0.3;
const TOWER_R0 = 0.36, TOWER_R1 = 0.24;
/** Centro della lanterna sopra il piede del faro. */
const LAMP_Y = PLINTH_H + TOWER_H + GALLERY_H + ROOM_H * 0.5;
/**
 * Affondamento del piede: il plinto di pietra è alto e in gran parte sepolto,
 * così copre il dislivello residuo sotto l'impronta invece di lasciare un
 * bordo sospeso sul lato a valle.
 */
const SINK = 0.24;

const BEAM_LEN_HIGH = 13;
const BEAM_LEN_LOW = 8;

// ── Corpo ────────────────────────────────────────────────────────────────────

function colorize(geo, color, glow = 0) {
  const n = geo.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  const g = new Float32Array(n).fill(glow);
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(g, 1));
  return geo;
}

/** Torre a fasce rosse e bianche: un cilindro per fascia, colori per vertice. */
function buildLighthouseGeometry() {
  const red = new THREE.Color(0xd8433a);
  const white = new THREE.Color(0xf6f1e7);
  const stone = new THREE.Color(0x9a9187);
  const dark = new THREE.Color(0x3b3f4a);
  const glass = new THREE.Color(0xffe6a8);
  const parts = [];
  const cyl = (rTop, rBot, h, y0, color, glow = 0, seg = 8) => {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1).toNonIndexed();
    g.translate(0, y0 + h / 2, 0);
    parts.push(colorize(g, color, glow));
  };

  cyl(0.46, 0.5, PLINTH_H, 0, stone);
  const bands = 5;
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands, t1 = (i + 1) / bands;
    const r0 = TOWER_R0 + (TOWER_R1 - TOWER_R0) * t0;
    const r1 = TOWER_R0 + (TOWER_R1 - TOWER_R0) * t1;
    cyl(r1, r0, TOWER_H / bands, PLINTH_H + TOWER_H * t0, i % 2 ? white : red);
  }
  const yGallery = PLINTH_H + TOWER_H;
  cyl(0.4, 0.4, GALLERY_H, yGallery, dark);
  cyl(0.19, 0.19, ROOM_H, yGallery + GALLERY_H, glass, 0.01);
  const dome = new THREE.ConeGeometry(0.27, DOME_H, 8, 1).toNonIndexed();
  dome.translate(0, yGallery + GALLERY_H + ROOM_H + DOME_H / 2, 0);
  parts.push(colorize(dome, red));

  for (const p of parts) p.deleteAttribute('uv');
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

// ── Fasci e alone ────────────────────────────────────────────────────────────

const BEAM_VERT = /* glsl */`
  attribute float aKind;    // 0 fascio, 1 fascio opposto, 2 alone
  attribute vec3 aBase;     // centro della lanterna (mondo)
  attribute vec3 aUp;
  attribute float aPhase;
  uniform float uTime;
  uniform float uLen;
  varying vec2 vUv;
  varying float vKind;

  void main() {
    vKind = aKind;
    vUv = uv;
    vec4 mvPosition;
    if (aKind < 1.5) {
      vec3 ref = abs(aUp.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 t1 = normalize(cross(ref, aUp));
      vec3 t2 = cross(aUp, t1);
      float ang = uTime * 0.75 + aPhase + aKind * 3.14159265;
      vec3 dir = t1 * cos(ang) + t2 * sin(ang);
      vec3 side = cross(aUp, dir);
      float along = position.x;
      float width = mix(0.12, 1.9, along);
      // Leggermente inclinato verso il basso: spazza il mare, non il cielo.
      vec3 world = aBase + dir * (along * uLen) - aUp * (along * uLen * 0.1)
                 + (aUp * position.y + side * position.z) * width;
      mvPosition = viewMatrix * vec4(world, 1.0);
    } else {
      mvPosition = viewMatrix * vec4(aBase, 1.0);
      mvPosition.xy += position.yz * 1.5;
    }
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const BEAM_FRAG = /* glsl */`
  uniform float uOn;
  varying vec2 vUv;
  varying float vKind;
  void main() {
    float a;
    vec3 col;
    if (vKind < 1.5) {
      float along = vUv.x;
      float across = abs(vUv.y * 2.0 - 1.0);
      a = pow(1.0 - along, 1.6) * (1.0 - smoothstep(0.3, 1.0, across)) * smoothstep(0.0, 0.05, along) * 0.24;
      col = vec3(1.0, 0.95, 0.8);
    } else {
      float d = length(vUv - 0.5) * 2.0;
      a = pow(max(0.0, 1.0 - d), 2.2) * 0.9;
      col = vec3(1.0, 0.86, 0.55) * 1.4;
    }
    gl_FragColor = vec4(col, a * uOn);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Geometria base di un faro (per istanza): due fasci opposti, ciascuno fatto
 * di due trapezi incrociati (orizzontale e verticale, così si vede da ogni
 * lato), più il quadrato dell'alone.
 */
function buildBeamGeometry() {
  const pos = [], uv = [], kind = [];
  const quad = (p, q, k) => {
    for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(...p[i]); uv.push(...q[i]); kind.push(k); }
  };
  for (const k of [0, 1]) {
    // orizzontale (z) e verticale (y); x = 0..1 lungo il fascio
    quad([[0, 0, -1], [1, 0, -1], [1, 0, 1], [0, 0, 1]], [[0, 0], [1, 0], [1, 1], [0, 1]], k);
    quad([[0, -1, 0], [1, -1, 0], [1, 1, 0], [0, 1, 0]], [[0, 0], [1, 0], [1, 1], [0, 1]], k);
  }
  // Alone: le coordinate y, z fanno da offset in spazio vista.
  quad([[0, -0.5, -0.5], [0, 0.5, -0.5], [0, 0.5, 0.5], [0, -0.5, 0.5]], [[0, 0], [1, 0], [1, 1], [0, 1]], 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  return geo;
}

// ── Siti ─────────────────────────────────────────────────────────────────────

const _hit = makeSurfaceHit();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _probe = new THREE.Vector3();

function countSea(dir, distance, samples) {
  tangentBasis(dir, _u, _v);
  let sea = 0;
  for (let k = 0; k < samples; k++) {
    offsetDir(dir, _u, _v, (k / samples) * Math.PI * 2, distance / PLANET_RADIUS, _probe);
    if (sampleGround(_probe, _hit).radius < SEA_SURFACE_RADIUS - 0.15) sea++;
  }
  return sea;
}

/** Quota minima e massima sotto l'impronta del faro. */
function footprintRange(dir) {
  tangentBasis(dir, _u, _v);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < 8; k++) {
    offsetDir(dir, _u, _v, (k / 8) * Math.PI * 2, 0.55 / PLANET_RADIUS, _probe);
    const e = sampleGround(_probe, _hit).radius - PLANET_RADIUS;
    lo = Math.min(lo, e); hi = Math.max(hi, e);
  }
  return [lo, hi];
}

/**
 * Nessun vertice del terreno già piazzato (alberi, case, ospedali) vicino al
 * piede. Scansione lineare delle mesh fuse: costa ~1 ms a sito e si fa solo
 * sui pochi candidati che hanno superato tutti gli altri controlli.
 */
function isSiteClear(point, terrainGroup) {
  if (!terrainGroup) return true;
  const r2 = OBSTACLE_CLEARANCE * OBSTACLE_CLEARANCE;
  const px = point.x, py = point.y, pz = point.z;
  let clear = true;
  terrainGroup.traverse((o) => {
    if (!clear || !o.isMesh) return;
    const a = o.geometry.getAttribute('position').array;
    for (let i = 0; i < a.length; i += 3) {
      const dx = a[i] - px, dy = a[i + 1] - py, dz = a[i + 2] - pz;
      if (dx * dx + dy * dy + dz * dz < r2) { clear = false; return; }
    }
  });
  return clear;
}

function findSites(rand, towns, terrainGroup) {
  const sites = [];
  const dir = new THREE.Vector3();
  for (let attempt = 0; attempt < 12000 && sites.length < MAX_LIGHTHOUSES; attempt++) {
    dir.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    if (dir.lengthSq() < 1e-4 || dir.lengthSq() > 1) continue;
    dir.normalize();
    sampleGround(dir, _hit);
    const e = _hit.radius - PLANET_RADIUS;
    if (e < 0.1 || e > 1.1 || _hit.slope > 0.16) continue;
    // Niente boschi fitti e niente calotte polari: un faro sul pack non ha senso.
    const biome = biomeAt(dir.x, dir.y, dir.z, e, _hit.slope);
    if (biome === BIOME.FOREST || biome === BIOME.SNOW) continue;
    if (sites.some((s) => s.dir.angleTo(dir) < MIN_SEPARATION)) continue;
    if (towns.some((t) => t.angleTo(dir) < TOWN_CLEARANCE)) continue;
    const [lo, hi] = footprintRange(dir);
    if (lo < 0.04 || hi - lo > 0.2) continue;
    // Capo: il mare circonda il sito da quasi metà dei lati, ed è vicino.
    if (countSea(dir, 3.2, 12) < 5 || countSea(dir, 1.6, 8) < 2) continue;
    sampleGround(dir, _hit);
    if (!isSiteClear(_hit.point, terrainGroup)) continue;
    sites.push({ dir: dir.clone() });
  }
  return sites;
}

// ── Sistema ──────────────────────────────────────────────────────────────────

export class Lighthouses {
  /**
   * @param {THREE.Scene} scene
   * @param {{towns?: THREE.Vector3[], terrainGroup?: THREE.Object3D, lowQuality?: boolean}} [options]
   */
  constructor(scene, { towns = [], terrainGroup = null, lowQuality = false } = {}) {
    this.enabled = true;
    const rand = mulberry32(1851);
    const sites = findSites(rand, towns, terrainGroup);
    this.sites = sites;
    this.group = new THREE.Group();
    this.group.name = 'lighthouses';

    // Corpi fusi in un'unica mesh, torre sempre verticale (radiale): un faro
    // inclinato come la faccia su cui poggia sembrerebbe cadere.
    this.lampOn = { value: 0 };
    const template = buildLighthouseGeometry();
    const pieces = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const base = new THREE.Vector3();
    const lampBase = new Float32Array(sites.length * 3);
    const lampUp = new Float32Array(sites.length * 3);
    const phases = new Float32Array(sites.length);
    this.placements = [];
    sites.forEach((s, i) => {
      const fit = fitGroundPlane(s.dir, 0.5, 0.5);
      q.setFromUnitVectors(yAxis, s.dir);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, rand() * Math.PI * 2));
      base.copy(fit.origin).addScaledVector(s.dir, -SINK);
      m.compose(base, q, one);
      pieces.push(template.clone().applyMatrix4(m));
      const lamp = base.clone().addScaledVector(s.dir, LAMP_Y);
      lampBase.set([lamp.x, lamp.y, lamp.z], i * 3);
      lampUp.set([s.dir.x, s.dir.y, s.dir.z], i * 3);
      phases[i] = rand() * Math.PI * 2;
      this.placements.push({ base: base.clone(), up: s.dir.clone() });
    });
    template.dispose();

    this.body = null;
    if (pieces.length) {
      const geo = mergeGeometries(pieces, false);
      for (const p of pieces) p.dispose();
      this.body = new THREE.Mesh(geo, lampLambertMaterial(this.lampOn, new THREE.Color(1.0, 0.78, 0.4).multiplyScalar(2.2)));
      this.body.matrixAutoUpdate = false;
      this.group.add(this.body);
    }

    // Fasci e alone: un'istanza per faro.
    const beamGeo = buildBeamGeometry();
    beamGeo.setAttribute('aBase', new THREE.InstancedBufferAttribute(lampBase, 3));
    beamGeo.setAttribute('aUp', new THREE.InstancedBufferAttribute(lampUp, 3));
    beamGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    beamGeo.instanceCount = sites.length;
    this.beamUniforms = withLifeUniforms({
      uOn: { value: 0 },
      uLen: { value: lowQuality ? BEAM_LEN_LOW : BEAM_LEN_HIGH },
    }, false);
    const beamMat = new THREE.ShaderMaterial({
      uniforms: this.beamUniforms,
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      // Additivo: l'ordine delle facce non conta, un solo passaggio basta.
      forceSinglePass: true,
    });
    this.beams = new THREE.Mesh(beamGeo, beamMat);
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 3;
    this.beams.visible = false;
    this.group.add(this.beams);

    scene.add(this.group);
  }

  update(nightFactor) {
    if (!this.enabled) return;
    // La lanterna si accende al crepuscolo, i fasci solo a notte fatta.
    this.lampOn.value = nightRamp(nightFactor, 0.42, 0.7);
    const on = nightRamp(nightFactor, 0.5, 0.85);
    this.beamUniforms.uOn.value = on;
    this.beams.visible = on > 0.01 && this.sites.length > 0;
  }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
    if (!on) this.lampOn.value = 0;
  }
}
