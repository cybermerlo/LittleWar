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

// Scratch: sphereOrientation gira per ogni aereo a ogni frame; allocare qui
// sette oggetti a chiamata era spazzatura continua per il garbage collector.
let _up, _north, _east, _fwd, _side, _m;

/**
 * Calcola la matrice di orientamento di un oggetto sulla sfera.
 * "up" = radiale verso fuori, "forward" = direzione heading.
 * Scrive in `out` (se passato) o in un nuovo THREE.Quaternion.
 */
export function sphereOrientation(THREE, theta, phi, heading, out = new THREE.Quaternion()) {
  if (!_up) {
    _up = new THREE.Vector3(); _north = new THREE.Vector3(); _east = new THREE.Vector3();
    _fwd = new THREE.Vector3(); _side = new THREE.Vector3(); _m = new THREE.Matrix4();
  }
  // up = direzione radiale (verso l'esterno della sfera)
  const up = _up.set(
    Math.sin(theta) * Math.cos(phi),
    Math.cos(theta),
    Math.sin(theta) * Math.sin(phi),
  ).normalize();

  // Nord locale (tangente verso theta crescente)
  const northV = _north.set(
    Math.cos(theta) * Math.cos(phi),
    -Math.sin(theta),
    Math.cos(theta) * Math.sin(phi),
  ).normalize();

  // Est locale — degenera ai poli, gestione esplicita
  const eastV = _east.set(-Math.sin(phi), 0, Math.cos(phi));
  if (eastV.lengthSq() < 1e-6) {
    eastV.set(1, 0, 0);
    eastV.addScaledVector(up, -eastV.dot(up)).normalize();
  } else {
    eastV.normalize();
  }

  // Forward = direzione di volo nel piano tangente (heading 0 = nord)
  const forward = _fwd.set(0, 0, 0)
    .addScaledVector(northV, Math.cos(heading))
    .addScaledVector(eastV, Math.sin(heading))
    .normalize();

  // sideW = ala destra (forward × up, terza colonna della matrice)
  const sideW = _side.crossVectors(forward, up).normalize();

  // makeBasis(X, Y, Z):
  //   col 0 → local +X (naso aereo) = forward  ✓
  //   col 1 → local +Y (su aereo)   = up        ✓
  //   col 2 → local +Z (ala)        = sideW     ✓
  _m.makeBasis(forward, up, sideW);
  return out.setFromRotationMatrix(_m);
}
