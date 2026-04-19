import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';

export const PLANET_RADIUS = 50;
export const MOUNTAIN_HEIGHT = 5.2;
export const WATER_LEVEL = 0.05;
const NOISE_SCALE = 0.7;

const noise3D = createNoise3D(() => 0.42);

// Altezza normalizzata 0..1 in funzione di una direzione unitaria (nx,ny,nz).
// È l'UNICA fonte di verità per la forma del pianeta: sia la mesh visuale che
// il piazzamento di alberi/edifici la interrogano, così non c'è più dipendenza
// dalla risoluzione dei triangoli.
export function heightAt01(nx, ny, nz) {
  const base   = noise3D(nx * NOISE_SCALE, ny * NOISE_SCALE, nz * NOISE_SCALE);
  const broad  = noise3D(nx * 1.8,         ny * 1.8,         nz * 1.8);
  const detail = noise3D(nx * 3.0,         ny * 3.0,         nz * 3.0);
  const n = (base * 1.0 + broad * 0.25 + detail * 0.06) / 1.31;
  const n01 = THREE.MathUtils.clamp((n + 1) * 0.5, 0, 1);
  return Math.pow(THREE.MathUtils.smoothstep(n01, 0.46, 0.92), 1.85);
}

export function radiusAt(nx, ny, nz) {
  return PLANET_RADIUS + heightAt01(nx, ny, nz) * MOUNTAIN_HEIGHT;
}

// Scratch per evitare allocazioni nel loop di piazzamento.
const _d   = new THREE.Vector3();
const _ref = new THREE.Vector3();
const _t   = new THREE.Vector3();
const _b   = new THREE.Vector3();
const _dt  = new THREE.Vector3();
const _db  = new THREE.Vector3();
const _pt  = new THREE.Vector3();
const _pb  = new THREE.Vector3();
const _ab  = new THREE.Vector3();
const _ac  = new THREE.Vector3();

function pointOnSurface(dir, out) {
  const r = radiusAt(dir.x, dir.y, dir.z);
  return out.copy(dir).multiplyScalar(r);
}

/**
 * Ritorna posizione, normale, quota normalizzata e pendenza della superficie
 * lungo la direzione `dir` (non serve che sia normalizzata). La normale viene
 * ricavata da un gradiente numerico nel piano tangente: riflette la reale
 * inclinazione del noise, non l'orientamento radiale.
 *
 * `outInfo` è un oggetto opzionale da riutilizzare; vengono (ri)usati i Vector3
 * `point` e `normal` se presenti, altrimenti ne crea di nuovi.
 */
export function surfaceAt(dir, outInfo = {}) {
  _d.copy(dir).normalize();
  const h01 = heightAt01(_d.x, _d.y, _d.z);
  const r   = PLANET_RADIUS + h01 * MOUNTAIN_HEIGHT;

  const point = outInfo.point || new THREE.Vector3();
  point.copy(_d).multiplyScalar(r);

  // Base tangente attorno a d
  _ref.set(Math.abs(_d.y) < 0.9 ? 0 : 1, Math.abs(_d.y) < 0.9 ? 1 : 0, 0);
  _t.crossVectors(_d, _ref).normalize();
  _b.crossVectors(_d, _t).normalize();

  const eps = 0.015;
  _dt.copy(_d).addScaledVector(_t, eps).normalize();
  _db.copy(_d).addScaledVector(_b, eps).normalize();
  pointOnSurface(_dt, _pt);
  pointOnSurface(_db, _pb);

  const normal = outInfo.normal || new THREE.Vector3();
  _ab.subVectors(_pt, point);
  _ac.subVectors(_pb, point);
  normal.crossVectors(_ab, _ac).normalize();
  if (normal.dot(_d) < 0) normal.negate();

  outInfo.point    = point;
  outInfo.normal   = normal;
  outInfo.height01 = h01;
  // slope: 0 = orizzontale (normale allineata al radiale), 1 = verticale.
  outInfo.slope    = 1 - Math.max(0, Math.min(1, normal.dot(_d)));
  return outInfo;
}
