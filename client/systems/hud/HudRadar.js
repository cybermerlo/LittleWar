import {
  makeFlightFrame, fillFlightFrame, relativeBearing, angleFrom, forwardFromQuaternion,
} from './hudMath.js';

/**
 * Radar circolare orientato sulla rotta: in alto c'è sempre la direzione in
 * cui si vola. Su un pianeta sferico si perde facilmente l'orientamento e i
 * nemici spariscono dietro l'orizzonte: il radar risponde a "dove sono tutti?"
 * a colpo d'occhio.
 *
 * Ridisegnato a 15 Hz (10 in qualità bassa), non a ogni frame; disco e anelli
 * di portata sono CSS, il canvas disegna solo i segni. Niente shadowBlur né
 * filtri: costano più di tutto il resto.
 */

const RANGE = 0.9;            // rad al bordo del radar (~50 unità a quota di volo)
const TURRET_RANGE = 1.0;     // oltre non si mostrano: sarebbero solo rumore
const POWERUP_RANGE = 0.9;

const _fwd = { x: 0, y: 0, z: 0 };
const _pt = { x: 0, y: 0, edge: false };

export class HudRadar {
  constructor({ lowQuality = false } = {}) {
    this.canvas = document.getElementById('hud-radar');
    this.ctx = this.canvas?.getContext('2d') ?? null;
    this._interval = lowQuality ? 1 / 10 : 1 / 15;
    this._acc = Infinity;
    this._css = 0;
    this._c = 0;
    this._r = 0;
    this._dirty = true;
    this._frame = makeFlightFrame();
    this._buildingsRef = null;
    this._buildingDirs = [];
    window.addEventListener('resize', () => { this._dirty = true; });
  }

  /** Forza un ridisegno al prossimo update (es. al rientro in partita). */
  invalidate() {
    this._acc = Infinity;
    this._dirty = true;
  }

  update(dt, frame, allPlayers, target, buildings, localId, localColor) {
    if (!this.ctx) return;
    this._acc += dt;
    if (this._acc < this._interval) return;
    this._acc = 0;
    if (this._dirty && !this._resize()) return;

    const ctx = this.ctx;
    const size = this._css;
    const c = size / 2;
    const R = c - 6;
    ctx.clearRect(0, 0, size, size);

    const f = fillFlightFrame(this._frame, frame.theta, frame.phi, frame.heading);
    this._c = c;
    this._r = R;

    // Torrette: le tue nel tuo colore, quelle altrui in rosso, le neutre vuote.
    if (buildings !== this._buildingsRef) this._cacheBuildings(buildings);
    for (const b of this._buildingDirs) {
      const p = this._toRadar(b.x, b.y, b.z, TURRET_RANGE);
      if (p.edge) continue;
      if (b.ownerId == null) {
        ctx.strokeStyle = 'rgba(225, 225, 245, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
      } else {
        ctx.fillStyle = b.ownerId === localId ? (localColor || '#5ee08a') : '#ff4d5a';
        ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
        ctx.strokeStyle = 'rgba(11, 10, 38, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x - 4, p.y - 4, 8, 8);
      }
    }

    // Powerup vicini.
    if (frame.powerups) {
      ctx.fillStyle = '#ffd23f';
      for (const pu of frame.powerups.values()) {
        const st = Math.sin(pu.theta);
        const p = this._toRadar(st * Math.cos(pu.phi), Math.cos(pu.theta), st * Math.sin(pu.phi), POWERUP_RANGE);
        if (p.edge) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Bersaglio da bombardare: sempre, al bordo se lontano.
    if (target) {
      const st = Math.sin(target.theta);
      const p = this._toRadar(st * Math.cos(target.phi), Math.cos(target.theta), st * Math.sin(target.phi), RANGE);
      ctx.strokeStyle = '#ff9a2e';
      ctx.fillStyle = '#ff9a2e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.edge ? 3.5 : 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Nemici: triangoli nel loro colore, orientati sulla loro rotta.
    const remotes = frame.remotes;
    if (remotes && allPlayers) {
      for (const pl of allPlayers) {
        if (pl.id === localId || !pl.alive) continue;
        const plane = remotes.get(pl.id);
        if (!plane || !plane.mesh.visible) continue;
        const pos = plane.mesh.position;
        const p = this._toRadar(pos.x, pos.y, pos.z, RANGE);
        forwardFromQuaternion(plane.mesh.quaternion, _fwd);
        const rot = Math.atan2(
          _fwd.x * f.rx + _fwd.y * f.ry + _fwd.z * f.rz,
          _fwd.x * f.dx + _fwd.y * f.dy + _fwd.z * f.dz,
        );
        this._triangle(p.x, p.y, rot, p.edge ? 4 : 5.5, pl.color || '#8ec5ff', p.edge ? 0.6 : 1);
      }
    }

    // Noi al centro, sempre verso l'alto.
    this._triangle(c, c, 0, 6, '#ffffff', 1, localColor);
  }

  /** Coordinate radar (px CSS) di un punto del mondo; `edge` se oltre `range`. */
  _toRadar(x, y, z, range) {
    const f = this._frame;
    const ang = angleFrom(f, x, y, z);
    const b = relativeBearing(f, x, y, z);
    _pt.edge = ang > range;
    const r = Math.min(1, ang / RANGE) * this._r;
    _pt.x = this._c + Math.sin(b) * r;
    _pt.y = this._c - Math.cos(b) * r;
    return _pt;
  }

  _triangle(x, y, rot, s, fill, alpha, stroke) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(0, -s * 1.25);
    ctx.lineTo(s * 0.95, s);
    ctx.lineTo(0, s * 0.45);
    ctx.lineTo(-s * 0.95, s);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    // Bordo chiaro: anche un aereo nero o blu scuro si vede sul disco.
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = stroke || 'rgba(255, 255, 255, 0.85)';
    ctx.stroke();
    ctx.restore();
  }

  _cacheBuildings(buildings) {
    this._buildingsRef = buildings;
    const out = this._buildingDirs;
    out.length = 0;
    if (!buildings) return;
    for (const b of buildings) {
      const st = Math.sin(b.theta);
      out.push({ x: st * Math.cos(b.phi), y: Math.cos(b.theta), z: st * Math.sin(b.phi), ownerId: b.ownerId ?? null });
    }
  }

  /** Backing store alla dimensione CSS × DPR (max 2). False se non ancora visibile. */
  _resize() {
    const css = this.canvas.clientWidth;
    if (!css) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(css * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    this._css = css;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._dirty = false;
    return true;
  }
}
