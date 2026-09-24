/**
 * Traiettoria dei proiettili — matematica pura, identica su client e server.
 *
 * Un proiettile percorre un cerchio massimo a velocità angolare costante, quindi
 * la sua posizione dipende solo da punto di partenza, direzione ed età:
 *
 *     pos(a) = p · cos(a) + t · sin(a)        a = velocità · età
 *
 * con `p` la posizione unitaria di partenza e `t` la tangente di volo. Per
 * questo il server non ha bisogno di ritrasmettere la posizione dei proiettili
 * a ogni tick: annuncia lo sparo una volta sola e ogni client ricostruisce
 * da sé il volo, a 60 fps e senza scatti. Prima ogni proiettile viaggiava
 * dentro il game-state 40 volte al secondo: in uno scontro erano centinaia di
 * KB/s per client, ed era la causa principale del lag durante le sparatorie.
 */

import { WEAPON_CONFIGS } from './constants.js';

/**
 * Scarti di direzione dei colpi di una raffica. Usata dal server per creare i
 * proiettili e dal client per mostrarli subito, prima della conferma.
 */
export function shotHeadingOffsets(weaponLevel) {
  const wl = Math.max(0, Math.min(WEAPON_CONFIGS.length - 1, Math.floor(Number(weaponLevel) || 0)));
  const { bullets, spread } = WEAPON_CONFIGS[wl];
  if (bullets === 1) return [0];
  const out = new Array(bullets);
  for (let i = 0; i < bullets; i++) out[i] = (i / (bullets - 1) - 0.5) * spread;
  return out;
}

/** Posizione unitaria `p` e tangente di volo `t` (heading 0 = nord locale). */
export function makeTrajectory(theta, phi, heading) {
  const st = Math.sin(theta), ct = Math.cos(theta);
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const ch = Math.cos(heading), sh = Math.sin(heading);
  return {
    px: st * cp, py: ct, pz: st * sp,
    // t = cos(h)·nord + sin(h)·est, con nord = (ct·cp, −st, ct·sp) ed est = (−sp, 0, cp)
    tx: ch * ct * cp - sh * sp,
    ty: -ch * st,
    tz: ch * ct * sp + sh * cp,
  };
}

/** Punto unitario dopo aver percorso l'angolo `angle` (radianti). */
export function trajectoryPoint(traj, angle, out) {
  const c = Math.cos(angle), s = Math.sin(angle);
  out.x = traj.px * c + traj.tx * s;
  out.y = traj.py * c + traj.ty * s;
  out.z = traj.pz * c + traj.tz * s;
  return out;
}

/** Direzione di volo (unitaria) dopo aver percorso l'angolo `angle`. */
export function trajectoryTangent(traj, angle, out) {
  const c = Math.cos(angle), s = Math.sin(angle);
  out.x = traj.tx * c - traj.px * s;
  out.y = traj.ty * c - traj.py * s;
  out.z = traj.tz * c - traj.pz * s;
  return out;
}

/**
 * Quadrato della distanza tra il punto P e il segmento AB (tutto in unità
 * mondo). Serve a non far "saltare" un bersaglio al proiettile: in un tick un
 * colpo avanza di più del proprio raggio di impatto.
 */
export function segmentPointDistSq(ax, ay, az, bx, by, bz, px, py, pz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-12 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}
