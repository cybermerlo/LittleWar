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
 * ATTENZIONE: la mesh renderizzata è l'approssimazione *lineare a tratti* di
 * questo campo (triangoli piatti tra i vertici). Per appoggiare oggetti sul
 * terreno NON usare questo modulo ma `client/scene/planetSurface.js`, che
 * campiona i triangoli effettivamente disegnati. Qui la quota è quella
 * "ideale", che tra un vertice e l'altro sta sopra o sotto quella visibile.
 */

export const PLANET_RADIUS = 50;
export const MOUNTAIN_HEIGHT = 5.2;
export const WATER_LEVEL = 0.05;

const NOISE_SCALE = 0.7;
const noise3D = createNoise3D(() => 0.42);

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(x, edge0, edge1) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Altezza normalizzata 0..1 lungo una direzione unitaria (nx, ny, nz). */
export function heightAt01(nx, ny, nz) {
  const base   = noise3D(nx * NOISE_SCALE, ny * NOISE_SCALE, nz * NOISE_SCALE);
  const broad  = noise3D(nx * 1.8,         ny * 1.8,         nz * 1.8);
  const detail = noise3D(nx * 3.0,         ny * 3.0,         nz * 3.0);
  const n = (base * 1.0 + broad * 0.25 + detail * 0.06) / 1.31;
  const n01 = clamp01((n + 1) * 0.5);
  return Math.pow(smoothstep(n01, 0.46, 0.92), 1.85);
}

/** Raggio della superficie ideale lungo una direzione unitaria. */
export function radiusAt(nx, ny, nz) {
  return PLANET_RADIUS + heightAt01(nx, ny, nz) * MOUNTAIN_HEIGHT;
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
