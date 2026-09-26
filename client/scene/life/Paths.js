import * as THREE from 'three';
import { PLANET_RADIUS } from '../../../shared/planetField.js';
import { sampleGround, makeSurfaceHit } from '../planetSurface.js';
import { mulberry32, lampLambertMaterial, nightRamp } from './lifeShared.js';

/**
 * Sentieri di terra battuta fra paesi vicini, con lampioni che di notte si
 * accendono uno alla volta: dall'aereo si vedono collane di luci che uniscono
 * i paesi.
 *
 * Rete: albero ricoprente minimo sui centri dei paesi, solo con archi più
 * corti di `MAX_LINK` (un sentiero da un continente all'altro passerebbe in
 * mare). Ogni arco è un arco di cerchio massimo con un meandro laterale; viene
 * scartato se tocca il mare o la spiaggia, se sale su un pendio da parete o se
 * fuori dai paesi passa sopra una casa isolata. Dentro i paesi il sentiero si
 * ferma alla prima casa che incontrerebbe: "entra" in paese fra le case.
 *
 * Il terreno è già popolato quando arriviamo (non tocchiamo Terrain.js),
 * quindi un sentiero può passare sotto la chioma di un albero; i lampioni
 * invece si saltano dove un vertice di albero o casa cade troppo vicino.
 *
 * Il nastro segue la superficie *renderizzata*: centro e bordi sono campionati
 * separatamente con `sampleGround` ogni `STEP` unità (le facce del pianeta sono
 * larghe ~1.4) e sollevati lungo la normale della propria faccia, con
 * polygonOffset contro lo z-fighting.
 *
 * Draw call: 1 (nastro, pali e teste dei lampioni fusi, colori per vertice,
 * teste emissive di notte) + 1 di notte (aloni additivi dei lampioni).
 */

const MAX_LINK = 0.8;          // rad (~40 unità)
const STEP = 0.35;             // unità fra due campioni del sentiero
const HALF_WIDTH = 0.26;
const LIFT = 0.055;
const TOWN_ZONE = 0.14;        // rad: entro qui si è "in paese"
const HOUSE_CLEARANCE = 0.3;   // oltre l'impronta di un edificio
const MIN_ELEVATION = 0.32;    // sotto: spiaggia o mare
const MAX_SLOPE = 0.42;
const LAMP_SPACING = 2.8;      // unità lungo il sentiero
const LAMP_OFFSET = 0.46;      // dal centro del sentiero
const LAMP_HEIGHT = 0.62;
const LAMP_CLEARANCE = 0.4;    // nessun vertice di albero/casa entro questa distanza

const DIRT = new THREE.Color(0xc9a46e);
const POST = new THREE.Color(0x4a4650);
const HEAD = new THREE.Color(0xfff0c4);

const HALO_VERT = /* glsl */`
  attribute vec3 aPos;
  attribute float aSeed;
  uniform float uLit;
  varying vec2 vUv;
  varying float vOn;
  void main() {
    vUv = uv;
    vOn = smoothstep(aSeed, aSeed + 0.08, uLit);
    vec4 mv = viewMatrix * vec4(aPos, 1.0);
    mv.xy += position.xy * 0.95 * vOn;
    gl_Position = projectionMatrix * mv;
  }
`;

const HALO_FRAG = /* glsl */`
  varying vec2 vUv;
  varying float vOn;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float core = 1.0 - smoothstep(0.0, 0.25, d);
    float halo = pow(max(0.0, 1.0 - d), 2.0);
    vec3 col = mix(vec3(1.0, 0.7, 0.35), vec3(1.0, 0.95, 0.8), core) * 1.5;
    gl_FragColor = vec4(col, (core * 0.8 + halo * 0.5) * vOn);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ── Rete ─────────────────────────────────────────────────────────────────────

/**
 * Kruskal sui paesi: gli archi più corti di MAX_LINK in ordine di lunghezza,
 * tenuti se uniscono due gruppi ancora separati E se il sentiero è
 * praticabile (`tryLink`). Rispetto all'albero minimo puro, un arco che
 * attraverserebbe una baia viene sostituito dal più corto che passa per terra.
 */
function feasibleLinks(towns, tryLink) {
  const parent = towns.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edges = [];
  for (let i = 0; i < towns.length; i++) {
    for (let j = i + 1; j < towns.length; j++) {
      const d = towns[i].angleTo(towns[j]);
      if (d < MAX_LINK) edges.push([i, j, d]);
    }
  }
  edges.sort((a, b) => a[2] - b[2]);
  const lines = [];
  for (const [i, j] of edges) {
    if (find(i) === find(j)) continue;
    const line = tryLink(i, j);
    if (!line) continue;
    parent[find(i)] = find(j);
    lines.push(line);
  }
  return lines;
}

const _hit = makeSurfaceHit();
const _p = new THREE.Vector3();
const _axis = new THREE.Vector3();
/** Motivi di scarto dei tentativi, per il log di sviluppo. */
const rejects = { sea: 0, slope: 0, house: 0, short: 0 };

/**
 * Linea mediana di un sentiero fra due paesi, già tagliata alle case dei
 * paesi. `null` se il percorso non è praticabile.
 */
function traceCenterline(a, b, meander, phase, buildings) {
  const omega = a.angleTo(b);
  const n = Math.max(8, Math.ceil((omega * PLANET_RADIUS) / STEP));
  _axis.crossVectors(a, b).normalize();
  const sinO = Math.sin(omega);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    _p.copy(a).multiplyScalar(Math.sin((1 - t) * omega) / sinO)
      .addScaledVector(b, Math.sin(t * omega) / sinO);
    // Meandro: una curva ampia più un'increspatura, nulle alle estremità.
    const off = meander * Math.sin(Math.PI * t) + meander * 0.3 * Math.sin(3 * Math.PI * t + phase) * Math.sin(Math.PI * t);
    _p.addScaledVector(_axis, off).normalize();
    sampleGround(_p, _hit);
    const inTown = _p.angleTo(a) < TOWN_ZONE || _p.angleTo(b) < TOWN_ZONE;
    const elevation = _hit.radius - PLANET_RADIUS;
    if (!inTown && elevation < MIN_ELEVATION) { rejects.sea++; return null; }
    if (!inTown && _hit.slope > MAX_SLOPE) { rejects.slope++; return null; }
    let blocked = false;
    for (const bd of buildings) {
      if (bd.position.distanceTo(_hit.point) < (bd.size ?? 1) + HOUSE_CLEARANCE) { blocked = true; break; }
    }
    if (blocked && !inTown) { rejects.house++; return null; }
    pts.push({ dir: _p.clone(), blocked, nearA: _p.angleTo(a) < TOWN_ZONE });
  }
  // Taglio alle case: dopo l'ultima casa del paese di partenza, prima della
  // prima casa del paese di arrivo.
  let start = 0, end = pts.length - 1;
  for (let i = 0; i < pts.length; i++) if (pts[i].blocked && pts[i].nearA) start = i + 1;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i].blocked && !pts[i].nearA) end = i - 1;
  if (end - start < 10) { rejects.short++; return null; }
  return pts.slice(start, end + 1).map((p) => p.dir);
}

// ── Geometria ────────────────────────────────────────────────────────────────

/** Accumulatore di triangoli con colore e soglia di accensione per vertice. */
class Builder {
  constructor() { this.pos = []; this.col = []; this.glow = []; }
  vert(v, c, g = 0) {
    this.pos.push(v.x, v.y, v.z);
    this.col.push(c.r, c.g, c.b);
    this.glow.push(g);
  }
  tri(a, b, c, color, g = 0) { this.vert(a, color, g); this.vert(b, color, g); this.vert(c, color, g); }
  /** Parallelepipedo verticale (asse `up`) con base centrata in `base`. */
  post(base, up, side, half, h, color, g = 0) {
    const fwd = new THREE.Vector3().crossVectors(side, up);
    const corners = [];
    for (const y of [0, h]) {
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        corners.push(base.clone().addScaledVector(up, y).addScaledVector(side, sx * half).addScaledVector(fwd, sz * half));
      }
    }
    const [b0, b1, b2, b3, t0, t1, t2, t3] = corners;
    // Facce in senso antiorario viste da fuori: il materiale è FrontSide.
    const quad = (p, q, r, s) => { this.tri(p, q, r, color, g); this.tri(p, r, s, color, g); };
    quad(t0, t3, t2, t1);
    quad(b0, t0, t1, b1);
    quad(b1, t1, t2, b2);
    quad(b2, t2, t3, b3);
    quad(b3, t3, t0, b0);
  }
  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * Segna `blocked` sui punti che hanno un vertice del terreno già piazzato
 * (alberi, case) entro `radius`. Una sola passata sui vertici: i punti stanno
 * in una griglia di celle da 1 unità (ognuno in tutte le celle che la sua
 * sfera tocca), e ogni vertice guarda solo la propria cella.
 */
function markObstructed(points, terrainGroup, radius) {
  if (!terrainGroup || points.length === 0) return;
  // Chiave numerica: coordinate entro ±128 unità, ben oltre il raggio di volo.
  const key = (x, y, z) => ((Math.floor(x) + 128) * 256 + (Math.floor(y) + 128)) * 256 + (Math.floor(z) + 128);
  const grid = new Map();
  for (const p of points) {
    for (const dx of [-radius, radius]) {
      for (const dy of [-radius, radius]) {
        for (const dz of [-radius, radius]) {
          const k = key(p.x + dx, p.y + dy, p.z + dz);
          const list = grid.get(k);
          if (!list) grid.set(k, [p]);
          else if (!list.includes(p)) list.push(p);
        }
      }
    }
  }
  const r2 = radius * radius;
  terrainGroup.traverse((o) => {
    if (!o.isMesh) return;
    const a = o.geometry.getAttribute('position').array;
    for (let i = 0; i < a.length; i += 3) {
      const list = grid.get(key(a[i], a[i + 1], a[i + 2]));
      if (!list) continue;
      for (const p of list) {
        const dx = a[i] - p.x, dy = a[i + 1] - p.y, dz = a[i + 2] - p.z;
        if (dx * dx + dy * dy + dz * dz < r2) p.blocked = true;
      }
    }
  });
}

export class Paths {
  /**
   * @param {THREE.Scene} scene
   * @param {{towns?: THREE.Vector3[], buildings?: Array<{position:THREE.Vector3, size:number}>, terrainGroup?: THREE.Object3D}} [options]
   */
  constructor(scene, { towns = [], buildings = [], terrainGroup = null } = {}) {
    this.enabled = true;
    this.group = new THREE.Group();
    this.group.name = 'paths';
    const rand = mulberry32(777001);
    for (const k of Object.keys(rejects)) rejects[k] = 0;

    const lines = feasibleLinks(towns, (i, j) => {
      const phase = rand() * Math.PI * 2;
      const m = (0.03 + rand() * 0.04) * (rand() < 0.5 ? -1 : 1);
      // Se il primo meandro incontra un ostacolo si prova quello opposto,
      // poi la linea quasi dritta.
      return traceCenterline(towns[i], towns[j], m, phase, buildings)
        ?? traceCenterline(towns[i], towns[j], -m, phase, buildings)
        ?? traceCenterline(towns[i], towns[j], m * 0.2, phase, buildings);
    });

    const B = new Builder();
    const lamps = [];
    const up = new THREE.Vector3(), tangent = new THREE.Vector3(), side = new THREE.Vector3();
    const edge = new THREE.Vector3(), center = new THREE.Vector3();
    const left = [], right = [];
    const shade = new THREE.Color();
    let roadLength = 0;
    for (const line of lines) {
      left.length = 0; right.length = 0;
      const n = line.length;
      let sinceLamp = LAMP_SPACING * 0.5, lampSide = 1;
      for (let i = 0; i < n; i++) {
        up.copy(line[i]);
        tangent.subVectors(line[Math.min(n - 1, i + 1)], line[Math.max(0, i - 1)]);
        side.crossVectors(tangent, up).normalize();
        sampleGround(up, _hit);
        center.copy(_hit.point);
        // Estremità assottigliate: il sentiero sfuma invece di finire di netto.
        const taper = Math.min(1, (Math.min(i, n - 1 - i) + 1) / 4);
        for (const [s, out] of [[-1, left], [1, right]]) {
          edge.copy(center).addScaledVector(side, s * HALF_WIDTH * (0.45 + 0.55 * taper)).normalize();
          sampleGround(edge, _hit);
          out.push(_hit.point.clone().addScaledVector(_hit.normal, LIFT));
        }
        if (i > 0) {
          roadLength += line[i].angleTo(line[i - 1]) * PLANET_RADIUS;
          sinceLamp += line[i].angleTo(line[i - 1]) * PLANET_RADIUS;
        }
        if (sinceLamp >= LAMP_SPACING && i > 1 && i < n - 2) {
          sinceLamp = 0;
          lampSide = -lampSide;
          edge.copy(center).addScaledVector(side, lampSide * LAMP_OFFSET).normalize();
          sampleGround(edge, _hit);
          lamps.push({ base: _hit.point.clone(), up: edge.clone(), side: side.clone(), blocked: false });
        }
      }
      for (let i = 0; i < n - 1; i++) {
        // Un tono per quadrilatero: la terra battuta è a chiazze come le facce del pianeta.
        shade.copy(DIRT).multiplyScalar(0.92 + rand() * 0.14);
        B.tri(left[i], right[i], right[i + 1], shade);
        B.tri(left[i], right[i + 1], left[i + 1], shade);
      }
    }

    // Lampioni: niente dove un albero o una casa è troppo vicino.
    const probes = lamps.map((l) => {
      const p = l.base.clone().addScaledVector(l.up, LAMP_HEIGHT * 0.5);
      p.blocked = false;
      p.lamp = l;
      return p;
    });
    markObstructed(probes, terrainGroup, LAMP_CLEARANCE);
    const lit = [];
    for (const probe of probes) {
      const l = probe.lamp;
      if (probe.blocked) continue;
      // Soglia di accensione: dal paese verso l'esterno, con un po' di disordine.
      const seed = 0.05 + rand() * 0.75;
      const foot = l.base.clone().addScaledVector(l.up, -0.08);
      B.post(foot, l.up, l.side, 0.03, LAMP_HEIGHT + 0.08, POST);
      const head = l.base.clone().addScaledVector(l.up, LAMP_HEIGHT);
      B.post(head, l.up, l.side, 0.075, 0.1, HEAD, seed);
      lit.push({ pos: head.addScaledVector(l.up, 0.05), seed });
    }

    this.stats = { links: lines.length, roadLength: Math.round(roadLength), lamps: lit.length, skippedLamps: lamps.length - lit.length, rejects: { ...rejects } };

    this.lampOn = { value: 0 };
    if (lines.length) {
      const mat = lampLambertMaterial(this.lampOn, new THREE.Color(1.0, 0.82, 0.5).multiplyScalar(2.0));
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -4;
      this.mesh = new THREE.Mesh(B.build(), mat);
      this.mesh.matrixAutoUpdate = false;
      this.group.add(this.mesh);
    }

    // Aloni dei lampioni: un quadrato additivo per lampione, di fronte alla camera.
    const aPos = new Float32Array(lit.length * 3);
    const aSeed = new Float32Array(lit.length);
    lit.forEach((l, i) => { aPos.set([l.pos.x, l.pos.y, l.pos.z], i * 3); aSeed[i] = l.seed; });
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
    geo.instanceCount = lit.length;
    this.haloUniforms = { uLit: this.lampOn };
    this.halos = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.haloUniforms,
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.halos.frustumCulled = false;
    this.halos.renderOrder = 3;
    this.halos.visible = false;
    this.group.add(this.halos);

    this.hasLamps = lit.length > 0;
    scene.add(this.group);
  }

  update(nightFactor) {
    if (!this.enabled) return;
    const on = nightRamp(nightFactor, 0.45, 0.85);
    this.lampOn.value = on;
    this.halos.visible = this.hasLamps && on > 0.04;
  }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
  }
}
