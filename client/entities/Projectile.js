import * as THREE from 'three';
import {
  makeTrajectory,
  trajectoryPoint,
  trajectoryTangent,
  segmentPointDistSq,
} from '../../shared/projectile.js';
import { FLY_ALTITUDE, BULLET_HIT_RADIUS } from '../../shared/constants.js';
import { makeGlowSpriteMaterial, glowQuadGeometry } from './glowSprite.js';
import { isLowPowerQuality } from '../utils/performanceProfile.js';

/**
 * Proiettili lato client.
 *
 * Il server annuncia ogni salva una sola volta (evento `shots`); da lì in poi
 * il volo lo calcola il client a ogni frame con la stessa formula del server
 * (`shared/projectile.js`). Prima la posizione arrivava nel game-state a
 * 40 Hz: i proiettili avanzavano a scatti di 1.3 unità e, negli scontri, il
 * game-state gonfiava fino a centinaia di KB/s per client.
 *
 * I colpi del giocatore locale compaiono subito, senza aspettare il server, e
 * sono questi — quelli che il giocatore vede — a decidere se un aereo nemico
 * è stato colpito (vedi `update`, callback `onLocalHit`).
 *
 * Tutto il rendering sta in tre InstancedMesh: i nuclei incandescenti, le
 * scie colorate col colore di chi ha sparato e un alone a dimensione minima
 * sullo schermo (vedi glowSprite.js). Tre draw call in tutto, qualunque sia
 * il numero di proiettili.
 *
 * Il nucleo è una capsula di raggio 0.12 vista quasi di coda: a distanza
 * copre 1-3 pixel e sfarfalla, e in qualità bassa (senza bloom) una raffica
 * lontana quasi non si vedeva. L'alone resta un puntino netto di qualche
 * pixel a qualunque distanza.
 */

const MAX_INSTANCES = 512;
/** Lunghezza massima della scia (unità mondo). */
const TRAIL_LENGTH = 5.5;
/** Colpi decisi da chi spara: margine visivo appena sopra il raggio del server. */
const LOCAL_HIT_RADIUS = BULLET_HIT_RADIUS + 0.1;
/** Per quanto ricordare un proiettile già tolto (evita di ricrearlo da un evento tardivo). */
const DEAD_MEMORY_MS = 4000;
/** Un proiettile nemico che passa entro questa distanza dal nostro aereo è un "quasi colpo". */
const NEAR_MISS_RADIUS = 3.5;
/**
 * I powerup aumentano "livello e dimensione dell'arma": i proiettili crescono
 * col numero di colpi della raffica, che arriva già nell'evento `shots`, quindi
 * senza toccare il protocollo.
 */
function salvoSize(bullets) {
  return 1 + 0.12 * Math.min(Math.max(0, bullets - 1), 6);
}
const LOW_QUALITY = isLowPowerQuality();
/** Alone: diametro mondo del puntino e sua intensità (senza bloom deve fare tutto lui). */
const GLOW_SIZE = 0.45;
/** Nei primi istanti l'alone si accende piano: il colpo nasce sopra l'abitacolo. */
const GLOW_FADE_IN_MS = 90;
const GLOW_GAIN = LOW_QUALITY ? 0.95 : 0.5;

/**
 * Chi vuole sapere delle salve nuove (vampate di sparo sugli aerei). Non per
 * le riconciliazioni (`only`), che non sono spari nuovi.
 */
let _salvoListener = null;
export function setSalvoListener(fn) {
  _salvoListener = typeof fn === 'function' ? fn : null;
}

// ── Geometrie ─────────────────────────────────────────────────────────────────

// Nucleo: capsula allungata lungo +Z (direzione di volo).
const coreGeo = new THREE.CapsuleGeometry(0.12, 0.6, 2, 6);
coreGeo.rotateX(Math.PI / 2);

// Scia: cono aperto dalla testa (z = 0, larga) alla coda (z = −1, punta),
// con luminosità che si spegne verso la coda. Scalato in Z alla lunghezza.
const trailGeo = new THREE.CylinderGeometry(0.16, 0.0, 1, 6, 1, true);
trailGeo.rotateX(Math.PI / 2);
trailGeo.translate(0, 0, -0.5);
{
  const pos = trailGeo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(1 + pos.getZ(i), 0, 1); // 1 in testa, 0 in coda
    const b = t * t;
    col[i * 3] = b; col[i * 3 + 1] = b; col[i * 3 + 2] = b;
  }
  trailGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const trailMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  vertexColors: true,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

const _white = new THREE.Color(1, 1, 1);
const _hot = new THREE.Color(1.0, 0.9, 0.62);
const _glowTmp = new THREE.Color();
const _tmpColor = new THREE.Color();
const _p = { x: 0, y: 0, z: 0 };
const _hitAt = new THREE.Vector3();
const _t = { x: 0, y: 0, z: 0 };

/** Colore della scia: il colore del giocatore, schiarito quanto basta da brillare. */
function trailColorFor(color, out) {
  out.set(color ?? '#ffd36b');
  out.lerp(_white, 0.3);
  const lum = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  if (lum < 0.45) out.lerp(_white, 0.45 - lum); // il nero e il marrone restano visibili
  return out.multiplyScalar(1.35);
}

function coreColorFor(color, out) {
  out.set(color ?? '#ffd36b');
  return out.lerp(_hot, 0.78).multiplyScalar(2.4); // oltre 1: lo prende il bloom
}

export class ProjectileSystem {
  constructor(scene) {
    this.core = new THREE.InstancedMesh(coreGeo, coreMat, MAX_INSTANCES);
    this.trail = new THREE.InstancedMesh(trailGeo, trailMat, MAX_INSTANCES);
    this.glow = new THREE.InstancedMesh(
      glowQuadGeometry,
      makeGlowSpriteMaterial({ minPx: LOW_QUALITY ? 5 : 4.5, core: 0.12 }),
      MAX_INSTANCES,
    );
    for (const m of [this.core, this.trail, this.glow]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      // Inizializza instanceColor subito, così lo shader nasce già con il
      // colore per istanza e non va ricompilato al primo sparo.
      m.setColorAt(0, _white);
      scene.add(m);
    }
    this.core.renderOrder = 3;
    this.trail.renderOrder = 2;
    this.glow.renderOrder = 4;

    /** Record attivi, compatti: l'indice nell'array è lo slot di rendering. */
    this._active = [];
    this._byId = new Map();
    this._dead = new Map(); // id → ms di rimozione
    /** Ultimo colpo a segno dei NOSTRI proiettili per bersaglio (id → ms). */
    this._lastHitAt = new Map();

    /**
     * Posizione (world) del nostro aereo, per i quasi colpi; null se morto.
     * La imposta main.js a ogni frame.
     */
    this.listener = null;
    /** (rec, point) → void: un proiettile altrui ci è passato vicino. */
    this.onNearMiss = null;
  }

  /** Ms dell'ultimo colpo a segno dei nostri proiettili su `targetId` (o -Infinity). */
  lastLocalHitAt(targetId) {
    return this._lastHitAt.get(targetId) ?? -Infinity;
  }

  get count() {
    return this._active.length;
  }

  has(id) {
    return this._byId.has(id);
  }

  wasRemoved(id) {
    return this._dead.has(id);
  }

  /**
   * Crea i proiettili di una salva (`${shotId}:${i}` per ogni heading).
   * @param {object} o
   * @param {string} o.shotId
   * @param {string} o.ownerId
   * @param {number} o.theta
   * @param {number} o.phi
   * @param {number[]} o.headings
   * @param {number} o.speed        rad/s
   * @param {number} o.lifetime     ms
   * @param {number} o.spawnAt      performance.now() dell'istante di sparo
   * @param {number} [o.altitude]   quota di disegno
   * @param {string} [o.color]      colore di chi spara
   * @param {boolean} [o.local]     proiettile del giocatore locale (decide lui i colpi)
   * @param {number[]} [o.only]     indici da creare (riconciliazione)
   */
  spawnSalvo(o) {
    const coreColor = coreColorFor(o.color, new THREE.Color());
    const trailColor = trailColorFor(o.color, new THREE.Color());
    const glowColor = _glowTmp.copy(coreColor).lerp(trailColor, 0.5).multiplyScalar(GLOW_GAIN).clone();
    const size = salvoSize(o.headings.length);
    const altitude = o.altitude ?? FLY_ALTITUDE + 0.1;
    o.headings.forEach((heading, i) => {
      if (o.only && !o.only.includes(i)) return;
      const id = `${o.shotId}:${i}`;
      if (this._byId.has(id) || this._dead.has(id)) return;
      if (this._active.length >= MAX_INSTANCES) return;
      const traj = makeTrajectory(o.theta, o.phi, heading);
      const rec = {
        id,
        shotId: o.shotId,
        ownerId: o.ownerId,
        traj,
        speed: o.speed,
        lifetime: o.lifetime,
        spawnAt: o.spawnAt,
        altitude,
        local: !!o.local,
        coreColor,
        trailColor,
        glowColor,
        size,
        nearMiss: false,
        prev: { x: traj.px, y: traj.py, z: traj.pz },
        cur: { x: traj.px, y: traj.py, z: traj.pz },
        slot: this._active.length,
        removed: false,
      };
      this._active.push(rec);
      this._byId.set(id, rec);
      this.core.setColorAt(rec.slot, coreColor);
      this.trail.setColorAt(rec.slot, trailColor);
    });
    this._flagColors();
    if (!o.only) _salvoListener?.(o);
  }

  /** Indici dei proiettili di una salva ancora presenti. */
  salvoIndices(shotId) {
    const out = [];
    for (const r of this._active) {
      if (r.shotId === shotId) out.push(Number(r.id.slice(shotId.length + 1)));
    }
    return out;
  }

  /**
   * Toglie un proiettile. Restituisce la sua posizione (world) se esisteva,
   * utile per la scintilla d'impatto.
   */
  remove(id, outPos = null) {
    const rec = this._byId.get(id);
    this._dead.set(id, performance.now());
    if (!rec) return null;
    if (outPos) outPos.set(rec.cur.x, rec.cur.y, rec.cur.z).multiplyScalar(rec.altitude);
    this._detach(rec);
    return outPos;
  }

  removeSalvo(shotId) {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const r = this._active[i];
      if (r.shotId === shotId) {
        this._dead.set(r.id, performance.now());
        this._detach(r);
      }
    }
  }

  clear() {
    for (const r of this._active) this._byId.delete(r.id);
    this._active.length = 0;
    this._dead.clear();
    this._lastHitAt.clear();
    this.core.count = 0;
    this.trail.count = 0;
    this.glow.count = 0;
  }

  /** Rimozione con scambio: l'ultimo record prende lo slot liberato. */
  _detach(rec) {
    if (rec.removed) return;
    rec.removed = true;
    this._byId.delete(rec.id);
    const last = this._active.pop();
    if (last !== rec) {
      last.slot = rec.slot;
      this._active[rec.slot] = last;
      this.core.setColorAt(last.slot, last.coreColor);
      this.trail.setColorAt(last.slot, last.trailColor);
      this._flagColors();
    }
  }

  _flagColors() {
    if (this.core.instanceColor) this.core.instanceColor.needsUpdate = true;
    if (this.trail.instanceColor) this.trail.instanceColor.needsUpdate = true;
  }

  /**
   * Avanza tutti i proiettili al tempo `now` e rileva i colpi dei proiettili
   * locali contro `targets` (aerei remoti così come sono disegnati).
   *
   * Il test è sul moto *relativo* nel frame: proiettile da prev a cur,
   * bersaglio da (px,py,pz) a (x,y,z). Con un frame lungo (calo di fps) un
   * test sul solo punto finale del bersaglio farebbe passare il colpo "di
   * fianco" a un aereo che nel frattempo si è spostato.
   *
   * @param {number} now  performance.now()
   * @param {{id:string, x:number, y:number, z:number, px:number, py:number, pz:number}[]} targets
   * @param {(rec:object, target:object, ageMs:number, point:THREE.Vector3) => void} onLocalHit
   */
  update(now, targets, onLocalHit) {
    const R = FLY_ALTITUDE;
    const hitR2 = LOCAL_HIT_RADIUS * LOCAL_HIT_RADIUS;
    const nearR2 = NEAR_MISS_RADIUS * NEAR_MISS_RADIUS;
    const L = this.listener;

    for (let i = this._active.length - 1; i >= 0; i--) {
      const rec = this._active[i];
      const age = now - rec.spawnAt;
      const expired = age >= rec.lifetime;
      const prevAge = rec.age ?? 0;
      // Anche all'ultimo frame si controlla il tratto fino a fine vita.
      rec.age = Math.min(rec.lifetime, Math.max(0, age));
      rec.prev.x = rec.cur.x; rec.prev.y = rec.cur.y; rec.prev.z = rec.cur.z;
      trajectoryPoint(rec.traj, rec.speed * rec.age / 1000, rec.cur);

      if (rec.local && targets && targets.length > 0) {
        const a = rec.prev, b = rec.cur;
        for (const t of targets) {
          // Moto relativo: A = scarto a inizio frame, B = scarto a fine frame.
          const ax = a.x * R - t.px, ay = a.y * R - t.py, az = a.z * R - t.pz;
          const bx = b.x * R - t.x,  by = b.y * R - t.y,  bz = b.z * R - t.z;
          if (segmentPointDistSq(ax, ay, az, bx, by, bz, 0, 0, 0) >= hitR2) continue;

          // Istante del massimo avvicinamento dentro il frame: il server
          // rivede lì la posizione del bersaglio.
          const dx = bx - ax, dy = by - ay, dz = bz - az;
          const len2 = dx * dx + dy * dy + dz * dz;
          const f = len2 > 1e-12 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy + az * dz) / len2)) : 1;
          const hitAge = prevAge + (rec.age - prevAge) * f;
          _hitAt.set(t.px + (t.x - t.px) * f, t.py + (t.y - t.py) * f, t.pz + (t.z - t.pz) * f);

          this._dead.set(rec.id, now);
          this._lastHitAt.set(t.id, now);
          this._detach(rec);
          onLocalHit?.(rec, t, hitAge, _hitAt);
          rec.hit = true;
          break;
        }
        if (rec.hit) continue;
      }
      // Quasi colpo: un solo test segmento-punto per proiettile altrui, e una
      // volta sola per proiettile.
      if (!rec.local && !rec.nearMiss && L && this.onNearMiss) {
        const A = rec.altitude, a = rec.prev, b = rec.cur;
        if (segmentPointDistSq(a.x * A, a.y * A, a.z * A, b.x * A, b.y * A, b.z * A, L.x, L.y, L.z) < nearR2) {
          rec.nearMiss = true;
          _hitAt.set(b.x * A, b.y * A, b.z * A);
          this.onNearMiss(rec, _hitAt);
        }
      }
      if (expired) this._detach(rec);
    }

    // Matrici: base (destra, radiale, avanti) scritta direttamente nel buffer.
    const cm = this.core.instanceMatrix.array;
    const tm = this.trail.instanceMatrix.array;
    const gm = this.glow.instanceMatrix.array;
    const gc = this.glow.instanceColor.array;
    for (let s = 0; s < this._active.length; s++) {
      const rec = this._active[s];
      const age = Math.max(0, now - rec.spawnAt);
      const angle = rec.speed * age / 1000;
      trajectoryPoint(rec.traj, angle, _p);
      trajectoryTangent(rec.traj, angle, _t);
      // destra = su × avanti
      const rx = _p.y * _t.z - _p.z * _t.y;
      const ry = _p.z * _t.x - _p.x * _t.z;
      const rz = _p.x * _t.y - _p.y * _t.x;
      const px = _p.x * rec.altitude, py = _p.y * rec.altitude, pz = _p.z * rec.altitude;

      // Scia: cresce dallo sparo fino alla lunghezza piena; si assottiglia
      // nell'ultimo quinto di vita.
      const travelled = angle * rec.altitude;
      const len = Math.min(TRAIL_LENGTH, travelled);
      const fade = Math.min(1, (rec.lifetime - age) / (rec.lifetime * 0.2));

      const o = s * 16;
      const k = rec.size;
      writeBasis(cm, o, rx, ry, rz, _p.x, _p.y, _p.z, _t.x, _t.y, _t.z, k, k, k, px, py, pz);
      writeBasis(tm, o, rx, ry, rz, _p.x, _p.y, _p.z, _t.x, _t.y, _t.z, fade * k, fade * k, Math.max(0.001, len), px, py, pz);
      // Alone: solo traslazione e scala (il vertex shader lo gira verso la camera).
      const g = GLOW_SIZE * k;
      writeBasis(gm, o, 1, 0, 0, 0, 1, 0, 0, 0, 1, g, g, g, px, py, pz);
      const gf = Math.max(0, fade) * Math.min(1, age / GLOW_FADE_IN_MS);
      gc[s * 3] = rec.glowColor.r * gf;
      gc[s * 3 + 1] = rec.glowColor.g * gf;
      gc[s * 3 + 2] = rec.glowColor.b * gf;
    }

    const n = this._active.length;
    this.core.count = n;
    this.trail.count = n;
    this.glow.count = n;
    this.core.instanceMatrix.needsUpdate = true;
    this.trail.instanceMatrix.needsUpdate = true;
    this.glow.instanceMatrix.needsUpdate = true;
    this.glow.instanceColor.needsUpdate = true;

    if (this._dead.size > 64) {
      for (const [id, t] of this._dead) if (now - t > DEAD_MEMORY_MS) this._dead.delete(id);
    }
  }
}

/** Scrive una matrice colonna-maggiore con assi X, Y, Z scalati e traslazione. */
function writeBasis(a, o, xx, xy, xz, yx, yy, yz, zx, zy, zz, sx, sy, sz, tx, ty, tz) {
  a[o]      = xx * sx; a[o + 1]  = xy * sx; a[o + 2]  = xz * sx; a[o + 3]  = 0;
  a[o + 4]  = yx * sy; a[o + 5]  = yy * sy; a[o + 6]  = yz * sy; a[o + 7]  = 0;
  a[o + 8]  = zx * sz; a[o + 9]  = zy * sz; a[o + 10] = zz * sz; a[o + 11] = 0;
  a[o + 12] = tx;      a[o + 13] = ty;      a[o + 14] = tz;      a[o + 15] = 1;
}
