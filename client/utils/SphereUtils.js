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
  // Posizione cartesiana corrente
  const p = {
    x: Math.sin(theta) * Math.cos(phi),
    y: Math.cos(theta),
    z: Math.sin(theta) * Math.sin(phi),
  };

  // Tangente "nord" locale (derivata rispetto a theta)
  const north = {
    x: Math.cos(theta) * Math.cos(phi),
    y: -Math.sin(theta),
    z: Math.cos(theta) * Math.sin(phi),
  };

  // Tangente "est" locale (derivata rispetto a phi, normalizzata)
  const east = {
    x: -Math.sin(phi),
    y: 0,
    z: Math.cos(phi),
  };

  // Direzione di movimento nel piano tangente
  const dir = {
    x: Math.cos(heading) * north.x + Math.sin(heading) * east.x,
    y: Math.cos(heading) * north.y + Math.sin(heading) * east.y,
    z: Math.cos(heading) * north.z + Math.sin(heading) * east.z,
  };

  // Nuovo punto (proiettato poi sulla sfera)
  let qx = p.x + dir.x * delta;
  let qy = p.y + dir.y * delta;
  let qz = p.z + dir.z * delta;

  const len = Math.sqrt(qx * qx + qy * qy + qz * qz);
  qx /= len; qy /= len; qz /= len;

  const moved = cartesianToSpherical(qx, qy, qz);

  // Trasporta il vettore forward nel nuovo piano tangente così l'heading resta
  // continuo anche quando la traiettoria passa sopra un polo.
  const dotUp = dir.x * qx + dir.y * qy + dir.z * qz;
  let fx = dir.x - qx * dotUp;
  let fy = dir.y - qy * dotUp;
  let fz = dir.z - qz * dotUp;
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz);
  fx /= fLen; fy /= fLen; fz /= fLen;

  const nextNorth = {
    x: Math.cos(moved.theta) * Math.cos(moved.phi),
    y: -Math.sin(moved.theta),
    z: Math.cos(moved.theta) * Math.sin(moved.phi),
  };
  const nextEast = {
    x: -Math.sin(moved.phi),
    y: 0,
    z: Math.cos(moved.phi),
  };

  moved.heading = Math.atan2(
    fx * nextEast.x + fy * nextEast.y + fz * nextEast.z,
    fx * nextNorth.x + fy * nextNorth.y + fz * nextNorth.z,
  );

  return moved;
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
