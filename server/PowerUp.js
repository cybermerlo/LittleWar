import { FLY_ALTITUDE } from '../shared/constants.js';

let nextPowerUpId = 1;

export class PowerUp {
  constructor(type, theta, phi) {
    this.id = String(nextPowerUpId++);
    this.type = type; // 'weapon' | 'shield'
    this.theta = theta ?? Math.acos(2 * Math.random() - 1);
    this.phi = phi ?? Math.random() * Math.PI * 2;
    this.altitude = FLY_ALTITUDE;
    this.createdAt = Date.now();
  }

  toState() {
    return {
      id: this.id,
      type: this.type,
      theta: this.theta,
      phi: this.phi,
    };
  }
}
