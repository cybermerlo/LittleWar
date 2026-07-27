import { PLANET_RADIUS } from '../shared/constants.js';
import { sampleBuildableSite, WATER_LEVEL } from '../shared/planetField.js';

let nextTargetId = 1;

/**
 * Bersaglio del bombardamento.
 *
 * La posizione viene estratta su terreno emerso e non ripido: prima era del
 * tutto casuale, quindi il bersaglio poteva finire in mezzo all'oceano o su
 * una parete, dove l'anello risulta illeggibile.
 */
export class Target {
  constructor() {
    this.id = String(nextTargetId++);
    const site = sampleBuildableSite({
      minHeight: WATER_LEVEL + 0.03,
      maxHeight: 0.5,
      maxSlope: 0.25,
    });
    this.theta = site.theta;
    this.phi = site.phi;
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
