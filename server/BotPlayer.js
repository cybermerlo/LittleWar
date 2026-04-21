import { Player } from './Player.js';
import {
  FLY_ALTITUDE,
  PLANET_RADIUS,
  BOT_DETECTION_RANGE,
  BOT_SHORT_DETECTION_RANGE,
  BOT_SHOOT_RANGE,
  BOT_WAYPOINT_THRESHOLD,
  BOT_AIM_ERROR,
  BOT_TURN_RATE,
  BOT_BOMB_SURFACE_RANGE,
  BOT_BOMB_COOLDOWN,
  BOT_CONQUER_SEARCH_RANGE,
  BUILDING_CONQUEST_RADIUS,
} from '../shared/constants.js';

export const BOT_NAMES = [
  'Asso', 'Falco', 'Viper', 'Cobra', 'Ghost',
  'Razor', 'Blaze', 'Storm', 'Raven', 'Titan',
  'Maverick', 'Shadow', 'Hunter', 'Eagle', 'Hornet',
  'Striker', 'Vector', 'Cipher', 'Atlas', 'Lynx',
  'Specter', 'Neon', 'Drift', 'Talon', 'Zephyr',
  'Surge', 'Nova', 'Banshee', 'Phoenix', 'Bolt',
];

export class BotPlayer extends Player {
  constructor(nickname, color, sectorMin, sectorMax) {
    super(null, nickname, color, 'spitfire');
    this.isBot = true;
    this.sectorMin = sectorMin ?? 0;
    this.sectorMax = sectorMax ?? Math.PI;

    this.state = 'wander'; // 'wander' | 'chase' | 'conquer' | 'bomb_turret'
    // 'aggressor': insegue sempre il player (priorità chase)
    // 'strategist': priorità edifici, insegue solo se il player è vicinissimo
    this.role = 'aggressor';
    this.targetPlayerId = null;
    this.buildingTarget = null; // { id, theta, phi }
    this.shootCooldown = 0;
    this.bombCooldown = 0;
    this.aimOffset = 0;
    this.aimOffsetTarget = 0;
    this.aimOffsetTimer = 0;
    this.waypoint = null;
    this.orbitSign = 1; // direzione orbita attorno agli edifici
    this.moveForward = true;

    this._pickNewWaypoint();
  }

  tickAI(game, dt) {
    this.shootCooldown = Math.max(0, this.shootCooldown - dt);
    this.bombCooldown = Math.max(0, this.bombCooldown - dt);

    // Aggiorna errore di mira ogni 0.4s (lerp verso nuovo target random)
    this.aimOffsetTimer -= dt;
    if (this.aimOffsetTimer <= 0) {
      this.aimOffsetTarget = (Math.random() * 2 - 1) * BOT_AIM_ERROR;
      this.aimOffsetTimer = 0.4;
    }
    this.aimOffset += (this.aimOffsetTarget - this.aimOffset) * 0.3;

    // Trova il player umano più vicino (serve per entrambi i ruoli)
    let closest = null;
    let closestDist = Infinity;
    for (const p of game.players.values()) {
      if (p.isBot || !p.alive) continue;
      const dist = game.distanceSphere(this.theta, this.phi, p.theta, p.phi, FLY_ALTITUDE);
      if (dist < closestDist) { closestDist = dist; closest = p; }
    }

    if (closest) {
      game.botSharedState.lastKnownTarget = {
        theta: closest.theta,
        phi: closest.phi,
        timestamp: Date.now(),
      };
    }

    if (this.role === 'aggressor') {
      this._selectStateAggressor(game, dt, closest, closestDist);
    } else {
      this._selectStateStrategist(game, dt, closest, closestDist);
    }
  }

  // Aggressivo: insegue sempre, usa edifici come fallback
  _selectStateAggressor(game, dt, closest, closestDist) {
    if (closest && closestDist < BOT_DETECTION_RANGE) {
      this.state = 'chase';
      this.targetPlayerId = closest.id;
      this._doChase(game, dt, closestDist, closest);
      return;
    }
    const enemy = this._findNearestEnemyBuilding(game);
    if (enemy) { this.state = 'bomb_turret'; this.buildingTarget = enemy; this._doBombTurret(game, dt); return; }
    const neutral = this._findNearestNeutralBuilding(game);
    if (neutral) { this.state = 'conquer'; this.buildingTarget = neutral; this._doConquer(game, dt); return; }
    this.state = 'wander'; this.buildingTarget = null; this._doWander(game, dt);
  }

  // Strategico: priorità edifici, insegue solo se il player è a tiro
  _selectStateStrategist(game, dt, closest, closestDist) {
    const enemy = this._findNearestEnemyBuilding(game);
    if (enemy) { this.state = 'bomb_turret'; this.buildingTarget = enemy; this._doBombTurret(game, dt); return; }
    const neutral = this._findNearestNeutralBuilding(game);
    if (neutral) { this.state = 'conquer'; this.buildingTarget = neutral; this._doConquer(game, dt); return; }
    // Nessun edificio utile: insegue se il player è abbastanza vicino
    if (closest && closestDist < BOT_SHORT_DETECTION_RANGE) {
      this.state = 'chase';
      this.targetPlayerId = closest.id;
      this._doChase(game, dt, closestDist, closest);
      return;
    }
    this.state = 'wander'; this.buildingTarget = null; this._doWander(game, dt);
  }

  _doChase(game, dt, distance, target) {
    this._rotateToward(this._headingToPoint(target.theta, target.phi), dt);
    this.moveForward = true;

    if (distance < BOT_SHOOT_RANGE && this.shootCooldown <= 0) {
      game.createProjectile(this, this.heading + this.aimOffset);
      this.shootCooldown = 0.35;
    }
  }

  _doConquer(game, dt) {
    const b = this.buildingTarget;
    if (!b) { this.state = 'wander'; return; }

    const building = game.buildings.get(b.id);
    if (!building || building.ownerId !== null) {
      // Edificio conquistato (da chiunque) → cerca altro
      this.buildingTarget = null;
      this.state = 'wander';
      return;
    }

    const dist = building.distanceTo(this.theta, this.phi, FLY_ALTITUDE);

    if (dist > BUILDING_CONQUEST_RADIUS) {
      // Fuori zona → vola verso edificio
      this._rotateToward(this._headingToPoint(b.theta, b.phi), dt);
      this.orbitSign = Math.random() < 0.5 ? 1 : -1;
    } else {
      // Dentro zona → orbita perpendicolare all'edificio
      const headingToBuilding = this._headingToPoint(b.theta, b.phi);
      this._rotateToward(headingToBuilding + (Math.PI / 2) * this.orbitSign, dt);
    }
    this.moveForward = true;
  }

  _doBombTurret(game, dt) {
    const b = this.buildingTarget;
    if (!b) { this.state = 'wander'; return; }

    const building = game.buildings.get(b.id);
    if (!building || !building.ownerId || game.getPlayerById(building.ownerId)?.isBot) {
      // Torretta distrutta o ora di un bot → cambia obiettivo
      this.buildingTarget = null;
      this.state = 'wander';
      return;
    }

    this._rotateToward(this._headingToPoint(b.theta, b.phi), dt);
    this.moveForward = true;

    // Distanza proiettata su PLANET_RADIUS: se < BOT_BOMB_SURFACE_RANGE, droppa
    const surfaceDist = game.distanceSphere(this.theta, this.phi, b.theta, b.phi, PLANET_RADIUS);
    if (surfaceDist < BOT_BOMB_SURFACE_RANGE && this.bombCooldown <= 0) {
      game.botDropBomb(this);
      this.bombCooldown = BOT_BOMB_COOLDOWN;
    }
  }

  _doWander(game, dt) {
    const lkt = game.botSharedState.lastKnownTarget;
    let destTheta, destPhi;

    if (lkt && (Date.now() - lkt.timestamp) < 5000) {
      destTheta = lkt.theta;
      destPhi = lkt.phi;
    } else {
      destTheta = this.waypoint.theta;
      destPhi = this.waypoint.phi;
    }

    this._rotateToward(this._headingToPoint(destTheta, destPhi), dt);
    this.moveForward = true;

    const dist = game.distanceSphere(this.theta, this.phi, this.waypoint.theta, this.waypoint.phi, FLY_ALTITUDE);
    if (dist < BOT_WAYPOINT_THRESHOLD) {
      this._pickNewWaypoint();
    }
  }

  _findNearestEnemyBuilding(game) {
    let nearest = null;
    let nearestDist = BOT_CONQUER_SEARCH_RANGE;
    for (const b of game.buildings.values()) {
      if (!b.ownerId) continue;
      if (game.getPlayerById(b.ownerId)?.isBot) continue; // bot-owned non è nemico
      const dist = b.distanceTo(this.theta, this.phi, FLY_ALTITUDE);
      if (dist < nearestDist) { nearestDist = dist; nearest = b; }
    }
    return nearest ? { id: nearest.id, theta: nearest.theta, phi: nearest.phi } : null;
  }

  _findNearestNeutralBuilding(game) {
    let nearest = null;
    let nearestDist = BOT_CONQUER_SEARCH_RANGE;
    for (const b of game.buildings.values()) {
      if (b.ownerId !== null) continue;
      const dist = b.distanceTo(this.theta, this.phi, FLY_ALTITUDE);
      if (dist < nearestDist) { nearestDist = dist; nearest = b; }
    }
    return nearest ? { id: nearest.id, theta: nearest.theta, phi: nearest.phi } : null;
  }

  _rotateToward(targetHeading, dt) {
    let diff = targetHeading - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = BOT_TURN_RATE * dt;
    this.heading += Math.sign(diff) * Math.min(Math.abs(diff), maxTurn);
    this.heading = ((this.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  }

  // Calcola heading locale verso un punto sulla sfera tramite vettori tangenti nord/est
  _headingToPoint(targetTheta, targetPhi) {
    const r = FLY_ALTITUDE;
    const myX = r * Math.sin(this.theta) * Math.cos(this.phi);
    const myY = r * Math.cos(this.theta);
    const myZ = r * Math.sin(this.theta) * Math.sin(this.phi);
    const tX = r * Math.sin(targetTheta) * Math.cos(targetPhi);
    const tY = r * Math.cos(targetTheta);
    const tZ = r * Math.sin(targetTheta) * Math.sin(targetPhi);

    const northX = Math.cos(this.theta) * Math.cos(this.phi);
    const northY = -Math.sin(this.theta);
    const northZ = Math.cos(this.theta) * Math.sin(this.phi);
    const eastX = -Math.sin(this.phi);
    const eastZ = Math.cos(this.phi);

    const dx = tX - myX;
    const dy = tY - myY;
    const dz = tZ - myZ;

    const northComp = dx * northX + dy * northY + dz * northZ;
    const eastComp = dx * eastX + dz * eastZ; // eastY = 0

    return Math.atan2(eastComp, northComp);
  }

  _pickNewWaypoint() {
    const theta = this.sectorMin + Math.random() * (this.sectorMax - this.sectorMin);
    const phi = Math.random() * Math.PI * 2;
    this.waypoint = { theta, phi };
  }
}
