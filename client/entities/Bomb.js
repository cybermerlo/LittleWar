import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { groundRadius } from '../scene/planetSurface.js';

const bombGeo = new THREE.IcosahedronGeometry(0.34, 0);
const bombMat = new THREE.MeshLambertMaterial({ color: 0x2b2b33, flatShading: true });
const _bombDir = new THREE.Vector3();

export class BombEntity {
  constructor(scene, id, theta, phi, altitude) {
    this.id = id;
    this.mesh = new THREE.Mesh(bombGeo, bombMat);
    scene.add(this.mesh);
    this.update(theta, phi, altitude);
  }

  update(theta, phi, altitude) {
    const pos = sphericalToCartesian(theta, phi, altitude);
    this.mesh.position.set(pos.x, pos.y, pos.z);
    // Il server fa esplodere la bomba a quota fissa: sopra una collina
    // attraverserebbe il terreno prima di scoppiare. Sotto il suolo non si vede.
    this.mesh.visible = altitude > groundRadius(_bombDir.set(pos.x, pos.y, pos.z)) + 0.2;
    this.mesh.rotation.x += 0.2;
  }

  dispose(scene) {
    scene.remove(this.mesh);
  }
}

// ── Esplosioni ────────────────────────────────────────────────────────────────
//
// Pool fisso di esplosioni composte, tutte create all'avvio (e quindi compilate
// dalla pre-compilazione degli shader, che include anche gli oggetti
// invisibili). Ogni esplosione è fatta di cinque strati:
//   lampo      — sfera additiva velocissima, oltre 1.0 così la prende il bloom
//   fuoco      — palline low-poly arancio/rosse che si gonfiano e svaniscono
//   fumo       — palline grigie illuminate che salgono e restano un po' di più
//   scintille  — trattini additivi lanciati in fuori e richiamati dalla gravità
//   onda       — anello sul piano tangente che si allarga
// Nessuna allocazione durante il gioco: si riusa lo slot più vecchio.

const POOL_SIZE = 8;
const FIRE_PUFFS = 7;
const SMOKE_PUFFS = 6;
const SPARKS = 14;
const DURATION = 1.25; // s, durata complessiva (il fumo è l'ultimo a sparire)

const puffGeo = new THREE.IcosahedronGeometry(1, 0);
const flashGeo = new THREE.IcosahedronGeometry(1, 1);
const sparkGeo = new THREE.BoxGeometry(0.05, 0.05, 0.55);
const ringGeo = new THREE.RingGeometry(0.82, 1, 40, 1);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _col = new THREE.Color();
// Poco sopra 1: abbastanza da accendere il bloom, non tanto da far bruciare
// il tone mapping in un bianco piatto.
const _fireA = new THREE.Color(1.3, 0.78, 0.2);
const _fireB = new THREE.Color(1.0, 0.3, 0.06);

function makeSlot(scene) {
  const group = new THREE.Group();
  group.visible = false;

  const flashMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.6, 1.25, 0.75), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flash = new THREE.Mesh(flashGeo, flashMat);

  const fireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
  const fire = new THREE.InstancedMesh(puffGeo, fireMat, FIRE_PUFFS);
  fire.setColorAt(0, _col.set(1, 1, 1));

  const smokeMat = new THREE.MeshLambertMaterial({
    color: 0x5d5a58, flatShading: true, transparent: true, depthWrite: false,
  });
  const smoke = new THREE.InstancedMesh(puffGeo, smokeMat, SMOKE_PUFFS);

  const sparkMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.7, 0.95, 0.3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sparks = new THREE.InstancedMesh(sparkGeo, sparkMat, SPARKS);

  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.0, 0.8, 0.55), transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);

  for (const o of [flash, fire, smoke, sparks, ring]) {
    o.frustumCulled = false;
    group.add(o);
  }
  flash.renderOrder = 6;
  sparks.renderOrder = 6;
  ring.renderOrder = 5;
  scene.add(group);

  return {
    group, flash, fire, smoke, sparks, ring,
    flashMat, fireMat, smokeMat, sparkMat, ringMat,
    t: DURATION,
    scale: 1,
    hasSmoke: true,
    sparkCount: SPARKS,
    // Direzioni e velocità per-istanza, riscritte a ogni esplosione.
    fireDirs: Array.from({ length: FIRE_PUFFS }, () => new THREE.Vector3()),
    fireSize: new Float32Array(FIRE_PUFFS),
    smokeDirs: Array.from({ length: SMOKE_PUFFS }, () => new THREE.Vector3()),
    smokeSize: new Float32Array(SMOKE_PUFFS),
    sparkDirs: Array.from({ length: SPARKS }, () => new THREE.Vector3()),
    sparkSpeed: new Float32Array(SPARKS),
  };
}

let _pool = null;
let _next = 0;

/**
 * Registra il pool nella scena. Da chiamare all'avvio, prima della
 * pre-compilazione degli shader: se una mesh entrasse in scena solo alla
 * prima esplosione, il suo programma GLSL verrebbe compilato proprio in
 * quell'istante e il gioco si bloccherebbe per qualche decina di millisecondi.
 */
export function initExplosionPool(scene) {
  if (_pool) return;
  _pool = Array.from({ length: POOL_SIZE }, () => makeSlot(scene));
}

/** Direzione casuale nell'emisfero attorno a `up` (più probabile vicino al polo). */
function randomHemi(up, out, spread = 1) {
  out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
  out.multiplyScalar(spread).add(up).normalize();
  return out;
}

/**
 * Esplosione in un punto del mondo.
 * @param {THREE.Scene} _scene
 * @param {THREE.Vector3} pos
 * @param {object} [opts]
 * @param {number} [opts.scale]   dimensione (1 = aereo abbattuto)
 * @param {number} [opts.color]   tinta del fuoco (es. bomba a vuoto più scura)
 * @param {number} [opts.sparks]  quante scintille (≤ 14)
 * @param {boolean} [opts.smoke]  colonna di fumo
 */
export function spawnExplosionAt(_scene, pos, opts = {}) {
  if (!_pool) return;
  const slot = _pool[_next % POOL_SIZE];
  _next++;

  const scale = opts.scale ?? 1;
  slot.scale = scale;
  slot.hasSmoke = opts.smoke !== false;
  slot.sparkCount = Math.max(0, Math.min(SPARKS, opts.sparks ?? SPARKS));
  slot.t = 0;
  slot.group.position.copy(pos);
  slot.group.visible = true;

  const up = _v.copy(pos).normalize();
  slot.up = slot.up ?? new THREE.Vector3();
  slot.up.copy(up);

  const tint = opts.color !== undefined ? _col.set(opts.color) : null;
  for (let i = 0; i < FIRE_PUFFS; i++) {
    randomHemi(up, slot.fireDirs[i], 1.6);
    slot.fireSize[i] = 0.42 + Math.random() * 0.4;
    const c = _col.copy(_fireA).lerp(_fireB, Math.random());
    if (tint) c.multiply(tint);
    slot.fire.setColorAt(i, c);
  }
  slot.fire.instanceColor.needsUpdate = true;
  for (let i = 0; i < SMOKE_PUFFS; i++) {
    randomHemi(up, slot.smokeDirs[i], 0.9);
    slot.smokeSize[i] = 0.6 + Math.random() * 0.6;
  }
  for (let i = 0; i < SPARKS; i++) {
    randomHemi(up, slot.sparkDirs[i], 2.2);
    slot.sparkSpeed[i] = 7 + Math.random() * 9;
  }

  // Onda d'urto sdraiata sul piano tangente.
  slot.ring.quaternion.setFromUnitVectors(_zAxis, up);
  slot.smoke.visible = slot.hasSmoke;
  slot.sparks.count = slot.sparkCount;
  slot.sparks.visible = slot.sparkCount > 0;
}


function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

/**
 * Avanza tutte le esplosioni attive. Chiamato una volta per frame dal game
 * loop con il delta reale.
 */
export function tickExplosions(delta) {
  if (!_pool) return;
  const dt = Math.min(delta, 0.05);
  for (const slot of _pool) {
    if (!slot.group.visible) continue;
    slot.t += dt;
    const t = slot.t;
    const k = slot.scale;
    const end = slot.hasSmoke ? DURATION : DURATION * 0.55;
    if (t >= end) { slot.group.visible = false; continue; }

    // Lampo: 0.16 s
    const tf = t / 0.16;
    slot.flash.visible = tf < 1;
    if (tf < 1) {
      slot.flash.scale.setScalar(k * (0.5 + 1.3 * easeOut(tf)));
      slot.flashMat.opacity = 1 - tf;
    }

    // Fuoco: 0.55 s, si gonfia e sale
    const tfi = t / 0.55;
    slot.fire.visible = tfi < 1;
    if (tfi < 1) {
      const e = easeOut(tfi);
      for (let i = 0; i < FIRE_PUFFS; i++) {
        const d = slot.fireDirs[i];
        const sz = k * slot.fireSize[i] * (0.4 + 1.1 * e);
        _s.setScalar(sz);
        _v.copy(d).multiplyScalar(k * 1.15 * e);
        _q.setFromAxisAngle(d, i + t * 2);
        _m.compose(_v, _q, _s);
        slot.fire.setMatrixAt(i, _m);
      }
      slot.fire.instanceMatrix.needsUpdate = true;
      slot.fireMat.opacity = 1 - tfi * tfi;
    }

    // Fumo: parte a 0.12 s, sale lungo la verticale locale e sfuma
    if (slot.hasSmoke) {
      const ts = (t - 0.12) / (DURATION - 0.12);
      slot.smoke.visible = ts > 0;
      if (ts > 0) {
        const e = easeOut(ts);
        for (let i = 0; i < SMOKE_PUFFS; i++) {
          const d = slot.smokeDirs[i];
          _s.setScalar(k * slot.smokeSize[i] * (0.5 + 1.2 * e));
          _v.copy(d).multiplyScalar(k * 1.3 * e).addScaledVector(slot.up, k * 1.8 * e);
          _q.setFromAxisAngle(d, i * 0.7 + t);
          _m.compose(_v, _q, _s);
          slot.smoke.setMatrixAt(i, _m);
        }
        slot.smoke.instanceMatrix.needsUpdate = true;
        slot.smokeMat.opacity = 0.75 * (1 - ts);
      }
    }

    // Scintille: 0.7 s, balistiche verso il centro del pianeta
    const tsp = t / 0.7;
    slot.sparks.visible = tsp < 1 && slot.sparkCount > 0;
    if (slot.sparks.visible) {
      for (let i = 0; i < slot.sparkCount; i++) {
        const d = slot.sparkDirs[i];
        const sp = slot.sparkSpeed[i] * k;
        _v.copy(d).multiplyScalar(sp * t).addScaledVector(slot.up, -6 * k * t * t);
        // orientate lungo la velocità
        _s.copy(d).multiplyScalar(sp).addScaledVector(slot.up, -12 * k * t).normalize();
        _q.setFromUnitVectors(_zAxis, _s);
        _s.set(1, 1, 1 + 1.5 * (1 - tsp)).multiplyScalar(Math.max(0.35, k));
        _m.compose(_v, _q, _s);
        slot.sparks.setMatrixAt(i, _m);
      }
      slot.sparks.instanceMatrix.needsUpdate = true;
      slot.sparkMat.opacity = 1 - tsp;
    }

    // Onda d'urto: 0.45 s
    const tr = t / 0.45;
    slot.ring.visible = tr < 1;
    if (tr < 1) {
      slot.ring.scale.setScalar(k * (0.5 + 4.5 * easeOut(tr)));
      slot.ringMat.opacity = 0.45 * (1 - tr);
    }
  }
}
