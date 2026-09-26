/**
 * Geometria del volo per l'HUD (mirino, indicatori, radar), senza Three.js e
 * senza allocazioni: tutto scrive in oggetti passati dal chiamante.
 *
 * Convenzione del progetto: heading 0 = verso theta crescente ("nord" del
 * codice), π/2 = est; un heading che cresce vira a DESTRA.
 */

/**
 * Terna locale dell'aereo: P posizione unitaria, D direzione di volo,
 * R destra (= D × P). Stesse formule di makeTrajectory in shared/projectile.js.
 */
export function makeFlightFrame() {
  return { px: 0, py: 1, pz: 0, dx: 1, dy: 0, dz: 0, rx: 0, ry: 0, rz: 1 };
}

export function fillFlightFrame(out, theta, phi, heading) {
  const st = Math.sin(theta), ct = Math.cos(theta);
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const ch = Math.cos(heading), sh = Math.sin(heading);
  out.px = st * cp; out.py = ct; out.pz = st * sp;
  out.dx = ch * ct * cp - sh * sp;
  out.dy = -ch * st;
  out.dz = ch * ct * sp + sh * cp;
  out.rx = out.dy * out.pz - out.dz * out.py;
  out.ry = out.dz * out.px - out.dx * out.pz;
  out.rz = out.dx * out.py - out.dy * out.px;
  return out;
}

/**
 * Punto (in unità mondo, a raggio `radius`) raggiunto volando per `angle`
 * radianti sul cerchio massimo, con la rotta ruotata di `turn` radianti
 * (positivo = a destra). È il percorso dei proiettili.
 */
export function flightPoint(f, angle, turn, radius, out) {
  const ct = Math.cos(turn), st = Math.sin(turn);
  const tx = f.dx * ct + f.rx * st;
  const ty = f.dy * ct + f.ry * st;
  const tz = f.dz * ct + f.rz * st;
  const c = Math.cos(angle) * radius, s = Math.sin(angle) * radius;
  out.x = f.px * c + tx * s;
  out.y = f.py * c + ty * s;
  out.z = f.pz * c + tz * s;
  return out;
}

/**
 * Rotta relativa verso il punto (x, y, z): 0 = dritto davanti, positivo = a
 * destra, ±π = alle spalle. Il punto può stare a qualunque raggio.
 */
export function relativeBearing(f, x, y, z) {
  return Math.atan2(x * f.rx + y * f.ry + z * f.rz, x * f.dx + y * f.dy + z * f.dz);
}

/** Angolo al centro del pianeta tra la posizione locale e il punto (x, y, z). */
export function angleFrom(f, x, y, z) {
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  const c = (x * f.px + y * f.py + z * f.pz) / len;
  return Math.acos(c > 1 ? 1 : (c < -1 ? -1 : c));
}

/**
 * True se il segmento dalla camera `c` al punto `p` passa dentro la sfera di
 * raggio `radius` centrata nel pianeta: il punto è nascosto dal pianeta.
 */
export function segmentHitsSphere(c, px, py, pz, radius) {
  const dx = px - c.x, dy = py - c.y, dz = pz - c.z;
  const dd = dx * dx + dy * dy + dz * dz;
  let t = dd > 1e-9 ? -(c.x * dx + c.y * dy + c.z * dz) / dd : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const x = c.x + dx * t, y = c.y + dy * t, z = c.z + dz * t;
  return x * x + y * y + z * z < radius * radius;
}

/** Direzione "avanti" di un Object3D (asse +X locale) dal suo quaternione. */
export function forwardFromQuaternion(q, out) {
  const { x, y, z, w } = q;
  out.x = 1 - 2 * (y * y + z * z);
  out.y = 2 * (x * y + w * z);
  out.z = 2 * (x * z - w * y);
  return out;
}
