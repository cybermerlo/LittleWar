import * as THREE from 'three';
import { MAX_PLAYERS } from '../../shared/constants.js';
import { GlowSpriteBatch } from './glowSprite.js';
import { shieldGeometry, makeShieldMaterial } from './airplaneLook.js';

/**
 * Effetti degli aerei, tutti in pool fissi creati all'avvio (e quindi
 * compilati dalla pre-compilazione degli shader, che include anche gli
 * oggetti invisibili):
 *
 *  - luci di navigazione di tutti gli aerei: un solo lotto di puntini;
 *  - vampate di sparo sulle ali;
 *  - anello di comparsa al respawn;
 *  - schegge dello scudo che si rompe.
 *
 * Nessuna allocazione durante il gioco: si riusa lo slot più vecchio. Gli
 * effetti agganciati a un aereo (vampata, anello, guscio dello scudo) ne
 * seguono la matrice a ogni frame, perché un aereo in boost percorre più di
 * un'unità nei 60 ms di una vampata.
 */

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _xAxis = new THREE.Vector3(1, 0, 0);
const _flatQ = new THREE.Quaternion().setFromAxisAngle(_xAxis, -Math.PI / 2);

function makeRadialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// ── Vampate di sparo ──────────────────────────────────────────────────────────

const MUZZLE_CAPACITY = 24;
const MUZZLE_LIFE = 0.065; // s

/**
 * Stella di quad lungo +X (l'asse di tiro): tre quad assiali a 60° l'uno
 * dall'altro più uno trasversale. Quello trasversale serve perché la camera
 * sta DIETRO l'aereo, cioè guarda i quad assiali quasi di taglio.
 */
function makeMuzzleGeometry() {
  const pos = [];
  const uv = [];
  const quad = (a, b, c, d, ua, ub, uc, ud) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    uv.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud);
  };
  const x0 = -0.2, x1 = 1.0, hw = 0.24;
  for (let k = 0; k < 3; k++) {
    const ang = (k * Math.PI) / 3;
    const cy = Math.cos(ang) * hw, cz = Math.sin(ang) * hw;
    quad(
      [x0, -cy, -cz], [x1, -cy, -cz], [x1, cy, cz], [x0, cy, cz],
      [0.5 + 0.5 * x0, 0], [1, 0], [1, 1], [0.5 + 0.5 * x0, 1],
    );
  }
  const t = 0.3, xc = 0.05;
  quad([xc, -t, -t], [xc, -t, t], [xc, t, t], [xc, t, -t], [0, 0], [1, 0], [1, 1], [0, 1]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

// ── Anello di comparsa ────────────────────────────────────────────────────────

const RING_SLOTS = 3;
const RING_LIFE = 0.42;

// ── Scudo che si rompe ────────────────────────────────────────────────────────

const BURST_SLOTS = 3;
const SHARDS_PER_BURST = 18;
const BURST_LIFE = 0.7;
const SHELL_LIFE = 0.3;

function makeShardGeometry() {
  // Triangolo equilatero sottile: la scheggia di una faccia della gabbia.
  const s = 0.34;
  const h = s * Math.sqrt(3) / 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    -s / 2, -h / 3, 0, s / 2, -h / 3, 0, 0, (2 * h) / 3, 0,
  ], 3));
  return geo;
}

class AircraftFx {
  constructor() {
    this.ready = false;
    /** Luci di navigazione di tutti gli aerei (lotto per frame). */
    this.nav = null;
  }

  init(scene, { lowQuality = false } = {}) {
    if (this.ready) return;
    this.ready = true;
    this.low = lowQuality;

    this.nav = new GlowSpriteBatch(scene, (MAX_PLAYERS + 4) * 3, {
      // Almeno qualche pixel: prima erano sfere di raggio 0.045, cioè 1-2 px
      // a quattordici unità, sotto la soglia del bloom e quindi invisibili.
      minPx: lowQuality ? 3.5 : 4,
      towardCam: 0.12,
      farDim: 0.35,
      core: 0.22,
    });

    // Vampate
    this._muzzleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      alphaMap: makeRadialTexture(),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this._muzzle = new THREE.InstancedMesh(makeMuzzleGeometry(), this._muzzleMat, MUZZLE_CAPACITY);
    this._muzzle.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._muzzle.setColorAt(0, _white);
    this._muzzle.frustumCulled = false;
    this._muzzle.renderOrder = 6;
    this._muzzle.count = 0;
    this._muzzle.visible = false;
    scene.add(this._muzzle);
    this._flashes = Array.from({ length: MUZZLE_CAPACITY }, () => ({
      obj: null, off: new THREE.Vector3(), t: MUZZLE_LIFE, size: 1, roll: 0, color: new THREE.Color(),
    }));
    this._nextFlash = 0;

    // Anelli di comparsa
    const ringGeo = new THREE.RingGeometry(0.94, 1, 48, 1);
    this._rings = Array.from({ length: RING_SLOTS }, () => {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      return { mesh, mat, plane: null, t: RING_LIFE };
    });
    this._nextRing = 0;

    // Scudo che si rompe: schegge (una sola InstancedMesh) + guscio che si gonfia
    this._shardMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.3, 0.75, 1.6),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this._shards = new THREE.InstancedMesh(makeShardGeometry(), this._shardMat, BURST_SLOTS * SHARDS_PER_BURST);
    this._shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._shards.frustumCulled = false;
    this._shards.renderOrder = 6;
    this._shards.count = 0;
    this._shards.visible = false;
    scene.add(this._shards);
    this._bursts = Array.from({ length: BURST_SLOTS }, () => {
      const mat = makeShieldMaterial(0);
      const shell = new THREE.Mesh(shieldGeometry, mat);
      shell.matrixAutoUpdate = false;
      shell.frustumCulled = false;
      shell.visible = false;
      shell.renderOrder = 6;
      scene.add(shell);
      return {
        shell, mat, plane: null, t: BURST_LIFE,
        pos: Array.from({ length: SHARDS_PER_BURST }, () => new THREE.Vector3()),
        vel: Array.from({ length: SHARDS_PER_BURST }, () => new THREE.Vector3()),
        axis: Array.from({ length: SHARDS_PER_BURST }, () => new THREE.Vector3()),
        spin: new Float32Array(SHARDS_PER_BURST),
      };
    });
    this._nextBurst = 0;
  }

  /**
   * Vampata alla bocca di un'arma.
   * @param {THREE.Object3D} obj   aereo (la vampata ne segue la matrice)
   * @param {number} ox,oy,oz     posizione dell'arma nello spazio dell'aereo
   * @param {THREE.Color} color   colore già in HDR (≤ ~1.6)
   */
  muzzle(obj, ox, oy, oz, size, color) {
    if (!this.ready) return;
    const f = this._flashes[this._nextFlash++ % MUZZLE_CAPACITY];
    f.obj = obj;
    f.off.set(ox, oy, oz);
    f.t = 0;
    f.size = size * (0.85 + Math.random() * 0.3);
    f.roll = Math.random() * Math.PI;
    f.color.copy(color);
  }

  /** Anello nel colore del giocatore che si stringe sull'aereo appena nato. */
  spawnRing(plane, color) {
    if (!this.ready) return;
    const r = this._rings[this._nextRing++ % RING_SLOTS];
    r.plane = plane;
    r.t = 0;
    _col.set(color ?? '#ffffff');
    if (!Number.isFinite(_col.r + _col.g + _col.b)) _col.set('#ffffff');
    r.mat.color.copy(_col.lerp(_white, 0.3).multiplyScalar(1.25));
    r.mesh.visible = true;
  }

  /**
   * Lo scudo si rompe: guscio che si gonfia e svanisce attorno all'aereo,
   * schegge che volano via in coordinate world.
   * @param {object} plane  Airplane (serve `mesh` e `velocity`)
   */
  shieldBurst(plane) {
    if (!this.ready || !plane?.mesh) return;
    const b = this._bursts[this._nextBurst++ % BURST_SLOTS];
    b.plane = plane;
    b.t = 0;
    b.shell.visible = true;
    const origin = plane.mesh.position;
    const inherit = plane.velocity;
    const n = this.low ? SHARDS_PER_BURST / 2 : SHARDS_PER_BURST;
    for (let i = 0; i < SHARDS_PER_BURST; i++) {
      const d = _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (d.lengthSq() < 1e-4) d.set(0, 1, 0);
      d.normalize();
      b.pos[i].copy(origin).addScaledVector(d, 1.6);
      b.vel[i].copy(d).multiplyScalar(i < n ? 6 + Math.random() * 7 : 0);
      if (inherit) b.vel[i].addScaledVector(inherit, 0.55);
      b.axis[i].set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      b.spin[i] = i < n ? 6 + Math.random() * 10 : -1; // -1 = scheggia spenta (qualità bassa)
    }
  }

  /** Avanza tutti gli effetti e prepara il lotto delle luci. Una volta per frame. */
  tick(delta) {
    if (!this.ready) return;
    const dt = Math.min(Math.max(delta, 0), 0.05);
    this.nav.flush();
    this._tickMuzzle(dt);
    this._tickRings(dt);
    this._tickBursts(dt);
  }

  _tickMuzzle(dt) {
    let n = 0;
    const cols = this._muzzle.instanceColor.array;
    for (const f of this._flashes) {
      if (f.t >= MUZZLE_LIFE) continue;
      f.t += dt;
      const k = f.t / MUZZLE_LIFE;
      if (k >= 1 || !f.obj || !f.obj.visible) { f.t = MUZZLE_LIFE; continue; }
      const grow = f.size * (0.75 + 0.6 * k);
      _q.setFromAxisAngle(_xAxis, f.roll);
      _s.set(grow * 1.1, grow, grow);
      _m.compose(f.off, _q, _s);
      _m2.multiplyMatrices(f.obj.matrixWorld, _m);
      this._muzzle.setMatrixAt(n, _m2);
      const fade = (1 - k) * (1 - k);
      cols[n * 3] = f.color.r * fade;
      cols[n * 3 + 1] = f.color.g * fade;
      cols[n * 3 + 2] = f.color.b * fade;
      n++;
    }
    this._muzzle.count = n;
    this._muzzle.visible = n > 0;
    if (n > 0) {
      this._muzzle.instanceMatrix.needsUpdate = true;
      this._muzzle.instanceColor.needsUpdate = true;
    }
  }

  _tickRings(dt) {
    for (const r of this._rings) {
      if (r.t >= RING_LIFE) continue;
      r.t += dt;
      const k = r.t / RING_LIFE;
      const mesh = r.plane?.mesh;
      if (k >= 1 || !mesh || !mesh.visible) {
        r.t = RING_LIFE;
        r.mesh.visible = false;
        continue;
      }
      // Si stringe con un'accelerazione finale, come se "risucchiasse" l'aereo.
      const radius = 1.2 + 2.8 * (1 - k * k);
      _q.copy(r.plane.sphereQuaternion).multiply(_flatQ);
      _s.set(radius, radius, radius);
      r.mesh.matrix.compose(mesh.position, _q, _s);
      r.mat.opacity = Math.min(1, k * 6) * (1 - k) * 0.85;
    }
  }

  _tickBursts(dt) {
    let n = 0;
    for (const b of this._bursts) {
      if (b.t >= BURST_LIFE) continue;
      b.t += dt;
      const k = b.t / BURST_LIFE;
      if (k >= 1) { b.shell.visible = false; continue; }

      // Guscio: si gonfia del 60% e svanisce in 0.3 s, seguendo l'aereo.
      const ks = b.t / SHELL_LIFE;
      const mesh = b.plane?.mesh;
      if (ks < 1 && mesh) {
        const sc = 1 + 0.45 * (1 - (1 - ks) * (1 - ks));
        _s.set(sc, sc, sc);
        b.shell.matrix.compose(mesh.position, mesh.quaternion, _s);
        b.mat.uniforms.uAlpha.value = 1.4 * (1 - ks) * (1 - ks);
        b.shell.visible = true;
      } else {
        b.shell.visible = false;
      }

      const drag = Math.exp(-2.2 * dt);
      const shrink = 1 - k * k;
      for (let i = 0; i < SHARDS_PER_BURST; i++) {
        if (b.spin[i] < 0) continue;
        b.vel[i].multiplyScalar(drag);
        b.pos[i].addScaledVector(b.vel[i], dt);
        _q.setFromAxisAngle(b.axis[i], b.spin[i] * b.t);
        _s.setScalar(shrink);
        _m.compose(b.pos[i], _q, _s);
        this._shards.setMatrixAt(n++, _m);
      }
    }
    this._shards.count = n;
    this._shards.visible = n > 0;
    if (n > 0) this._shards.instanceMatrix.needsUpdate = true;
  }
}

/** Effetti degli aerei. `init()` in main.js, prima della pre-compilazione. */
export const aircraftFx = new AircraftFx();
