import * as THREE from 'three';
import { lifeUniforms } from './lifeShared.js';
import { Boats } from './Boats.js';
import { Birds } from './Birds.js';
import { ChimneySmoke } from './ChimneySmoke.js';
import { Lighthouses } from './Lighthouses.js';
import { Aurora } from './Aurora.js';
import { Paths } from './Paths.js';

/**
 * Vita del mondo: barche, stormi, fumo dei comignoli, fari, sentieri con
 * lampioni e aurora.
 *
 * Due momenti di costruzione, entrambi PRIMA della pre-compilazione degli
 * shader (`warmupShaders` in main.js aspetta `worldReady`):
 *  - `constructor`: ciò che dipende solo dal pianeta (barche, aurora);
 *  - `onWorldReady`: ciò che ha bisogno di paesi ed edifici del terreno.
 *
 * Nessuna luce vera: lanterne, fari, lampioni e aurora sono emissione e
 * geometria additiva. Qualità bassa: niente scie, lanterne, fumo né aurora;
 * 6 barche invece di 12, 2 stormi invece di 6; fari con fasci più corti;
 * sentieri e lampioni uguali (costano 1–2 draw call e in bassa ci sono solo 4
 * paesi, quindi pochi o nessun sentiero).
 *
 * CPU per frame: ~20 µs per le matrici delle barche, il resto sono uniform.
 */
export class WorldLife {
  /**
   * @param {THREE.Scene} scene
   * @param {{lowQuality?: boolean}} [options]
   */
  constructor(scene, { lowQuality = false } = {}) {
    this.scene = scene;
    this.lowQuality = lowQuality;
    this.time = 0;
    this.boats = new Boats(scene, { lowQuality });
    this.aurora = lowQuality ? null : new Aurora(scene);
    this.birds = null;
    this.smoke = null;
    this.lighthouses = null;
    this.paths = null;
    this._tmp = new THREE.Color();
  }

  /**
   * @param {THREE.Group} terrainGroup  con userData.towns / userData.buildings
   * @param {{houseTemplate?: THREE.Object3D}} [extra]
   */
  onWorldReady(terrainGroup, { houseTemplate = null } = {}) {
    const towns = terrainGroup?.userData?.towns ?? [];
    const buildings = terrainGroup?.userData?.buildings ?? [];
    const t0 = performance.now();
    this.birds = new Birds(this.scene, { towns, lowQuality: this.lowQuality });
    this.lighthouses = new Lighthouses(this.scene, { towns, terrainGroup, lowQuality: this.lowQuality });
    this.paths = new Paths(this.scene, { towns, buildings, terrainGroup });
    if (!this.lowQuality) this.smoke = new ChimneySmoke(this.scene, { buildings, houseTemplate });
    if (import.meta.env?.DEV) {
      console.log('[life]', JSON.stringify({
        boats: this.boats.boats.length,
        birds: this.birds.count,
        lighthouses: this.lighthouses.sites.length,
        smoke: this.smoke?.count ?? 0,
        paths: this.paths.stats,
        ms: Math.round(performance.now() - t0),
      }));
    }
  }

  /**
   * @param {number} delta
   * @param {number} nightFactor  sky.getNightFactor()
   * @param {{sun:THREE.DirectionalLight, ambient:THREE.AmbientLight, fill?:THREE.DirectionalLight}} lights
   */
  update(delta, nightFactor, lights) {
    this.time += delta;
    const u = lifeUniforms;
    u.uTime.value = this.time;
    // Stessa luce che Planet.js passa all'acqua: sole, ambiente e metà del fill.
    if (lights?.sun) {
      u.uSunDir.value.copy(lights.sun.position).normalize();
      u.uSunColor.value.copy(lights.sun.color).multiplyScalar(lights.sun.intensity);
    }
    if (lights?.ambient) {
      u.uAmbient.value.copy(lights.ambient.color).multiplyScalar(lights.ambient.intensity);
      if (lights.fill) u.uAmbient.value.add(this._tmp.copy(lights.fill.color).multiplyScalar(lights.fill.intensity * 0.5));
    }

    this.boats.update(delta, this.time, nightFactor);
    this.birds?.update(nightFactor);
    this.lighthouses?.update(nightFactor);
    this.paths?.update(nightFactor);
    this.aurora?.update(nightFactor);
  }

  /** Scenari per la sonda F9: uno per effetto, spento e riacceso. */
  probeScenarios() {
    const item = (label, get) => ({
      label,
      off: () => get()?.setEnabled(false),
      on: () => get()?.setEnabled(true),
    });
    const list = [
      item('barche', () => this.boats),
      item('uccelli', () => this.birds),
      item('fari', () => this.lighthouses),
      item('sentieri e lampioni', () => this.paths),
    ];
    if (!this.lowQuality) {
      list.push(item('fumo comignoli', () => this.smoke));
      list.push(item('aurora', () => this.aurora));
    }
    return list;
  }
}
