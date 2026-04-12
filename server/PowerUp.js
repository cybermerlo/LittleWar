import { FLY_ALTITUDE } from '../shared/constants.js';

let nextPowerUpId = 1;
const POWERUP_RUN_ID = Math.random().toString(36).slice(2, 8);

export class PowerUp {
  constructor(type, theta, phi) {
    // ID stabile e univoco anche dopo restart server (evita collisioni client-side).
    this.id = `${POWERUP_RUN_ID}-${nextPowerUpId++}`;
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
