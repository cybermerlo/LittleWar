import * as THREE from 'three';
import { worldUniforms, CLOUD_SLOTS, CLOUD_SHADOWS } from './worldShaders.js';

/**
 * Ombre delle nuvole che scorrono su terra e mare.
 *
 * Le nuvole stanno a quota 65–70, sopra la camera (~60): il giocatore le vede
 * quasi solo all'orizzonte, ma guarda sempre il terreno. Le loro ombre sono
 * ciò che gli fa percepire il cielo e il vento anche quando le nuvole sono
 * fuori dall'inquadratura.
 *
 * Qui si sceglie a ogni frame quali nuvole contano (le `CLOUD_SLOTS` più
 * vicine alla camera) e se ne scrive la forma nelle uniform: il calcolo vero
 * è per vertice (worldShaders.js), niente texture né draw call. Le facce del
 * pianeta sono larghe ~1.4 unità e le ombre 4–20: interpolate per vertice
 * hanno un bordo morbido e appena sfaccettato, coerente con lo stile.
 *
 * L'ombra non è proiettata lungo il sole: a ~50° dalla verticale cadrebbe a
 * ~19 unità dalla nuvola e non si capirebbe più di chi è. Resta quasi sotto,
 * spostata di poco verso l'anti-sole: compromesso da cartone animato.
 */

/** Quanta luce diretta toglie un'ombra piena. */
const SHADOW_STRENGTH = 0.6;
/** Spostamento dell'ombra verso l'anti-sole (rad, ~3 unità al suolo). */
const SUN_OFFSET = 0.06;
/** Opacità delle nuvole a pieno giorno (Sky.js): le ombre sfumano con loro. */
const CLOUD_FULL_OPACITY = 0.94;

const _cam = new THREE.Vector3();
const _sunH = new THREE.Vector3();

export class CloudShadows {
  /**
   * @param {THREE.Object3D} cloudRoot  `sky.cloudRoot`; le ancore sono in
   *        `cloudRoot.userData.cloudAnchors` ({dir, axis, halfLen, halfWid}, angoli in rad)
   */
  constructor(cloudRoot) {
    this.root = cloudRoot ?? null;
    this.anchors = cloudRoot?.userData?.cloudAnchors ?? [];
    this.enabled = CLOUD_SHADOWS && this.anchors.length > 0;
    /** Solo per la sonda F9: spegne le ombre senza ricompilare nulla. */
    this.paused = false;
    const n = this.anchors.length;
    this._c = Array.from({ length: n }, () => new THREE.Vector3());
    this._a = Array.from({ length: n }, () => new THREE.Vector3());
    this._score = new Float32Array(n);
    this._order = new Int32Array(n);
    worldUniforms.uCloudK.value = 0;
  }

  /**
   * @param {THREE.Vector3} camPos
   * @param {THREE.Vector3} sunDir  direzione verso il sole (unitaria)
   */
  update(camPos, sunDir) {
    const U = worldUniforms;
    const root = this.root;
    const cloudMat = root?.children[0]?.material;
    if (!this.enabled || this.paused || !root.visible || !cloudMat) {
      U.uCloudK.value = 0;
      return;
    }
    U.uCloudK.value = SHADOW_STRENGTH * THREE.MathUtils.clamp(cloudMat.opacity / CLOUD_FULL_OPACITY, 0, 1);
    if (U.uCloudK.value <= 0.001) return;

    // La nuvola gira con il suo gruppo: le ancore sono nel suo frame locale.
    const q = root.quaternion;
    _cam.copy(camPos).normalize();
    const n = this.anchors.length;
    for (let i = 0; i < n; i++) {
      const anchor = this.anchors[i];
      this._c[i].copy(anchor.dir).applyQuaternion(q);
      this._a[i].copy(anchor.axis).applyQuaternion(q);
      this._score[i] = this._c[i].dot(_cam);
      this._order[i] = i;
    }
    // Selezione parziale delle più vicine: poche nuvole, niente sort né allocazioni.
    const slots = Math.min(CLOUD_SLOTS, n);
    for (let s = 0; s < slots; s++) {
      let best = s;
      for (let j = s + 1; j < n; j++) {
        if (this._score[this._order[j]] > this._score[this._order[best]]) best = j;
      }
      const t = this._order[s]; this._order[s] = this._order[best]; this._order[best] = t;
    }

    for (let s = 0; s < CLOUD_SLOTS; s++) {
      const A = U.uCloudA.value[s];
      const B = U.uCloudB.value[s];
      if (s >= slots) { A.set(0, 0, 0, 1); B.set(1, 0, 0, 1); continue; }
      const i = this._order[s];
      const anchor = this.anchors[i];
      const c = this._c[i];
      const a = this._a[i];
      _sunH.copy(sunDir).addScaledVector(c, -sunDir.dot(c));
      const h = _sunH.length();
      if (h > 1e-4) c.addScaledVector(_sunH, -SUN_OFFSET / h).normalize();
      // Dopo lo spostamento l'asse va riportato tangente al nuovo centro.
      a.addScaledVector(c, -a.dot(c)).normalize();
      A.set(c.x, c.y, c.z, 1 / anchor.halfLen);
      B.set(a.x, a.y, a.z, 1 / anchor.halfWid);
    }
  }
}
