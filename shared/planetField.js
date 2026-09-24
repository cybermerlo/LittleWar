import { createNoise3D } from 'simplex-noise';

/**
 * Campo di altezza del pianeta — UNICA definizione analitica della forma.
 *
 * Vive in `shared/` perché serve a entrambi i lati:
 *  - il client ci costruisce la mesh visibile (client/scene/Planet.js);
 *  - il server lo interroga per scegliere posizioni valide (torrette e
 *    bersagli non devono finire in mare o su una parete verticale).
 *
 * Il seed è fisso, quindi client e server generano esattamente lo stesso
 * pianeta senza scambiarsi dati.
 *
 * Forma: continenti da rumore frattale con un leggero "domain warp" (coste
 * frastagliate invece di macchie tonde), pianure costiere basse e piatte dove
 * stanno città e torrette, colline nell'entroterra e catene montuose a creste
 * (rumore "ridged") solo in alcune regioni. Il mare ha un fondale vero, con
 * piattaforme poco profonde vicino alla costa: è ciò che dà all'acqua il
 * turchese sotto riva e il blu scuro al largo.
 *
 * Quote: `elevationAt` restituisce unità mondo rispetto al livello del mare
 * (negativo sott'acqua), `heightAt01` la stessa quota normalizzata su
 * MOUNTAIN_HEIGHT. Le vette non superano MOUNTAIN_HEIGHT: gli aerei volano a
 * FLY_ALTITUDE = 56, cioè appena sopra.
 *
 * ATTENZIONE: la mesh renderizzata è l'approssimazione *lineare a tratti* di
 * questo campo (triangoli piatti tra i vertici). Per appoggiare oggetti sul
 * terreno NON usare questo modulo ma `client/scene/planetSurface.js`, che
 * campiona i triangoli effettivamente disegnati.
 */

export const PLANET_RADIUS = 50;
/** Quota massima delle vette sopra il livello del mare (unità mondo). */
export const MOUNTAIN_HEIGHT = 5.2;
/** Profondità massima del fondale (unità mondo). */
export const SEA_DEPTH = 2.6;
/** Livello del mare in quota normalizzata: sotto è acqua. */
export const WATER_LEVEL = 0;

/** Spostamento del rumore dei continenti: più alto = più terra (~50%). */
const LAND_BIAS = 0.035;

/** PRNG deterministico (mulberry32): permutazioni di rumore ben mescolate. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const continentNoise = createNoise3D(mulberry32(4201));
const warpNoise      = createNoise3D(mulberry32(1337));
const ridgeNoise     = createNoise3D(mulberry32(9091));
const reliefNoise    = createNoise3D(mulberry32(2718));
const detailNoise    = createNoise3D(mulberry32(5150));

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function fbm(noise, x, y, z, octaves, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= 2.03;
  }
  return sum / norm;
}

/** "Continentalità" grezza: > 0 terra, < 0 mare. */
function continentAt(nx, ny, nz) {
  // Domain warp: sposta il punto di campionamento con un altro rumore, così
  // le coste diventano golfi e penisole invece di contorni morbidi.
  const wx = warpNoise(nx * 1.7, ny * 1.7, nz * 1.7) * 0.28;
  const wy = warpNoise(nx * 1.7 + 11.3, ny * 1.7 + 4.1, nz * 1.7 - 7.7) * 0.28;
  const wz = warpNoise(nx * 1.7 - 5.2, ny * 1.7 + 9.6, nz * 1.7 + 2.9) * 0.28;
  // Poche ottave e persistenza bassa: con 5 ottave piene le coste diventavano
  // frattali e subito dietro la spiaggia c'era una scogliera sottomarina, così
  // le pianure erano strisce troppo strette per paesi e torrette.
  return fbm(continentNoise, (nx + wx) * 1.05, (ny + wy) * 1.05, (nz + wz) * 1.05, 4, 0.38) + LAND_BIAS;
}

/**
 * Quota del terreno lungo una direzione unitaria, in unità mondo rispetto al
 * livello del mare: da −SEA_DEPTH (fosse oceaniche) a MOUNTAIN_HEIGHT.
 */
export function elevationAt(nx, ny, nz) {
  const c = continentAt(nx, ny, nz);

  if (c < 0) {
    // Mare: piattaforma poco profonda lungo la costa, poi il largo.
    const d = smoothstep(0, 0.3, -c);
    return -(0.24 + (SEA_DEPTH - 0.24) * Math.pow(d, 1.25));
  }

  // Terra. La costa sale con una spiaggia corta; dietro, il rilievo NON
  // dipende dalla distanza dal mare ma da un rumore indipendente: così
  // esistono pianure ampie anche nell'entroterra (paesi e torrette ci
  // stanno comodi), colline dove il rilievo sale e catene montuose dove sale
  // ancora. Legato alla costa, il rilievo faceva della pianura una striscia.
  const shore = smoothstep(0, 0.03, c);
  const awayFromCoast = smoothstep(0.03, 0.14, c);
  const relief = fbm(reliefNoise, nx * 1.35 + 3.7, ny * 1.35 - 1.2, nz * 1.35 + 0.4, 3, 0.45); // −1..1
  const detail = fbm(detailNoise, nx * 5.5, ny * 5.5, nz * 5.5, 3); // −1..1

  let h = 0.05 + 0.1 * shore;
  // Colline dolci.
  h += awayFromCoast * smoothstep(0.02, 0.4, relief) * (0.1 + 0.08 * (0.5 + 0.5 * detail));

  // Catene montuose: creste di rumore "ridged" dove il rilievo è più alto.
  const rangeMask = smoothstep(0.24, 0.5, relief) * awayFromCoast;
  if (rangeMask > 0) {
    const r1 = 1 - Math.abs(ridgeNoise(nx * 2.6, ny * 2.6, nz * 2.6));
    const r2 = 1 - Math.abs(ridgeNoise(nx * 5.3 + 3.1, ny * 5.3 - 1.7, nz * 5.3 + 8.2));
    const ridged = Math.pow(r1, 2.4) * 0.8 + Math.pow(r2, 2.0) * 0.2;
    h += rangeMask * (0.12 + ridged * 0.7);
  }

  return MOUNTAIN_HEIGHT * Math.min(0.97, h);
}

/** Quota normalizzata (su MOUNTAIN_HEIGHT) lungo una direzione unitaria; negativa in mare. */
export function heightAt01(nx, ny, nz) {
  return elevationAt(nx, ny, nz) / MOUNTAIN_HEIGHT;
}

/** Raggio della superficie ideale lungo una direzione unitaria. */
export function radiusAt(nx, ny, nz) {
  return PLANET_RADIUS + elevationAt(nx, ny, nz);
}

/** Direzione unitaria da coordinate sferiche (stessa convenzione del gioco). */
export function directionFromSpherical(theta, phi) {
  const st = Math.sin(theta);
  return { x: st * Math.cos(phi), y: Math.cos(theta), z: st * Math.sin(phi) };
}

/** Altezza normalizzata a (theta, phi). */
export function heightAtSpherical(theta, phi) {
  const d = directionFromSpherical(theta, phi);
  return heightAt01(d.x, d.y, d.z);
}

/**
 * Pendenza 0..1 del campo ideale a (theta, phi): 0 = pianura, 1 = parete.
 * Calcolata come 1 - dot(normale, radiale) su un gradiente numerico nel piano
 * tangente. Serve al server per non piazzare strutture su un dirupo.
 */
export function slopeAtSpherical(theta, phi, eps = 0.02) {
  const d = directionFromSpherical(theta, phi);

  // Base tangente attorno a d: t = normalize(d × ref), b = normalize(d × t)
  const ax = Math.abs(d.y) < 0.9 ? 0 : 1;
  const ay = Math.abs(d.y) < 0.9 ? 1 : 0;
  let tx = -d.z * ay;
  let ty = d.z * ax;
  let tz = d.x * ay - d.y * ax;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;

  let bx = d.y * tz - d.z * ty;
  let by = d.z * tx - d.x * tz;
  let bz = d.x * ty - d.y * tx;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;

  const sample = (ox, oy, oz) => {
    let x = d.x + ox, y = d.y + oy, z = d.z + oz;
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    const r = radiusAt(x, y, z);
    return { x: x * r, y: y * r, z: z * r };
  };

  const p0 = sample(0, 0, 0);
  const pt = sample(tx * eps, ty * eps, tz * eps);
  const pb = sample(bx * eps, by * eps, bz * eps);

  const ux = pt.x - p0.x, uy = pt.y - p0.y, uz = pt.z - p0.z;
  const vx = pb.x - p0.x, vy = pb.y - p0.y, vz = pb.z - p0.z;

  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;

  let dot = nx * d.x + ny * d.y + nz * d.z;
  if (dot < 0) dot = -dot;
  return 1 - clamp01(dot);
}

/**
 * Estrae una posizione (theta, phi) casuale su terreno adatto a ospitare una
 * struttura: sopra il livello del mare, sotto le vette, non ripida.
 *
 * @param {object}   [opts]
 * @param {number}   [opts.minHeight]  quota normalizzata minima
 * @param {number}   [opts.maxHeight]  quota normalizzata massima
 * @param {number}   [opts.maxSlope]   pendenza massima accettata
 * @param {number}   [opts.attempts]   tentativi prima di arrendersi
 * @param {(t:number, p:number) => boolean} [opts.accept] filtro extra (es. distanza minima)
 * @param {() => number} [opts.random] sorgente casuale iniettabile (test)
 * @returns {{theta:number, phi:number, height01:number}}
 */
export function sampleBuildableSite(opts = {}) {
  const {
    minHeight = WATER_LEVEL + 0.03,
    maxHeight = 0.55,
    maxSlope  = 0.22,
    attempts  = 600,
    accept    = null,
    random    = Math.random,
  } = opts;

  let fallback = null;

  for (let i = 0; i < attempts; i++) {
    const theta = Math.acos(2 * random() - 1);
    const phi = random() * Math.PI * 2;
    if (accept && !accept(theta, phi)) continue;

    const h = heightAtSpherical(theta, phi);
    if (!fallback) fallback = { theta, phi, height01: h };
    if (h < minHeight || h > maxHeight) continue;
    if (slopeAtSpherical(theta, phi) > maxSlope) continue;
    return { theta, phi, height01: h };
  }

  // Nessun sito perfetto: meglio un sito qualsiasi che bloccare la partita.
  if (fallback) return fallback;
  const theta = Math.acos(2 * random() - 1);
  const phi = random() * Math.PI * 2;
  return { theta, phi, height01: heightAtSpherical(theta, phi) };
}
