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
import { Projectile } from './Projectile.js';

const TICK_DT = TICK_INTERVAL / 1000;

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

    const proj = new Projectile(
      `turret-${this.id}`,  // ownerId speciale per le torrette
      this.theta,
      this.phi,
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

/** Genera N edifici in posizioni casuali ben distribuite sulla sfera */
export function generateBuildings(count) {
  const buildings = new Map();
  for (let i = 0; i < count; i++) {
    // Distribuzione uniforme sulla sfera
    const theta = Math.acos(2 * Math.random() - 1);
    const phi = Math.random() * Math.PI * 2;
    const b = new Building(theta, phi);
    buildings.set(b.id, b);
  }
  return buildings;
}
