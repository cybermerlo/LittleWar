import {
  PLANET_RADIUS,
  FLY_ALTITUDE,
  BUILDING_CONQUEST_RADIUS,
  BUILDING_CONQUEST_TIME,
  TURRET_RANGE,
  TURRET_FIRE_RATE,
  TURRET_BULLET_SPEED,
  TURRET_BULLET_LIFETIME,
  TICK_INTERVAL,
} from '../shared/constants.js';
import { moveOnSphere } from '../shared/movement.js';
import { Projectile } from './Projectile.js';

const TICK_DT = TICK_INTERVAL / 1000;

/**
 * Offset angolare del punto di spawn del proiettile rispetto alla base della
 * torretta, lungo la direzione di tiro. Estremità cannone in scene frame:
 * (0.0479, 13.5079, 11.4608); pivot Turret_Pivot (0.185, 9.326, -0.218) → locale
 * (-0.1371, 4.1819, 11.6788). Proiezione orizzontale √(x²+z²) ≈ 11.6779
 * unità modello → × CESARE_SCALE (0.24) / FLY_ALTITUDE.
 */
const TURRET_MUZZLE_OFFSET = (11.6779 * 0.24) / FLY_ALTITUDE;

let nextBuildingId = 1;

export class Building {
  constructor(theta, phi) {
    this.id = String(nextBuildingId++);
    this.theta = theta;
    this.phi = phi;

    // Stato conquista
    this.ownerId = null;       // null = neutrale
    this.ownerColor = null;
    this.conquestProgress = 0; // 0..1
    this.conqueringPlayerId = null;

    // Stato torretta
    this.turretTargetId = null;
    this.turretCooldown = 0;   // secondi rimanenti prima del prossimo sparo
  }

  /** Resetta l'edificio a stato neutrale (bombardamento) */
  reset() {
    this.ownerId = null;
    this.ownerColor = null;
    this.conquestProgress = 0;
    this.conqueringPlayerId = null;
    this.turretTargetId = null;
    this.turretCooldown = 0;
  }

  /** Posizione cartesiana sulla superficie del pianeta */
  cartesian(r = PLANET_RADIUS) {
    return {
      x: r * Math.sin(this.theta) * Math.cos(this.phi),
      y: r * Math.cos(this.theta),
      z: r * Math.sin(this.theta) * Math.sin(this.phi),
    };
  }

  /** Distanza cartesiana da un punto sferico (theta, phi) al raggio dato */
  distanceTo(theta, phi, r) {
    const a = this.cartesian(PLANET_RADIUS);
    const x2 = r * Math.sin(theta) * Math.cos(phi);
    const y2 = r * Math.cos(theta);
    const z2 = r * Math.sin(theta) * Math.sin(phi);
    return Math.sqrt((a.x - x2) ** 2 + (a.y - y2) ** 2 + (a.z - z2) ** 2);
  }

  /**
   * Aggiorna la logica di conquista.
   * @param {Map} players - tutti i giocatori
   * @returns {void}
   */
  updateConquest(players) {
    // Trova chi è nella zona di conquista (vivi, non proprietario)
    const playersInZone = [];
    for (const player of players.values()) {
      if (!player.alive) continue;
      if (player.id === this.ownerId) continue;
      const dist = this.distanceTo(player.theta, player.phi, FLY_ALTITUDE);
      if (dist < BUILDING_CONQUEST_RADIUS) {
        playersInZone.push(player);
      }
    }

    // Se edificio già conquistato, la conquista non avanza (deve prima essere bombardato)
    if (this.ownerId) return;

    // Nessuno in zona → il progresso decade lentamente
    if (playersInZone.length === 0) {
      this.conquestProgress = Math.max(0, this.conquestProgress - TICK_DT / BUILDING_CONQUEST_TIME);
      if (this.conquestProgress <= 0) this.conqueringPlayerId = null;
      return;
    }

    // Più di un giocatore in zona → timer si resetta
    if (playersInZone.length > 1) {
      this.conquestProgress = 0;
      this.conqueringPlayerId = null;
      return;
    }

    // Esattamente un giocatore in zona
    const player = playersInZone[0];

    // Se è un nuovo giocatore che prende il posto → resetta
    if (this.conqueringPlayerId && this.conqueringPlayerId !== player.id) {
      this.conquestProgress = 0;
    }

    this.conqueringPlayerId = player.id;
    this.conquestProgress += TICK_DT / BUILDING_CONQUEST_TIME;

    // Conquista completata!
    if (this.conquestProgress >= 1) {
      this.conquestProgress = 1;
      this.ownerId = player.id;
      this.ownerColor = player.color;
      this.conqueringPlayerId = null;
      this.turretCooldown = TURRET_FIRE_RATE; // breve delay prima del primo sparo
    }
  }

  /**
   * Logica torretta: cerca il nemico più vicino e spara.
   * @param {Map} players
   * @returns {Projectile|null} proiettile generato o null
   */
  updateTurret(players) {
    if (!this.ownerId) return null;

    this.turretCooldown -= TICK_DT;

    // Trova il nemico vivo più vicino nel raggio
    let nearest = null;
    let nearestDist = Infinity;
    for (const player of players.values()) {
      if (!player.alive) continue;
      if (player.id === this.ownerId) continue;
      const dist = this.distanceTo(player.theta, player.phi, FLY_ALTITUDE);
      if (dist < TURRET_RANGE && dist < nearestDist) {
        nearest = player;
        nearestDist = dist;
      }
    }

    this.turretTargetId = nearest ? nearest.id : null;

    if (!nearest || this.turretCooldown > 0) return null;

    // Spara! Calcola heading verso il bersaglio
    const heading = this._headingTo(nearest.theta, nearest.phi);
    this.turretCooldown = TURRET_FIRE_RATE;

    // Spawn offset: spostiamo il punto di spawn in avanti (lungo heading) di
    // una distanza pari alla lunghezza visibile del cannone, così il proiettile
    // appare dall'estremità del cannone invece che dal centro della torretta.
    const spawn = moveOnSphere(this.theta, this.phi, heading, TURRET_MUZZLE_OFFSET);

    const proj = new Projectile(
      `turret-${this.id}`,  // ownerId speciale per le torrette
      spawn.theta,
      spawn.phi,
      heading,
      TURRET_BULLET_SPEED,
      TURRET_BULLET_LIFETIME,
    );
    // Aggiungiamo il buildingOwnerId per identificare chi possiede la torre
    proj.buildingOwnerId = this.ownerId;
    return proj;
  }

  /** Calcola l'heading (direzione di volo) dal building verso un punto sferico */
  _headingTo(targetTheta, targetPhi) {
    const r = PLANET_RADIUS;
    // Posizione building
    const bx = r * Math.sin(this.theta) * Math.cos(this.phi);
    const by = r * Math.cos(this.theta);
    const bz = r * Math.sin(this.theta) * Math.sin(this.phi);
    // Posizione target (sulla superficie)
    const tx = r * Math.sin(targetTheta) * Math.cos(targetPhi);
    const ty = r * Math.cos(targetTheta);
    const tz = r * Math.sin(targetTheta) * Math.sin(targetPhi);

    // Vettore direzione
    let dx = tx - bx;
    let dy = ty - by;
    let dz = tz - bz;

    // Normale alla sfera nel punto building
    const nx = bx / r, ny = by / r, nz = bz / r;

    // Proietta la direzione sul piano tangente
    const dot = dx * nx + dy * ny + dz * nz;
    dx -= dot * nx;
    dy -= dot * ny;
    dz -= dot * nz;

    // Vettori base tangenti (est e nord locali)
    const ex = -Math.sin(this.phi);
    const ey = 0;
    const ez = Math.cos(this.phi);

    const fx = ny * ez - nz * ey;
    const fy = nz * ex - nx * ez;
    const fz = nx * ey - ny * ex;

    // Componenti nel frame locale
    const eastComp = dx * ex + dy * ey + dz * ez;
    const northComp = dx * fx + dy * fy + dz * fz;

    return Math.atan2(eastComp, northComp);
  }

  toState() {
    return {
      id: this.id,
      theta: this.theta,
      phi: this.phi,
      ownerId: this.ownerId,
      ownerColor: this.ownerColor,
      conquestProgress: this.conquestProgress,
      conqueringPlayerId: this.conqueringPlayerId,
      turretTargetId: this.turretTargetId,
    };
  }
}

/** Distanza cartesiana tra due punti sulla sfera a raggio PLANET_RADIUS. */
function buildingDist(t1, p1, t2, p2) {
  const ax = PLANET_RADIUS * Math.sin(t1) * Math.cos(p1);
  const ay = PLANET_RADIUS * Math.cos(t1);
  const az = PLANET_RADIUS * Math.sin(t1) * Math.sin(p1);
  const bx = PLANET_RADIUS * Math.sin(t2) * Math.cos(p2);
  const by = PLANET_RADIUS * Math.cos(t2);
  const bz = PLANET_RADIUS * Math.sin(t2) * Math.sin(p2);
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2);
}

/** Genera N edifici garantendo che i cerchi di conquista non si intersechino. */
export function generateBuildings(count) {
  const buildings = new Map();
  const MIN_DIST = BUILDING_CONQUEST_RADIUS * 2; // cerchi tangenti = distanza minima
  const placed = [];

  for (let i = 0; i < count; i++) {
    let theta, phi, attempts = 0;
    do {
      theta = Math.acos(2 * Math.random() - 1);
      phi = Math.random() * Math.PI * 2;
      attempts++;
    } while (attempts < 500 && placed.some(p => buildingDist(theta, phi, p.theta, p.phi) < MIN_DIST));

    placed.push({ theta, phi });
    const b = new Building(theta, phi);
    buildings.set(b.id, b);
  }
  return buildings;
}
