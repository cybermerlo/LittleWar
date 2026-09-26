import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundRadius } from '../scene/planetSurface.js';
import {
  segments,
  markers,
  SEG_TRAIL,
  MARK_IMPACT,
  MARK_RETICLE,
  isObjectiveLowQuality,
} from './ObjectiveFx.js';
import { PLANET_RADIUS, BOMB_FALL_SPEED, BOMB_HIT_RADIUS } from '../../shared/constants.js';

// ── Bombe ─────────────────────────────────────────────────────────────────────
//
// Bombetta cartoon con alette e una fascia del colore di chi l'ha sganciata,
// muso in giù. Tutte le bombe sono istanze di due InstancedMesh (corpo e
// fascia): prima era una Mesh per bomba, con un materiale che nasceva al primo
// sgancio (e lì veniva compilato).
//
// Caduta fluida: la posizione arrivava solo col game-state (40 Hz, volatile)
// e la bomba andava a scatti, soprattutto ricadendo sul polling. Ora il client
// la fa cadere da sé alla velocità del server e si riallinea solo se si
// discosta troppo. L'esplosione resta decisa dal server (`bomb-exploded`).

const BOMB_CAPACITY = 16;
/** Scarto oltre il quale la quota simulata si riallinea a quella del server. */
const BOMB_RESYNC = 0.4;
/** Il server fa esplodere la bomba a questa quota fissa. */
const BOMB_BURST_R = PLANET_RADIUS + 0.5;

function colorize(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

/** Corpo della bomba lungo +Z (muso in +Z), ~60 triangoli. */
function buildBombBodyGeometry() {
  const parts = [];
  const body = new THREE.CylinderGeometry(0.2, 0.2, 0.46, 8, 1);
  body.rotateX(Math.PI / 2);
  parts.push(colorize(body, 0x2b2d36));
  const nose = new THREE.SphereGeometry(0.2, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  nose.rotateX(Math.PI / 2);
  nose.translate(0, 0, 0.23);
  parts.push(colorize(nose, 0x2b2d36));
  const tail = new THREE.CylinderGeometry(0.2, 0.08, 0.22, 8, 1);
  tail.rotateX(Math.PI / 2);
  tail.translate(0, 0, -0.34);
  parts.push(colorize(tail, 0x2b2d36));
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.BoxGeometry(0.03, 0.2, 0.2);
    fin.translate(0, 0.17, -0.38);
    fin.rotateZ((k * Math.PI) / 2 + Math.PI / 4);
    parts.push(colorize(fin, 0xc9ccd4));
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()), false);
}

let _bombFx = null;
/** Bombe vive: le disegna tickBombFx, un'istanza ciascuna. */
const _bombs = new Set();

const _bm = new THREE.Matrix4();
const _bq = new THREE.Quaternion();
const _bq2 = new THREE.Quaternion();
const _bs = new THREE.Vector3(1, 1, 1);
const _bp = new THREE.Vector3();
const _bTop = new THREE.Vector3();
const _bNeg = new THREE.Vector3();
const _bColor = new THREE.Color();
const _bZ = new THREE.Vector3(0, 0, 1);
const _impactColor = new THREE.Color(1.35, 0.14, 0.08);
const _trailColor = new THREE.Color(0.95, 0.95, 1.0);

/**
 * Registra le InstancedMesh delle bombe. Da chiamare all'avvio, prima della
 * pre-compilazione degli shader (come initExplosionPool).
 */
export function initBombFx(scene) {
  if (_bombFx) return;
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const body = new THREE.InstancedMesh(buildBombBodyGeometry(), bodyMat, BOMB_CAPACITY);
  const bandGeo = new THREE.CylinderGeometry(0.212, 0.212, 0.12, 8, 1);
  bandGeo.rotateX(Math.PI / 2);
  bandGeo.translate(0, 0, -0.04);
  const bandMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const band = new THREE.InstancedMesh(bandGeo, bandMat, BOMB_CAPACITY);
  band.setColorAt(0, _bColor.set(0xffffff));
  for (const m of [body, band]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    m.visible = false;
    scene.add(m);
  }
  _bombFx = { body, band };
}

export class BombEntity {
  /**
   * @param {THREE.Scene} _scene
   * @param {string} id
   * @param {number} theta
   * @param {number} phi
   * @param {number} altitude  quota dal game-state
   * @param {string} [color]   colore di chi l'ha sganciata
   */
  constructor(_scene, id, theta, phi, altitude, color) {
    this.id = id;
    this.dir = new THREE.Vector3(
      Math.sin(theta) * Math.cos(phi),
      Math.cos(theta),
      Math.sin(theta) * Math.sin(phi),
    );
    this.altitude = altitude;
    this.color = new THREE.Color(color ?? '#dddddd');
    this.roll = Math.random() * Math.PI * 2;
    this.phase = Math.random();
    // Il server fa esplodere la bomba a quota fissa: sopra una collina
    // attraverserebbe il terreno prima di scoppiare. Sotto il suolo non si
    // vede. La direzione non cambia durante la caduta: basta campionare una volta.
    this.groundR = groundRadius(this.dir);
    _bombs.add(this);
  }

  /** Quota del server: corregge la simulazione solo se si è discostata. */
  update(_theta, _phi, altitude) {
    if (Math.abs(altitude - this.altitude) > BOMB_RESYNC) this.altitude = altitude;
  }

  dispose() {
    _bombs.delete(this);
  }
}

/**
 * Caduta, rotazione, scia e segno d'impatto di tutte le bombe. Una volta per
 * frame, prima di endObjectiveFx.
 */
export function tickBombFx(delta) {
  if (!_bombFx) return;
  const dt = Math.min(Math.max(delta || 0, 0), 0.1);
  const { body, band } = _bombFx;
  const low = isObjectiveLowQuality();
  let n = 0;
  for (const b of _bombs) {
    b.altitude = Math.max(BOMB_BURST_R, b.altitude - BOMB_FALL_SPEED * dt);
    b.roll += dt * 2.4;

    // Punto d'impatto: lampeggia per tutto il secondo e mezzo di caduta e
    // avvisa chi è sotto (utile a chi difende la propria torretta).
    markers?.add(b.dir, 2.2, _impactColor, MARK_IMPACT, b.phase);

    if (b.altitude <= b.groundR + 0.2 || n >= BOMB_CAPACITY) continue;
    _bp.copy(b.dir).multiplyScalar(b.altitude);
    // Muso verso il centro del pianeta, lento rollio attorno all'asse.
    _bq.setFromUnitVectors(_bZ, _bNeg.copy(b.dir).negate());
    _bq2.setFromAxisAngle(_bZ, b.roll);
    _bq.multiply(_bq2);
    _bm.compose(_bp, _bq, _bs);
    body.setMatrixAt(n, _bm);
    band.setMatrixAt(n, _bm);
    band.setColorAt(n, b.color);

    if (!low && segments) {
      _bp.addScaledVector(b.dir, 0.4);
      _bTop.copy(_bp).addScaledVector(b.dir, 1.8);
      segments.add(_bp, _bTop, 0.2, _trailColor, SEG_TRAIL, 0, 0.35);
    }
    n++;
  }
  body.count = n;
  band.count = n;
  body.visible = n > 0;
  band.visible = n > 0;
  if (n > 0) {
    body.instanceMatrix.needsUpdate = true;
    band.instanceMatrix.needsUpdate = true;
    band.instanceColor.needsUpdate = true;
  }
}

// ── Mirino di sgancio ─────────────────────────────────────────────────────────

/** Distanza (sulla sfera del server) entro cui il mirino compare. */
const RETICLE_SHOW_DIST = 14;
const _reticleDir = new THREE.Vector3();
const _reticleIdle = new THREE.Color(1.0, 0.93, 0.62);
const _reticleLock = new THREE.Color(0.35, 1.0, 0.42);
const _reticleColor = new THREE.Color();

/** Distanza cartesiana fra due punti sferici a raggio PLANET_RADIUS (come bombLanded sul server). */
function surfaceDist(t1, p1, t2, p2) {
  const r = PLANET_RADIUS;
  const dx = r * Math.sin(t1) * Math.cos(p1) - r * Math.sin(t2) * Math.cos(p2);
  const dy = r * Math.cos(t1) - r * Math.cos(t2);
  const dz = r * Math.sin(t1) * Math.sin(p1) - r * Math.sin(t2) * Math.sin(p2);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Mirino a terra sotto l'aereo locale, quando la bomba è pronta e c'è vicino
 * un obiettivo (bersaglio o torretta nemica). È esatto: la bomba cade dritta
 * sotto il punto di sgancio, e il cerchio ha il raggio utile del server
 * (BOMB_HIT_RADIUS). Verde e pulsante quando l'obiettivo è dentro.
 *
 * @param {number} theta     posizione locale (predetta, non quella del server)
 * @param {number} phi
 * @param {object|null} target        bersaglio corrente {theta, phi}
 * @param {Array} buildings           stati degli edifici
 * @param {string|null} localId
 */
export function showBombReticle(theta, phi, target, buildings, localId) {
  if (!markers) return;
  let best = target ? surfaceDist(theta, phi, target.theta, target.phi) : Infinity;
  for (const b of buildings) {
    if (!b.ownerId || b.ownerId === localId) continue;
    const d = surfaceDist(theta, phi, b.theta, b.phi);
    if (d < best) best = d;
  }
  if (best > RETICLE_SHOW_DIST) return;
  const lock = best < BOMB_HIT_RADIUS ? 1 : 0;
  _reticleColor.copy(lock ? _reticleLock : _reticleIdle);
  if (lock) _reticleColor.multiplyScalar(1.25);
  _reticleDir.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
  // L'anello del mirino sta a 0.95 del quad: raggio esatto = BOMB_HIT_RADIUS.
  markers.add(_reticleDir, (BOMB_HIT_RADIUS * 2) / 0.95, _reticleColor, MARK_RETICLE, lock);
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
