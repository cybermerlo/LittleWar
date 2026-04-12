/**
 * Utilità per coordinate sferiche e movimento su sfera.
 * Le funzioni pure (moveOnSphere, sphericalToCartesian, cartesianToSpherical)
 * vivono in shared/movement.js e vengono re-esportate qui per comodità client.
 */

export {
  sphericalToCartesian,
  cartesianToSpherical,
  moveOnSphere,
} from '../../shared/movement.js';

/**
 * Distanza cartesiana tra due punti sulla sfera di raggio r.
 */
export function sphereDistance(theta1, phi1, theta2, phi2, r = 1) {
  const p1 = sphericalToCartesian(theta1, phi1, r);
  const p2 = sphericalToCartesian(theta2, phi2, r);
  return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2 + (p1.z - p2.z) ** 2);
}

/**
 * Calcola la matrice di orientamento di un oggetto sulla sfera.
 * "up" = radiale verso fuori, "forward" = direzione heading.
 * Ritorna un THREE.Quaternion.
 */
export function sphereOrientation(THREE, theta, phi, heading) {
  // up = direzione radiale (verso l'esterno della sfera)
  const up = new THREE.Vector3(
    Math.sin(theta) * Math.cos(phi),
    Math.cos(theta),
    Math.sin(theta) * Math.sin(phi),
  ).normalize();

  // Nord locale (tangente verso il polo positivo Y)
  const northV = new THREE.Vector3(
    Math.cos(theta) * Math.cos(phi),
    -Math.sin(theta),
    Math.cos(theta) * Math.sin(phi),
  ).normalize();

  // Est locale — degenera ai poli, gestione esplicita
  let eastV = new THREE.Vector3(-Math.sin(phi), 0, Math.cos(phi));
  if (eastV.lengthSq() < 1e-6) {
    eastV.set(1, 0, 0);
    eastV.addScaledVector(up, -eastV.dot(up)).normalize();
  } else {
    eastV.normalize();
  }

  // Forward = direzione di volo nel piano tangente (heading 0 = nord)
  const forward = new THREE.Vector3()
    .addScaledVector(northV, Math.cos(heading))
    .addScaledVector(eastV, Math.sin(heading))
    .normalize();

  // sideW = ala destra (forward × up, terza colonna della matrice)
  const sideW = new THREE.Vector3().crossVectors(forward, up).normalize();

  // makeBasis(X, Y, Z):
  //   col 0 → local +X (naso aereo) = forward  ✓
  //   col 1 → local +Y (su aereo)   = up        ✓
  //   col 2 → local +Z (ala)        = sideW     ✓
  const m = new THREE.Matrix4().makeBasis(forward, up, sideW);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
