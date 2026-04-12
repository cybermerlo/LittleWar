import { FLY_ALTITUDE, BOOST_MAX } from '../shared/constants.js';

let nextId = 1;

export class Player {
  constructor(socketId, nickname, color, model) {
    this.id = String(nextId++);
    this.socketId = socketId;
    this.nickname = nickname || 'Player';
    this.color = color || '#ff4444';
    this.model = model || 'airplane';

    // Posizione sferica
    this.theta = Math.random() * Math.PI;
    this.phi = Math.random() * Math.PI * 2;
    this.heading = Math.random() * Math.PI * 2;
    this.altitude = FLY_ALTITUDE;

    // Stato gioco
    this.weaponLevel = 0;
    this.hasShield = false;
    this.shieldInvincible = false;
    this.kills = 0;
    this.bombPoints = 0;
    this.alive = true;
    this.respawnAt = null;
    this.boostEnergy = BOOST_MAX;
    this.boostPressed = false;
    this.moveForward = false;
    this.moveBackward = false;

    // Target bombardamento (assegnato dal server)
    this.targetId = null;

    // Ultimo input ricevuto
    this.lastInput = null;
    this.lastInputTime = Date.now();
  }

  toState() {
    const boosting = this.boostPressed && this.boostEnergy > 0;
    const boostEnergy = Math.round(Math.max(0, Math.min(BOOST_MAX, this.boostEnergy)));
    return {
      id: this.id,
      nickname: this.nickname,
      color: this.color,
      model: this.model,
      theta: this.theta,
      phi: this.phi,
      heading: this.heading,
      weaponLevel: this.weaponLevel,
      hasShield: this.hasShield,
      kills: this.kills,
      bombPoints: this.bombPoints,
      alive: this.alive,
      // Ottimizzazione rete: boostEnergy serve ai remoti solo durante boost attivo.
      boosting,
      boostEnergy: boosting ? boostEnergy : undefined,
    };
  }

  toPublicInfo() {
    return {
      id: this.id,
      nickname: this.nickname,
      color: this.color,
      model: this.model,
    };
  }
}
