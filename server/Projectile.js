import {
  BULLET_SPEED,
  BULLET_LIFETIME,
  BULLET_HIT_RADIUS,
  PLANET_RADIUS,
  FLY_ALTITUDE,
  TICK_INTERVAL,
} from '../shared/constants.js';

const TICK_DT = TICK_INTERVAL / 1000; // secondi per tick

let nextProjectileId = 1;

// Muove un punto su una sfera di raggio r lungo la direzione tangenziale
// dati theta/phi correnti, heading, e delta radianti
function moveOnSphere(theta, phi, heading, delta) {
  // Converti in cartesiane
  const r = FLY_ALTITUDE;
  const x = r * Math.sin(theta) * Math.cos(phi);
  const y = r * Math.cos(theta);
  const z = r * Math.sin(theta) * Math.sin(phi);

  // Normale alla sfera nel punto
  const nx = x / r, ny = y / r, nz = z / r;

  // Vettore "est" locale (tangente in direzione phi crescente)
  const ex = -Math.sin(phi);
  const ey = 0;
  const ez = Math.cos(phi);

  // Vettore "nord" locale = normale × est
  const fx = ny * ez - nz * ey;
  const fy = nz * ex - nx * ez;
  const fz = nx * ey - ny * ex;

  // Direzione di movimento
  const dx = Math.cos(heading) * fx + Math.sin(heading) * ex;
  const dy = Math.cos(heading) * fy + Math.sin(heading) * ey;
  const dz = Math.cos(heading) * fz + Math.sin(heading) * ez;

  // Nuovo punto cartesiano
  let nx2 = x + dx * delta * r;
  let ny2 = y + dy * delta * r;
  let nz2 = z + dz * delta * r;

  // Riporta sul guscio sferico
  const len = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2);
  nx2 = nx2 / len * r;
  ny2 = ny2 / len * r;
  nz2 = nz2 / len * r;

  // Riconverti in sferiche
  const newTheta = Math.acos(Math.max(-1, Math.min(1, ny2 / r)));
  const newPhi = Math.atan2(nz2, nx2);

  return { theta: newTheta, phi: newPhi };
}

export class Projectile {
  constructor(ownerId, theta, phi, heading) {
    this.id = String(nextProjectileId++);
    this.ownerId = ownerId;
    this.theta = theta;
    this.phi = phi;
    this.heading = heading;
    this.createdAt = Date.now();
  }

  update() {
    const pos = moveOnSphere(this.theta, this.phi, this.heading, BULLET_SPEED * TICK_DT);
    this.theta = pos.theta;
    this.phi = pos.phi;
  }

  isExpired() {
    return Date.now() - this.createdAt > BULLET_LIFETIME;
  }

  // Distanza cartesiana da un giocatore (theta2, phi2)
  distanceTo(theta2, phi2) {
    const r = FLY_ALTITUDE;
    const x1 = r * Math.sin(this.theta) * Math.cos(this.phi);
    const y1 = r * Math.cos(this.theta);
    const z1 = r * Math.sin(this.theta) * Math.sin(this.phi);
    const x2 = r * Math.sin(theta2) * Math.cos(phi2);
    const y2 = r * Math.cos(theta2);
    const z2 = r * Math.sin(theta2) * Math.sin(phi2);
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2 + (z1 - z2) ** 2);
  }

  toState() {
    return {
      id: this.id,
      ownerId: this.ownerId,
      theta: this.theta,
      phi: this.phi,
    };
  }
}
