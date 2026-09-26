import * as THREE from 'three';

/**
 * Pezzi comuni ai moduli che animano il mondo (barche, uccelli, fumo, fari,
 * aurora): generatore con seme fisso, uniform condivise e soglie della notte.
 *
 * Le uniform di luce e tempo sono UN solo oggetto per tutti i materiali: ogni
 * ShaderMaterial le referenzia invece di copiarle, così `WorldLife.update`
 * le aggiorna una volta per frame e nessun modulo deve ricalcolarle.
 */

/** PRNG deterministico (mulberry32), come in Terrain.js e planetField.js. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform condivise: tempo, direzione e colore del sole, luce ambiente. */
export const lifeUniforms = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },
  uAmbient: { value: new THREE.Color(0.5, 0.5, 0.5) },
};

/**
 * Uniform di un ShaderMaterial con nebbia: quelle della nebbia vanno clonate
 * (Three.js le riscrive per materiale), le nostre restano condivise.
 */
export function withLifeUniforms(extra = {}, fog = true) {
  const base = fog ? THREE.UniformsUtils.clone(THREE.UniformsLib.fog) : {};
  return Object.assign(base, lifeUniforms, extra);
}

/**
 * `sky.getNightFactor()` è l'opacità delle stelle: 0.2 a mezzogiorno, 0.4 al
 * tramonto, 0.5 all'alba, 1 a notte fonda. Mai `nf > 0`: resterebbe acceso di
 * giorno. Queste soglie sono il vocabolario comune dei moduli.
 */
export function nightRamp(nf, lo, hi) {
  return THREE.MathUtils.smoothstep(nf, lo, hi);
}

/** Base tangente (u, v) ortonormale in un punto della sfera. */
export function tangentBasis(dir, outU, outV) {
  if (Math.abs(dir.y) < 0.9) outU.set(0, 1, 0); else outU.set(1, 0, 0);
  outU.cross(dir).normalize();
  outV.crossVectors(dir, outU).normalize();
}

/** Direzione a distanza angolare `rho` da `center` lungo l'angolo `a` della base (u, v). */
export function offsetDir(center, u, v, a, rho, out) {
  const s = Math.sin(rho);
  return out.copy(center).multiplyScalar(Math.cos(rho))
    .addScaledVector(u, Math.cos(a) * s)
    .addScaledVector(v, Math.sin(a) * s)
    .normalize();
}
