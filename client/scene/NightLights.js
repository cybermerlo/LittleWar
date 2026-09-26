import * as THREE from 'three';
import { worldUniforms, GLOW_SLOTS } from './worldShaders.js';

/**
 * Notte abitata: finestre che si accendono casa per casa e aloni caldi
 * attorno ai paesi, come le città viste da un aereo di notte.
 *
 * Non usa nessuna luce vera (vedi LightPool.js: il numero di luci in scena
 * non deve mai cambiare). Le finestre sono emissive nel materiale fuso delle
 * case, gli aloni sono luce calcolata per vertice sul pianeta: zero draw call.
 *
 * `nightFactor` (Sky.getNightFactor) vale 0.2 a mezzogiorno, 0.4 al tramonto,
 * 0.8 al crepuscolo, 1 a notte piena e 0.5 all'alba: le soglie vanno messe
 * sopra il tramonto, altrimenti le luci resterebbero accese di giorno.
 */

/** Raggio angolare dell'alone (rad): le case di un paese stanno entro ~0.13. */
const GLOW_RADIUS = 0.17;
/** Luce calda che cade sul terreno attorno ai paesi (lineare). */
const GLOW_COLOR = new THREE.Color(1.0, 0.5, 0.16);
const GLOW_INTENSITY = 0.7;

export class NightLights {
  constructor() {
    /** Peso di ogni slot: i paesi più grandi fanno più luce. */
    this._weight = new Float32Array(GLOW_SLOTS);
    this._lastGlow = -1;
    /** Solo per la sonda F9: spegne finestre e aloni senza ricompilare nulla. */
    this.paused = false;
  }

  /**
   * Riempie gli slot degli aloni con i paesi del terreno appena creato.
   * @param {THREE.Object3D} terrainGroup  con `userData.towns` e `userData.buildings`
   */
  setTerrain(terrainGroup) {
    const towns = terrainGroup?.userData?.towns ?? [];
    const buildings = terrainGroup?.userData?.buildings ?? [];
    const cosR = Math.cos(GLOW_RADIUS);
    const dir = new THREE.Vector3();
    for (let i = 0; i < GLOW_SLOTS; i++) {
      const slot = worldUniforms.uGlowDir.value[i];
      const town = towns[i];
      if (!town) { slot.set(0, 0, 0, 1); this._weight[i] = 0; continue; }
      let houses = 0;
      for (const b of buildings) {
        if (dir.copy(b.position).normalize().dot(town) > cosR) houses += b.kind === 'hospital' ? 2 : 1;
      }
      slot.set(town.x, town.y, town.z, cosR);
      this._weight[i] = THREE.MathUtils.clamp(0.45 + houses * 0.08, 0.5, 1.2);
    }
    this._lastGlow = -1;
  }

  /**
   * @param {number} delta
   * @param {number} nightFactor  Sky.getNightFactor()
   */
  update(delta, nightFactor) {
    const U = worldUniforms;
    U.uWorldTime.value += delta;
    const night = this.paused ? 0 : nightFactor;
    U.uLit.value = THREE.MathUtils.smoothstep(night, 0.45, 0.9);

    const glow = THREE.MathUtils.smoothstep(night, 0.55, 0.92) * GLOW_INTENSITY;
    U.uGlowOn.value = glow > 0.001 ? 1 : 0;
    if (Math.abs(glow - this._lastGlow) < 1e-4) return;
    this._lastGlow = glow;
    for (let i = 0; i < GLOW_SLOTS; i++) {
      U.uGlowCol.value[i].copy(GLOW_COLOR).multiplyScalar(glow * this._weight[i]);
    }
  }
}
