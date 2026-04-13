import { PLANET_RADIUS } from '../shared/constants.js';

let nextTargetId = 1;

export class Target {
  constructor() {
    this.id = String(nextTargetId++);
    this.theta = Math.acos(2 * Math.random() - 1);
    this.phi = Math.random() * Math.PI * 2;
    this.radius = PLANET_RADIUS;
  }

  toState() {
    return {
      id: this.id,
      theta: this.theta,
      phi: this.phi,
    };
  }
}
