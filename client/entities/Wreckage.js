import * as THREE from 'three';
import { groundRadius, SEA_SURFACE_RADIUS } from '../scene/planetSurface.js';

/**
 * Rottami di un aereo abbattuto, nel colore della vittima.
 *
 * L'esplosione da sola (Bomb.js, condivisa con bombe e impatti) non dice CHI è
 * caduto: pochi pezzi di carrozzeria del suo colore che schizzano via e
 * ricadono sul pianeta sì. Tutti i rottami di tutte le esplosioni sono istanze
 * di una sola mesh, create all'avvio: una draw call, e solo mentre qualcosa
 * sta cadendo.
 *
 * I pezzi cadono verso il centro del pianeta e si fermano sul terreno
 * visibile (`groundRadius`, da planetSurface.js: la mesh vera, non il campo
 * analitico), dove restano un attimo prima di sparire. Sul mare affondano.
 */

const SLOTS = 4;
const LIFE = 2.3;          // s
const GRAVITY = 14;        // unità/s² verso il centro
const DRAG = 0.7;          // 1/s

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3();
const _col = new THREE.Color();
const _dark = new THREE.Color(0.09, 0.09, 0.1);

function makePieceGeometry() {
  // Tetraedro schiacciato: una scheggia di lamiera, sfaccettata come il resto.
  const g = new THREE.TetrahedronGeometry(0.34, 0);
  g.scale(1.25, 0.4, 1);
  g.computeVertexNormals();
  return g;
}

class Wreckage {
  constructor() {
    this.mesh = null;
  }

  init(scene, { lowQuality = false } = {}) {
    if (this.mesh) return;
    this.pieces = lowQuality ? 4 : 8;
    const cap = SLOTS * this.pieces;
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.mesh = new THREE.InstancedMesh(makePieceGeometry(), this.material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // instanceColor presente fin dall'inizio: lo shader si compila una volta sola.
    this.mesh.setColorAt(0, _col.set(1, 1, 1));
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this._slots = Array.from({ length: SLOTS }, () => ({
      t: LIFE,
      floor: SEA_SURFACE_RADIUS,
      sea: false,
      pos: Array.from({ length: this.pieces }, () => new THREE.Vector3()),
      vel: Array.from({ length: this.pieces }, () => new THREE.Vector3()),
      axis: Array.from({ length: this.pieces }, () => new THREE.Vector3()),
      spin: new Float32Array(this.pieces),
      angle: new Float32Array(this.pieces),
      size: new Float32Array(this.pieces),
      landed: new Uint8Array(this.pieces),
      color: Array.from({ length: this.pieces }, () => new THREE.Color()),
    }));
    this._next = 0;
  }

  /**
   * @param {THREE.Vector3} pos        punto dell'esplosione (world)
   * @param {string} color             colore della vittima
   * @param {THREE.Vector3} [velocity] velocità dell'aereo al momento dell'abbattimento
   */
  spawn(pos, color, velocity) {
    if (!this.mesh) return;
    const slot = this._slots[this._next++ % SLOTS];
    slot.t = 0;
    _up.copy(pos).normalize();
    const ground = groundRadius(_up);
    slot.sea = ground < SEA_SURFACE_RADIUS;
    slot.floor = Math.max(ground, SEA_SURFACE_RADIUS) + 0.06;

    _col.set(color ?? '#cccccc');
    if (!Number.isFinite(_col.r + _col.g + _col.b)) _col.set('#cccccc');
    for (let i = 0; i < this.pieces; i++) {
      // Direzione nell'emisfero verso l'esterno, più la velocità di volo.
      _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      _v.addScaledVector(_up, 0.9).normalize();
      slot.pos[i].copy(pos).addScaledVector(_v, 0.3);
      slot.vel[i].copy(_v).multiplyScalar(5 + Math.random() * 5);
      if (velocity) slot.vel[i].addScaledVector(velocity, 0.45);
      slot.axis[i].set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      slot.spin[i] = 4 + Math.random() * 9;
      slot.angle[i] = Math.random() * Math.PI * 2;
      slot.size[i] = 0.7 + Math.random() * 0.7;
      slot.landed[i] = 0;
      // Due terzi carrozzeria colorata, il resto metallo bruciato.
      if (i % 3 === 2) slot.color[i].copy(_dark);
      else slot.color[i].copy(_col).multiplyScalar(0.8 + Math.random() * 0.3);
    }
  }

  tick(delta) {
    if (!this.mesh) return;
    const dt = Math.min(Math.max(delta, 0), 0.05);
    const cols = this.mesh.instanceColor.array;
    const drag = Math.exp(-DRAG * dt);
    let n = 0;
    for (const slot of this._slots) {
      if (slot.t >= LIFE) continue;
      slot.t += dt;
      if (slot.t >= LIFE) continue;
      // Si rimpiccioliscono nell'ultimo mezzo secondo invece di sparire di colpo.
      const shrink = Math.min(1, (LIFE - slot.t) / 0.5);
      for (let i = 0; i < this.pieces; i++) {
        const p = slot.pos[i];
        if (!slot.landed[i]) {
          const v = slot.vel[i];
          const r = p.length();
          v.multiplyScalar(drag);
          v.addScaledVector(p, -GRAVITY * dt / r);
          p.addScaledVector(v, dt);
          slot.angle[i] += slot.spin[i] * dt;
          const nr = p.length();
          if (nr <= slot.floor) {
            p.multiplyScalar(slot.floor / nr);
            // Sul mare il pezzo "affonda": sparisce in fretta invece di posarsi.
            slot.landed[i] = slot.sea ? 2 : 1;
          }
        }
        let size = slot.size[i] * shrink;
        if (slot.landed[i] === 2) size *= 0.35;
        _q.setFromAxisAngle(slot.axis[i], slot.angle[i]);
        _s.setScalar(size);
        _m.compose(p, _q, _s);
        this.mesh.setMatrixAt(n, _m);
        const c = slot.color[i];
        cols[n * 3] = c.r; cols[n * 3 + 1] = c.g; cols[n * 3 + 2] = c.b;
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

/** Rottami degli aerei abbattuti. `init()` in main.js, prima della pre-compilazione. */
export const wreckage = new Wreckage();
