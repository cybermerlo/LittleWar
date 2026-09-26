import * as THREE from 'three';
import { FLY_ALTITUDE } from '../../../shared/constants.js';
import { shotHeadingOffsets, segmentPointDistSq } from '../../../shared/projectile.js';
import { makeFlightFrame, fillFlightFrame, flightPoint } from './hudMath.js';

/**
 * Mirino sulla traiettoria vera dei proiettili, hit marker e serie di
 * abbattimenti.
 *
 * I proiettili volano a quota costante su un cerchio massimo: il mirino sta
 * dove passeranno fra ~0.2 s (0.2 rad ≈ 11 unità davanti). Vista dalla camera
 * dietro l'aereo quella è anche la cima dell'arco: più avanti il percorso
 * ridiscende verso l'orizzonte per la curvatura, quindi un secondo segno più
 * lontano finirebbe *sotto* il mirino e sembrerebbe un tiro che cala.
 *
 * Con l'arma potenziata le tacche si aprono quanto la rosa della raffica.
 * Diventa rosso quando un aereo nemico, *come è disegnato*, sta sul percorso
 * dei prossimi 0.45 rad: è una guida, non una promessa al pixel (con ping alto
 * decide comunque il test sul moto disegnato, vedi Projectile.js).
 *
 * Solo transform e opacity: niente layout, e ogni scrittura parte solo se il
 * valore cambia davvero.
 */

const AIM_NEAR = 0.2;
const LOCK_REACH = 0.45;     // rad di percorso controllati per l'aggancio
const LOCK_RADIUS_SQ = 2.2 * 2.2;
const MOVE_EPS = 0.5; // px

const _v = new THREE.Vector3();
const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };
const _c = { x: 0, y: 0, z: 0 };

const HIT_STYLE = {
  hit:    { color: '#ffffff', from: 1.35, to: 1.0, ms: 220 },
  kill:   { color: '#ff4d5a', from: 1.8,  to: 1.15, ms: 480 },
  shield: { color: '#5cc8ff', from: 1.5,  to: 1.05, ms: 320 },
};

export class HudReticle {
  constructor() {
    this.el = document.getElementById('hud-reticle');
    this.hitEl = this.el?.querySelector('.rt-hit') ?? null;
    this.streakEl = this.el?.querySelector('.rt-streak') ?? null;
    this._frame = makeFlightFrame();
    this._on = false;
    // Fuori da ogni schermo: la prima posizione viene sempre scritta.
    this._x = -1e6; this._y = -1e6;
    this._spread = 0;
    this._locked = false;
    this._wl = -1;
    this._maxOffset = 0;
  }

  /**
   * @param {object} frame  stato del frame (theta, phi, heading, alive, weaponLevel, targets)
   * @param {THREE.Camera} camera  con matrixWorld già aggiornata in questo frame
   */
  update(frame, camera, W, H) {
    if (!this.el) return;
    if (!frame.alive) { this._setOn(false); return; }
    const f = fillFlightFrame(this._frame, frame.theta, frame.phi, frame.heading);

    flightPoint(f, AIM_NEAR, 0, FLY_ALTITUDE, _a);
    _v.set(_a.x, _a.y, _a.z).project(camera);
    if (_v.z > 1 || _v.z < -1) { this._setOn(false); return; }
    this._setOn(true);
    const x = (_v.x * 0.5 + 0.5) * W;
    const y = (-_v.y * 0.5 + 0.5) * H;
    if (Math.abs(x - this._x) >= MOVE_EPS || Math.abs(y - this._y) >= MOVE_EPS) {
      this._x = x; this._y = y;
      this.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }

    // Rosa della raffica: distanza a schermo fra i due colpi estremi.
    // shotHeadingOffsets alloca un array: si ricalcola solo al cambio di livello.
    if (frame.weaponLevel !== this._wl) {
      this._wl = frame.weaponLevel;
      const offsets = shotHeadingOffsets(this._wl);
      this._maxOffset = offsets.length > 1 ? offsets[offsets.length - 1] : 0;
    }
    let spread = 0;
    if (this._maxOffset > 0) {
      flightPoint(f, AIM_NEAR, this._maxOffset, FLY_ALTITUDE, _b);
      _v.set(_b.x, _b.y, _b.z).project(camera);
      const rx = (_v.x * 0.5 + 0.5) * W, ry = (-_v.y * 0.5 + 0.5) * H;
      spread = Math.max(0, Math.hypot(rx - x, ry - y) - 10);
    }
    if (Math.abs(spread - this._spread) >= MOVE_EPS) {
      this._spread = spread;
      this.el.style.setProperty('--spread', spread.toFixed(1));
    }

    // Aggancio: un nemico disegnato vicino al percorso fino a 0.45 rad (due
    // corde dell'arco: la corda singola se ne scosta di 1.4 unità).
    const R = FLY_ALTITUDE;
    const sx = f.px * R, sy = f.py * R, sz = f.pz * R;
    flightPoint(f, LOCK_REACH * 0.5, 0, R, _b);
    flightPoint(f, LOCK_REACH, 0, R, _c);
    let locked = false;
    const targets = frame.targets;
    if (targets) {
      for (let i = 0; i < targets.length && !locked; i++) {
        const t = targets[i];
        if (segmentPointDistSq(sx, sy, sz, _b.x, _b.y, _b.z, t.x, t.y, t.z) < LOCK_RADIUS_SQ
          || segmentPointDistSq(_b.x, _b.y, _b.z, _c.x, _c.y, _c.z, t.x, t.y, t.z) < LOCK_RADIUS_SQ) {
          locked = true;
        }
      }
    }
    if (locked !== this._locked) {
      this._locked = locked;
      this.el.classList.toggle('is-locked', locked);
    }
  }

  hide() { this._setOn(false); }

  /** Crocetta attorno al mirino: 'hit' bianca, 'kill' rossa e grande, 'shield' azzurra. */
  flashHit(kind = 'hit') {
    const el = this.hitEl;
    if (!el || typeof el.animate !== 'function') return;
    const s = HIT_STYLE[kind] ?? HIT_STYLE.hit;
    el.style.color = s.color;
    el.animate(
      [
        { opacity: 1, transform: `scale(${s.from})` },
        { opacity: 1, transform: `scale(${s.to})`, offset: 0.35 },
        { opacity: 0, transform: `scale(${s.to})` },
      ],
      { duration: s.ms, easing: 'ease-out' },
    );
  }

  /** Scritta sotto il mirino ("DOPPIO!"), che sale e svanisce. */
  showStreak(text) {
    const el = this.streakEl;
    if (!el || typeof el.animate !== 'function') return;
    el.textContent = text;
    el.animate(
      [
        { opacity: 0, transform: 'translate(-50%, 6px) scale(0.8)' },
        { opacity: 1, transform: 'translate(-50%, 0) scale(1.1)', offset: 0.15 },
        { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.75 },
        { opacity: 0, transform: 'translate(-50%, -8px) scale(1)' },
      ],
      { duration: 1400, easing: 'ease-out' },
    );
  }

  _setOn(on) {
    if (on === this._on) return;
    this._on = on;
    this.el.classList.toggle('is-on', on);
  }
}
