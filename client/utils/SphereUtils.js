/**
 * Utilità per coordinate sferiche e movimento su sfera.
 * Il sistema: theta = angolo polare (0..PI), phi = azimutale (0..2PI)
 * "Nord" = polo positivo Y (theta=0).
 */

export function sphericalToCartesian(theta, phi, radius) {
  return {
    x: radius * Math.sin(theta) * Math.cos(phi),
    y: radius * Math.cos(theta),
    z: radius * Math.sin(theta) * Math.sin(phi),
  };
}

export function cartesianToSpherical(x, y, z) {
  const r = Math.sqrt(x * x + y * y + z * z);
  return {
    theta: Math.acos(Math.max(-1, Math.min(1, y / r))),
    phi: Math.atan2(z, x),
    r,
  };
}

/**
 * Sposta un punto sulla sfera lungo la direzione tangenziale (heading).
 * heading = 0 → nord locale; heading = PI/2 → est locale.
 * delta = angolo percorso in radianti.
 */
export function moveOnSphere(theta, phi, heading, delta) {
  const r = 1; // normalizziamo

  // Posizione cartesiana corrente
  const px = Math.sin(theta) * Math.cos(phi);
  const py = Math.cos(theta);
  const pz = Math.sin(theta) * Math.sin(phi);

  // Tangente "nord" locale (derivata rispetto a theta)
  const nx = Math.cos(theta) * Math.cos(phi);
  const ny = -Math.sin(theta);
  const nz = Math.cos(theta) * Math.sin(phi);

  // Tangente "est" locale (derivata rispetto a phi, normalizzata)
  const ex = -Math.sin(phi);
  const ey = 0;
  const ez = Math.cos(phi);

  // Direzione di movimento nel piano tangente
  const dx = Math.cos(heading) * nx + Math.sin(heading) * ex;
  const dy = Math.cos(heading) * ny + Math.sin(heading) * ey;
  const dz = Math.cos(heading) * nz + Math.sin(heading) * ez;

  // Nuovo punto (proiettato poi sulla sfera)
  let qx = px + dx * delta;
  let qy = py + dy * delta;
  let qz = pz + dz * delta;

  const len = Math.sqrt(qx * qx + qy * qy + qz * qz);
  qx /= len; qy /= len; qz /= len;

  return cartesianToSpherical(qx, qy, qz);
}

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
  const { x, y, z } = sphericalToCartesian(theta, phi, 1);

  const up = new THREE.Vector3(x, y, z).normalize();

  // Nord locale
  const northX = Math.cos(theta) * Math.cos(phi);
  const northY = -Math.sin(theta);
  const northZ = Math.cos(theta) * Math.sin(phi);
  const northV = new THREE.Vector3(northX, northY, northZ).normalize();

  // Est locale
  const eastV = new THREE.Vector3(-Math.sin(phi), 0, Math.cos(phi)).normalize();

  // Forward = heading nel piano tangente
  const forward = new THREE.Vector3()
    .addScaledVector(northV, Math.cos(heading))
    .addScaledVector(eastV, Math.sin(heading))
    .normalize();

  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const correctedForward = new THREE.Vector3().crossVectors(up, right).normalize();

  const m = new THREE.Matrix4().makeBasis(right, up, correctedForward.negate());
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return q;
}
