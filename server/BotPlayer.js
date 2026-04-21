import { Player } from './Player.js';
import {
  FLY_ALTITUDE,
  BOT_DETECTION_RANGE,
  BOT_SHOOT_RANGE,
  BOT_WAYPOINT_THRESHOLD,
  BOT_AIM_ERROR,
  BOT_TURN_RATE,
} from '../shared/constants.js';

export class BotPlayer extends Player {
  constructor(nickname, color, sectorMin, sectorMax) {
    super(null, nickname, color, 'spitfire');
    this.isBot = true;
    this.sectorMin = sectorMin ?? 0;
    this.sectorMax = sectorMax ?? Math.PI;

    this.state = 'wander'; // 'wander' | 'chase'
    this.targetPlayerId = null;
    this.shootCooldown = 0;
    this.aimOffset = 0;
    this.aimOffsetTarget = 0;
    this.aimOffsetTimer = 0;
    this.waypoint = null;
    this.moveForward = true;

    this._pickNewWaypoint();
  }

  tickAI(game, dt) {
    // Aggiorna errore di mira ogni 0.4s (lerp verso nuovo target random)
    this.aimOffsetTimer -= dt;
    if (this.aimOffsetTimer <= 0) {
      this.aimOffsetTarget = (Math.random() * 2 - 1) * BOT_AIM_ERROR;
      this.aimOffsetTimer = 0.4;
    }
    this.aimOffset += (this.aimOffsetTarget - this.aimOffset) * 0.3;

    // Rilevamento: player umano vivo più vicino entro BOT_DETECTION_RANGE
    let closest = null;
    let closestDist = BOT_DETECTION_RANGE;
    for (const p of game.players.values()) {
      if (p.isBot || !p.alive) continue;
      const dist = game.distanceSphere(this.theta, this.phi, p.theta, p.phi, FLY_ALTITUDE);
      if (dist < closestDist) {
        closestDist = dist;
        closest = p;
      }
    }

    if (closest) {
      this.state = 'chase';
      this.targetPlayerId = closest.id;
      game.botSharedState.lastKnownTarget = {
        theta: closest.theta,
        phi: closest.phi,
        timestamp: Date.now(),
      };
    } else {
      this.state = 'wander';
    }

    if (this.state === 'chase') {
      this._doChase(game, dt, closestDist, closest);
    } else {
      this._doWander(game, dt);
    }

    this.shootCooldown = Math.max(0, this.shootCooldown - dt);
  }

  _doChase(game, dt, distance, target) {
    this._rotateToward(this._headingToPoint(target.theta, target.phi), dt);
    this.moveForward = true;

    if (distance < BOT_SHOOT_RANGE && this.shootCooldown <= 0) {
      game.createProjectile(this, this.heading + this.aimOffset);
      this.shootCooldown = 0.35;
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
