import {
  BULLET_SPEED,
  BULLET_LIFETIME,
} from '../shared/constants.js';
import { makeTrajectory, trajectoryPoint } from '../shared/projectile.js';

/**
 * Proiettile lato server.
 *
 * La posizione non viene integrata tick dopo tick ma ricavata dall'età, con la
 * stessa formula del client (`shared/projectile.js`): così server e client
 * vedono lo stesso proiettile nello stesso punto senza doversi scambiare le
 * coordinate a ogni tick.
 *
 * `serverHits` distingue chi decide i colpi:
 *  - true  → proiettili di bot e torrette: nessun client li "possiede", quindi
 *            è il server a controllare gli impatti a ogni tick;
 *  - false → proiettili dei giocatori: decide il client di chi spara (vedi
 *            `Game.claimHit`), il server verifica solo che sia plausibile.
 */
export class Projectile {
  constructor({
    id,
    ownerId,
    theta,
    phi,
    heading,
    speed = BULLET_SPEED,
    lifetime = BULLET_LIFETIME,
    spawnAt = Date.now(),
    serverHits = false,
    buildingOwnerId = null,
  }) {
    this.id = id;
    this.ownerId = ownerId;
    this.theta = theta;
    this.phi = phi;
    this.heading = heading;
    this.speed = speed;
    this.lifetime = lifetime;
    this.spawnAt = spawnAt;
    this.serverHits = serverHits;
    this.buildingOwnerId = buildingOwnerId;
    this.traj = makeTrajectory(theta, phi, heading);

    // Estremi del tratto percorso nell'ultimo tick (unitari), per il test a segmento.
    this.prev = trajectoryPoint(this.traj, 0, { x: 0, y: 0, z: 0 });
    this.cur = { x: this.prev.x, y: this.prev.y, z: this.prev.z };
  }

  ageMs(now) {
    return now - this.spawnAt;
  }

  /** Punto unitario a una data età (ms); l'età viene limitata a [0, durata]. */
  pointAt(ageMs, out) {
    const a = Math.max(0, Math.min(this.lifetime, ageMs));
    return trajectoryPoint(this.traj, this.speed * a / 1000, out);
  }

  /** Avanza al tempo `now`: il tratto prev → cur è quello appena percorso. */
  advance(now) {
    const p = this.prev;
    p.x = this.cur.x; p.y = this.cur.y; p.z = this.cur.z;
    this.pointAt(this.ageMs(now), this.cur);
  }
}
