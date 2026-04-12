import { PLANET_RADIUS } from '../shared/constants.js';

let nextTargetId = 1;

export class Target {
  constructor(playerId) {
    this.id = String(nextTargetId++);
    this.playerId = playerId;
    // Posizione casuale sulla superficie del pianeta
    this.theta = Math.acos(2 * Math.random() - 1);
    this.phi = Math.random() * Math.PI * 2;
    this.radius = PLANET_RADIUS;
  }

  toState() {
    return {
      id: this.id,
      playerId: this.playerId,
      theta: this.theta,
      phi: this.phi,
    };
  }
}
