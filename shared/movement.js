/**
 * Funzioni di movimento su sfera — pure math, senza dipendenza da Three.js.
 * Usate sia dal client sia dal server.
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
  const p = {
    x: Math.sin(theta) * Math.cos(phi),
    y: Math.cos(theta),
    z: Math.sin(theta) * Math.sin(phi),
  };

  const north = {
    x: Math.cos(theta) * Math.cos(phi),
    y: -Math.sin(theta),
    z: Math.cos(theta) * Math.sin(phi),
  };

  const east = {
    x: -Math.sin(phi),
    y: 0,
    z: Math.cos(phi),
  };

  const dir = {
    x: Math.cos(heading) * north.x + Math.sin(heading) * east.x,
    y: Math.cos(heading) * north.y + Math.sin(heading) * east.y,
    z: Math.cos(heading) * north.z + Math.sin(heading) * east.z,
  };

  let qx = p.x + dir.x * delta;
  let qy = p.y + dir.y * delta;
  let qz = p.z + dir.z * delta;

  const len = Math.sqrt(qx * qx + qy * qy + qz * qz);
  qx /= len; qy /= len; qz /= len;

  const moved = cartesianToSpherical(qx, qy, qz);

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
