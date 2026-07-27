import * as THREE from 'three';
import { PLANET_RADIUS, MOUNTAIN_HEIGHT, radiusAt } from '../../shared/planetField.js';

/**
 * Campionatore della superficie EFFETTIVAMENTE RENDERIZZATA del pianeta.
 *
 * Perché serve
 * ------------
 * La forma del pianeta è definita da un campo di rumore continuo
 * (`shared/planetField.js`), ma quello che si vede è una IcosahedronGeometry
 * suddivisa: i vertici stanno sul campo, tutto ciò che sta *tra* i vertici è un
 * triangolo piatto. Con `flatShading` la differenza è visibile a occhio.
 *
 * Appoggiare un oggetto alla quota analitica lo mette quindi:
 *  - sospeso in aria al centro dei triangoli (la corda sta sotto la curva);
 *  - sepolto vicino a creste e avvallamenti (dove la corda sta sopra).
 *
 * Questo modulo intersecca invece il raggio uscente dal centro del pianeta con
 * i triangoli reali della mesh e restituisce il punto e la normale della
 * faccia — cioè esattamente il piano su cui l'oggetto deve poggiare, e con
 * `flatShading` esattamente il piano che l'occhio percepisce.
 *
 * Accelerazione
 * -------------
 * Griglia su cubemap: 6 facce × GRID×GRID celle, con GRID scelto in base alla
 * dimensione reale dei triangoli (con `detail = 5` sono larghi ~10 unità, non
 * pochi decimi: `PolyhedronGeometry` suddivide ogni spigolo in `detail + 1`
 * segmenti, non ricorsivamente). Ogni triangolo viene registrato nelle celle
 * dei suoi vertici; la query esamina il 3×3 attorno alla propria cella e, se
 * non trova nulla, ricade su una scansione completa — così il risultato è
 * corretto per costruzione qualunque sia la risoluzione della mesh.
 */

let GRID = 8;                 // celle per lato di ogni faccia del cubo
let CELLS_PER_FACE = GRID * GRID;
let TOTAL_CELLS = 6 * CELLS_PER_FACE;
const HIT_EPS = 1e-6;

/** Faccia del cubo (0..5) e coordinate cella per una direzione unitaria. */
function cellIndexFor(x, y, z) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face, u, v, m;
  if (ax >= ay && ax >= az) {
    m = ax; face = x > 0 ? 0 : 1; u = z / m; v = y / m;
  } else if (ay >= az) {
    m = ay; face = y > 0 ? 2 : 3; u = x / m; v = z / m;
  } else {
    m = az; face = z > 0 ? 4 : 5; u = x / m; v = y / m;
  }
  let cu = ((u + 1) * 0.5 * GRID) | 0;
  let cv = ((v + 1) * 0.5 * GRID) | 0;
  if (cu < 0) cu = 0; else if (cu >= GRID) cu = GRID - 1;
  if (cv < 0) cv = 0; else if (cv >= GRID) cv = GRID - 1;
  return face * CELLS_PER_FACE + cv * GRID + cu;
}

/** Celle del vicinato 3×3 attorno a una direzione, scritte in `out`. */
function neighborhoodCells(x, y, z, out) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face, u, v, m;
  if (ax >= ay && ax >= az) {
    m = ax; face = x > 0 ? 0 : 1; u = z / m; v = y / m;
  } else if (ay >= az) {
    m = ay; face = y > 0 ? 2 : 3; u = x / m; v = z / m;
  } else {
    m = az; face = z > 0 ? 4 : 5; u = x / m; v = y / m;
  }
  const cu = Math.min(GRID - 1, Math.max(0, ((u + 1) * 0.5 * GRID) | 0));
  const cv = Math.min(GRID - 1, Math.max(0, ((v + 1) * 0.5 * GRID) | 0));

  let n = 0;
  const base = face * CELLS_PER_FACE;
  for (let dv = -1; dv <= 1; dv++) {
    const vv = cv + dv;
    if (vv < 0 || vv >= GRID) continue;
    for (let du = -1; du <= 1; du++) {
      const uu = cu + du;
      if (uu < 0 || uu >= GRID) continue;
      out[n++] = base + vv * GRID + uu;
    }
  }
  return n;
}

/** Descrittore della superficie in un punto. Riusabile per evitare garbage. */
export function makeSurfaceHit() {
  return {
    point: new THREE.Vector3(),   // punto sulla mesh renderizzata
    normal: new THREE.Vector3(),  // normale della faccia (uscente)
    radius: PLANET_RADIUS,        // |point|
    height01: 0,                  // quota normalizzata 0..1
    slope: 0,                     // 0 = piano, 1 = parete
    exact: false,                 // true se ha colpito un triangolo reale
  };
}

let _grid = null;        // Int32Array concatenato: indici di triangolo
let _gridStart = null;   // offset di inizio per cella
let _gridCount = null;   // numero di triangoli per cella
let _triA = null;        // vertici dei triangoli (x,y,z per vertice)
let _triB = null;
let _triC = null;
let _triCount = 0;

const _cells = new Int32Array(9);
const _fallbackHit = makeSurfaceHit();

/**
 * Sceglie la risoluzione della griglia misurando l'apertura angolare massima
 * dei triangoli: una cella non deve mai essere più piccola di un triangolo.
 */
function chooseGridResolution(pos, index, triCount) {
  let maxSpan = 0;
  const step = Math.max(1, Math.floor(triCount / 256)); // campione, non serve l'esatto
  const v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

  for (let t = 0; t < triCount; t += step) {
    for (let k = 0; k < 3; k++) {
      const i = index ? index.getX(t * 3 + k) : t * 3 + k;
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const l = Math.hypot(x, y, z) || 1;
      v[k][0] = x / l; v[k][1] = y / l; v[k][2] = z / l;
    }
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3;
      const dot = Math.max(-1, Math.min(1, v[a][0] * v[b][0] + v[a][1] * v[b][1] + v[a][2] * v[b][2]));
      const ang = Math.acos(dot);
      if (ang > maxSpan) maxSpan = ang;
    }
  }

  if (!(maxSpan > 0)) return 8;
  // Una faccia del cubo copre ~π/2 rad: quante celle ci stanno larghe `maxSpan`?
  const g = Math.floor((Math.PI / 2) / maxSpan);
  return Math.max(2, Math.min(48, g));
}

/**
 * Costruisce l'indice spaziale a partire dalla geometria del pianeta.
 * Da chiamare una sola volta, subito dopo aver creato la mesh.
 */
export function buildPlanetSurfaceIndex(geometry) {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;

  _triCount = triCount;
  _triA = new Float32Array(triCount * 3);
  _triB = new Float32Array(triCount * 3);
  _triC = new Float32Array(triCount * 3);

  // Celle grandi almeno quanto un triangolo: solo così il vicinato 3×3 attorno
  // alla query contiene di sicuro la cella di un vertice del triangolo giusto.
  GRID = chooseGridResolution(pos, index, triCount);
  CELLS_PER_FACE = GRID * GRID;
  TOTAL_CELLS = 6 * CELLS_PER_FACE;

  const counts = new Int32Array(TOTAL_CELLS);
  // Ogni triangolo viene registrato al più una volta per cella distinta.
  const triCells = new Int32Array(triCount * 3);
  const triCellCount = new Uint8Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3)     : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

    const j = t * 3;
    _triA[j] = pos.getX(i0); _triA[j + 1] = pos.getY(i0); _triA[j + 2] = pos.getZ(i0);
    _triB[j] = pos.getX(i1); _triB[j + 1] = pos.getY(i1); _triB[j + 2] = pos.getZ(i1);
    _triC[j] = pos.getX(i2); _triC[j + 1] = pos.getY(i2); _triC[j + 2] = pos.getZ(i2);

    let n = 0;
    for (let k = 0; k < 3; k++) {
      const src = k === 0 ? _triA : k === 1 ? _triB : _triC;
      const x = src[j], y = src[j + 1], z = src[j + 2];
      const cell = cellIndexFor(x, y, z);
      let dup = false;
      for (let q = 0; q < n; q++) if (triCells[j + q] === cell) { dup = true; break; }
      if (dup) continue;
      triCells[j + n] = cell;
      n++;
      counts[cell]++;
    }
    triCellCount[t] = n;
  }

  _gridStart = new Int32Array(TOTAL_CELLS);
  let running = 0;
  for (let c = 0; c < TOTAL_CELLS; c++) {
    _gridStart[c] = running;
    running += counts[c];
  }
  _grid = new Int32Array(running);
  _gridCount = new Int32Array(TOTAL_CELLS);

  for (let t = 0; t < triCount; t++) {
    const j = t * 3;
    for (let q = 0; q < triCellCount[t]; q++) {
      const cell = triCells[j + q];
      _grid[_gridStart[cell] + _gridCount[cell]] = t;
      _gridCount[cell]++;
    }
  }
}

export function isPlanetSurfaceReady() {
  return _grid !== null;
}

/**
 * Interseca il raggio (origine = centro pianeta, direzione = `dir`) con la
 * mesh e riempie `out`. Se l'indice non è pronto o — caso patologico — nessun
 * triangolo viene colpito, ricade sul campo analitico segnalando `exact:false`.
 *
 * @param {THREE.Vector3|{x:number,y:number,z:number}} dir  direzione, anche non normalizzata
 * @param {ReturnType<makeSurfaceHit>} [out]
 */
export function sampleGround(dir, out = makeSurfaceHit()) {
  let dx = dir.x, dy = dir.y, dz = dir.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl; dy /= dl; dz /= dl;

  if (_grid) {
    const nCells = neighborhoodCells(dx, dy, dz, _cells);
    let bestT = Infinity;
    let bestTri = -1;

    // Möller–Trumbore con origine nel centro del pianeta (la superficie è
    // stellata rispetto al centro, quindi il raggio incontra un solo triangolo).
    const intersect = (tri) => {
      const j = tri * 3;
      const ax = _triA[j], ay = _triA[j + 1], az = _triA[j + 2];
      const e1x = _triB[j] - ax, e1y = _triB[j + 1] - ay, e1z = _triB[j + 2] - az;
      const e2x = _triC[j] - ax, e2y = _triC[j + 1] - ay, e2z = _triC[j + 2] - az;

      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -HIT_EPS && det < HIT_EPS) return;
      const invDet = 1 / det;

      // origine - a = -a (il raggio parte da (0,0,0))
      const tx = -ax, ty = -ay, tz = -az;
      const u = (tx * px + ty * py + tz * pz) * invDet;
      if (u < -1e-5 || u > 1 + 1e-5) return;

      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * invDet;
      if (v < -1e-5 || u + v > 1 + 1e-5) return;

      const tHit = (e2x * qx + e2y * qy + e2z * qz) * invDet;
      if (tHit <= 0 || tHit >= bestT) return;
      bestT = tHit;
      bestTri = tri;
    };

    for (let c = 0; c < nCells; c++) {
      const cell = _cells[c];
      const start = _gridStart[cell];
      const end = start + _gridCount[cell];
      for (let g = start; g < end; g++) intersect(_grid[g]);
    }

    // Rete di sicurezza: se la griglia non ha coperto il caso (mesh con
    // triangoli di dimensione molto disomogenea), scansiona tutto. È lento ma
    // garantisce che nessun oggetto venga piazzato su una quota inventata.
    if (bestTri < 0) {
      for (let tri = 0; tri < _triCount; tri++) intersect(tri);
    }

    if (bestTri >= 0) {
      const j = bestTri * 3;
      out.point.set(dx * bestT, dy * bestT, dz * bestT);
      out.radius = bestT;

      const e1x = _triB[j] - _triA[j];
      const e1y = _triB[j + 1] - _triA[j + 1];
      const e1z = _triB[j + 2] - _triA[j + 2];
      const e2x = _triC[j] - _triA[j];
      const e2y = _triC[j + 1] - _triA[j + 1];
      const e2z = _triC[j + 2] - _triA[j + 2];
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (nx * dx + ny * dy + nz * dz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      out.normal.set(nx, ny, nz);

      out.height01 = (bestT - PLANET_RADIUS) / MOUNTAIN_HEIGHT;
      out.slope = 1 - Math.max(0, Math.min(1, nx * dx + ny * dy + nz * dz));
      out.exact = true;
      return out;
    }
  }

  // Fallback analitico (indice non ancora costruito).
  const r = radiusAt(dx, dy, dz);
  out.point.set(dx * r, dy * r, dz * r);
  out.normal.set(dx, dy, dz);
  out.radius = r;
  out.height01 = (r - PLANET_RADIUS) / MOUNTAIN_HEIGHT;
  out.slope = 0;
  out.exact = false;
  return out;
}

/** Raggio del terreno visibile lungo una direzione. */
export function groundRadius(dir) {
  return sampleGround(dir, _fallbackHit).radius;
}

const _sphDir = new THREE.Vector3();

/** Come `sampleGround` ma da coordinate sferiche di gioco. */
export function sampleGroundSpherical(theta, phi, out = makeSurfaceHit()) {
  const st = Math.sin(theta);
  _sphDir.set(st * Math.cos(phi), Math.cos(theta), st * Math.sin(phi));
  return sampleGround(_sphDir, out);
}

/** Raggio del terreno visibile a (theta, phi). */
export function groundRadiusSpherical(theta, phi) {
  return sampleGroundSpherical(theta, phi, _fallbackHit).radius;
}

// ── Appoggio di una base rigida su terreno irregolare ─────────────────────────

const _planeDir = new THREE.Vector3();
const _planeHit = makeSurfaceHit();
const _tangentU = new THREE.Vector3();
const _tangentV = new THREE.Vector3();
const _refAxis = new THREE.Vector3();

/**
 * Adatta un piano d'appoggio all'impronta di una struttura.
 *
 * Campiona il terreno su una griglia che copre il footprint, media le normali
 * per ottenere la giacitura, poi **alza il piano fino al campione più alto**:
 * così la base non entra mai nel terreno. `gap` riporta di quanto il punto più
 * basso resta sospeso — il chiamante può rifiutare siti troppo accidentati.
 *
 * @param {THREE.Vector3} centerDir  direzione del centro della struttura
 * @param {number} halfWidth         mezza larghezza dell'impronta (unità mondo)
 * @param {number} halfDepth         mezza profondità dell'impronta
 * @param {number} [yaw]             rotazione dell'impronta nel piano tangente
 * @param {number} [samplesPerAxis]
 * @returns {{origin:THREE.Vector3, normal:THREE.Vector3, gap:number, maxSlope:number}}
 */
export function fitGroundPlane(centerDir, halfWidth, halfDepth, yaw = 0, samplesPerAxis = 5) {
  _planeDir.copy(centerDir).normalize();
  sampleGround(_planeDir, _planeHit);

  const centerPoint = _planeHit.point.clone();
  const radial = _planeDir.clone();

  // Base tangente ruotata di `yaw`
  _refAxis.set(Math.abs(radial.y) < 0.9 ? 0 : 1, Math.abs(radial.y) < 0.9 ? 1 : 0, 0);
  _tangentU.crossVectors(radial, _refAxis).normalize();
  _tangentV.crossVectors(radial, _tangentU).normalize();
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const u = _tangentU.clone().multiplyScalar(cy).addScaledVector(_tangentV, sy);
  const v = _tangentU.clone().multiplyScalar(-sy).addScaledVector(_tangentV, cy);

  const normalSum = new THREE.Vector3();
  const samples = [];
  let maxSlope = 0;
  const n = Math.max(2, samplesPerAxis);

  for (let i = 0; i < n; i++) {
    const su = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    for (let k = 0; k < n; k++) {
      const sv = n === 1 ? 0 : (k / (n - 1)) * 2 - 1;
      _planeDir.copy(centerPoint)
        .addScaledVector(u, su * halfWidth)
        .addScaledVector(v, sv * halfDepth)
        .normalize();
      sampleGround(_planeDir, _planeHit);
      samples.push(_planeHit.point.clone());
      normalSum.add(_planeHit.normal);
      if (_planeHit.slope > maxSlope) maxSlope = _planeHit.slope;
    }
  }

  const normal = normalSum.lengthSq() > 1e-8
    ? normalSum.normalize()
    : radial.clone();
  if (normal.dot(radial) < 0) normal.negate();

  // Traslazione lungo la normale: il piano passa per il campione più esterno.
  let maxD = -Infinity;
  let minD = Infinity;
  for (const s of samples) {
    const d = s.dot(normal);
    if (d > maxD) maxD = d;
    if (d < minD) minD = d;
  }

  const origin = centerPoint.clone();
  origin.addScaledVector(normal, maxD - origin.dot(normal));

  return { origin, normal, gap: maxD - minD, maxSlope };
}

/**
 * Costruisce una geometria ad anello che **segue il profilo del terreno**.
 *
 * Un `RingGeometry` piatto su una sfera di raggio 50 sprofonda già di 1 unità
 * al bordo di un cerchio di raggio 10 per la sola curvatura, senza contare le
 * colline: qui invece ogni vertice viene campionato sul terreno reale.
 * I vertici sono in coordinate world.
 *
 * @param {THREE.Vector3} centerDir direzione del centro
 * @param {number} innerRadius      raggio interno (unità mondo, lungo la superficie)
 * @param {number} outerRadius      raggio esterno
 * @param {number} [segments]
 * @param {number} [offset]         sollevamento lungo la normale locale
 */
export function createConformingRingGeometry(centerDir, innerRadius, outerRadius, segments = 72, offset = 0.12) {
  const dir = centerDir.clone().normalize();
  const ref = new THREE.Vector3(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0);
  const tu = new THREE.Vector3().crossVectors(dir, ref).normalize();
  const tv = new THREE.Vector3().crossVectors(dir, tu).normalize();

  const positions = new Float32Array(segments * 2 * 3);
  const indices = new Uint16Array(segments * 6);
  const hit = makeSurfaceHit();
  const probe = new THREE.Vector3();
  const center = sampleGround(dir, hit).point.clone();

  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let ring = 0; ring < 2; ring++) {
      const radius = ring === 0 ? innerRadius : outerRadius;
      probe.copy(center)
        .addScaledVector(tu, ca * radius)
        .addScaledVector(tv, sa * radius)
        .normalize();
      sampleGround(probe, hit);
      const idx = (s * 2 + ring) * 3;
      positions[idx]     = hit.point.x + hit.normal.x * offset;
      positions[idx + 1] = hit.point.y + hit.normal.y * offset;
      positions[idx + 2] = hit.point.z + hit.normal.z * offset;
    }
  }

  for (let s = 0; s < segments; s++) {
    const a0 = s * 2;
    const a1 = a0 + 1;
    const b0 = ((s + 1) % segments) * 2;
    const b1 = b0 + 1;
    const o = s * 6;
    indices[o]     = a0; indices[o + 1] = b0; indices[o + 2] = a1;
    indices[o + 3] = a1; indices[o + 4] = b0; indices[o + 5] = b1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}
