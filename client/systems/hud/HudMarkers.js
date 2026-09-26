import * as THREE from 'three';
import { FLY_ALTITUDE, MAX_PLAYERS } from '../../../shared/constants.js';
import { sphericalToCartesian } from '../../utils/SphereUtils.js';
import { surfaceRadiusSpherical } from '../../scene/planetSurface.js';
import {
  makeFlightFrame, fillFlightFrame, relativeBearing, segmentHitsSphere,
} from './hudMath.js';

/**
 * Indicatori sopra gli aerei nemici e sul bersaglio da bombardare, più le
 * frecce che dicono dove virare quando sono fuori schermo o dietro il pianeta.
 *
 * - Posizione *disegnata* (mesh degli aerei remoti, dopo il dead reckoning),
 *   non theta/phi del game-state: il marker non scivola più dietro l'aereo.
 * - Etichetta sopra l'aereo con la punta verso di lui: prima un disco pieno
 *   stava proprio sull'aereo e lo copriva.
 * - Test di occlusione col pianeta: i nemici dall'altra parte non vengono più
 *   disegnati "sul mare", diventano frecce al bordo.
 * - La freccia viene dalla rotta relativa (su = dritto, destra = vira a
 *   destra, giù = alle spalle), proiettata come la vede la camera: niente
 *   frecce specchiate per ciò che sta dietro la camera, e il rollio in virata
 *   è già compreso.
 * - Pool fisso creato una volta: nessun elemento creato o distrutto in
 *   partita, niente left/top (layout), scritture solo quando cambia qualcosa.
 */

/** Raggio sotto cui la linea di vista verso un aereo tocca il pianeta (colline comprese in media). */
const OCCLUDE_RADIUS_PLANE = 51.5;
/** Etichette complete (nome e distanza) solo ai nemici più vicini. */
const FULL_LABELS = 3;
const LABEL_LIFT = 1.8;          // unità sopra l'aereo
const CLOSE_DIM = 7;             // sotto questa distanza l'etichetta si attenua
const TEXT_REFRESH_MS = 250;
const MOVE_EPS = 0.5;            // px
const ROT_EPS = 1;               // gradi
const TURN_PROBE = 4;            // unità lungo la rotta, per la direzione "davanti" a schermo
const EDGE_MIN_SEP = 0.15;       // rad fra due frecce sull'ellisse
const KILLER_COLOR = '#ff4d5a';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _localPos = new THREE.Vector3();
const _targetPos = new THREE.Vector3();

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

function svgIcon(id, cls = 'lw-ico') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

/** Iniziale del nickname (primo carattere vero, anche se è un'emoji). */
function initialOf(nick) {
  if (!nick) return '?';
  const cp = nick.codePointAt(0);
  return String.fromCodePoint(cp).toUpperCase();
}

class Marker {
  constructor(root, isTarget) {
    this.root = el('div', isTarget ? 'mk mk--target' : 'mk', root);
    if (isTarget) {
      this.target = el('div', 'mk-target', this.root);
      this.target.appendChild(svgIcon('i-target', ''));
      this.labelDist = el('div', 'mk-edge-dist', this.target);
    } else {
      this.label = el('div', 'mk-label', this.root);
      this.labelName = el('span', 'mk-name', this.label);
      this.labelDist = el('span', 'mk-dist', this.label);
    }
    this.edge = el('div', 'mk-edge', this.root);
    this.arrow = el('div', 'mk-arrow', this.edge);
    this.badge = el('div', 'mk-badge', this.edge);
    if (isTarget) this.badge.appendChild(svgIcon('i-target'));
    this.edgeDist = el('div', 'mk-edge-dist', this.edge);

    this.id = null;
    this.seen = 0;
    this.on = false;
    this.edgeMode = null;
    this.occluded = false;
    this.short = null;
    this.close = false;
    this.killer = false;
    // Fuori da ogni schermo: la prima posizione viene sempre scritta.
    this.x = -1e6; this.y = -1e6; this.rot = -1e6;
    this.edgeAngle = 0;
    this.color = '';
    this.nick = null;
    this.distText = '';
    this.textAt = -Infinity;
  }

  setOn(on) {
    if (on === this.on) return;
    this.on = on;
    this.root.classList.toggle('is-on', on);
  }

  setColor(c) {
    if (c === this.color) return;
    this.color = c;
    this.root.style.setProperty('--c', c);
  }

  setMode(edge, occluded) {
    if (edge !== this.edgeMode) {
      this.edgeMode = edge;
      this.root.classList.toggle('is-edge', edge);
      // La distanza va riscritta nell'elemento ora visibile.
      this.textAt = -Infinity;
      this.distText = '';
    }
    if (occluded !== this.occluded) {
      this.occluded = occluded;
      this.root.classList.toggle('is-occluded', occluded);
    }
  }

  moveTo(x, y) {
    if (Math.abs(x - this.x) < MOVE_EPS && Math.abs(y - this.y) < MOVE_EPS) return;
    this.x = x; this.y = y;
    this.root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  pointTo(deg) {
    if (Math.abs(deg - this.rot) < ROT_EPS) return;
    this.rot = deg;
    this.arrow.style.transform = `rotate(${deg.toFixed(0)}deg)`;
  }

  setDistance(dist, now) {
    if (now - this.textAt < TEXT_REFRESH_MS) return;
    this.textAt = now;
    const text = `${Math.round(dist) * 10} m`;
    if (text === this.distText) return;
    this.distText = text;
    (this.edgeMode ? this.edgeDist : this.labelDist).textContent = text;
  }

  reset() {
    this.id = null;
    this.nick = null;
    if (this.killer) {
      this.killer = false;
      this.root.classList.remove('is-killer');
    }
    this.distText = '';
    this.textAt = -Infinity;
    this.setOn(false);
  }
}

export class HudMarkers {
  constructor() {
    this.root = document.getElementById('hud-markers');
    this._frame = makeFlightFrame();
    this._frameNo = 0;
    this._slots = [];
    this._slotById = new Map();
    this._cand = [];
    for (let i = 0; i < MAX_PLAYERS - 1; i++) {
      this._slots.push(new Marker(this.root, false));
      this._cand.push({ id: null, pos: null, dist: 0, nick: '', color: '' });
    }
    this._target = new Marker(this.root, true);
    this._targetTheta = NaN;
    this._targetPhi = NaN;
    this._targetR = 0;
    this._edgeList = new Array(MAX_PLAYERS);
    this._edgeN = 0;
    this._aheadX = 0;
    this._aheadY = -1;
    this._killerNick = null;
    this._isMobile = false;
    this._lastW = 0;
    this._lastH = 0;
    this._ax = 0; this._ay = 0;
  }

  hideAll() {
    for (const m of this._slots) m.reset();
    this._slotById.clear();
    this._target.setOn(false);
    this._killerNick = null;
  }

  /**
   * Chi ci ha appena abbattuto (nickname, o null): la sua etichetta diventa
   * rossa con "TI HA ABBATTUTO" e resta visibile anche da morti, freccia
   * compresa, finché non si rientra in volo.
   */
  setKiller(nick) {
    this._killerNick = nick || null;
  }

  update(frame, allPlayers, target, camera, W, H, now) {
    if (!this.root) return;
    this._frameNo++;
    const f = fillFlightFrame(this._frame, frame.theta, frame.phi, frame.heading);
    if (frame.localPos) _localPos.copy(frame.localPos);
    else _localPos.set(f.px * FLY_ALTITUDE, f.py * FLY_ALTITUDE, f.pz * FLY_ALTITUDE);
    this._updateEllipse(W, H);
    this._edgeN = 0;
    if (frame.alive) this._computeAhead(camera, W, H, f);
    else { this._aheadX = 0; this._aheadY = -1; }

    // Candidati: nemici vivi e disegnati, ordinati per distanza (≤ 9, a inserimento).
    let n = 0;
    const remotes = frame.remotes;
    if (remotes && allPlayers) {
      for (const p of allPlayers) {
        if (p.id === frame.localId || !p.alive) continue;
        const plane = remotes.get(p.id);
        if (!plane || !plane.mesh.visible) continue;
        if (n >= this._cand.length) break;
        const dist = plane.mesh.position.distanceTo(_localPos);
        let i = n++;
        while (i > 0 && this._cand[i - 1].dist > dist) {
          const tmp = this._cand[i];
          this._cand[i] = this._cand[i - 1];
          this._cand[i - 1] = tmp;
          i--;
        }
        const c = this._cand[i];
        c.id = p.id;
        c.pos = plane.mesh.position;
        c.dist = dist;
        c.nick = p.nickname ?? '?';
        c.color = p.color ?? '#8ec5ff';
      }
    }

    for (let r = 0; r < n; r++) {
      const c = this._cand[r];
      let m = this._slotById.get(c.id);
      if (!m) {
        m = this._slots.find((s) => s.id === null);
        if (!m) continue;
        m.id = c.id;
        this._slotById.set(c.id, m);
      }
      m.seen = this._frameNo;
      this._placePlane(m, c, r, frame, camera, W, H, now, f);
    }

    // Slot non più usati (morto, uscito): nascosti e liberati.
    for (const m of this._slots) {
      if (m.id !== null && m.seen !== this._frameNo) {
        this._slotById.delete(m.id);
        m.reset();
      }
    }

    this._placeTarget(target, frame, camera, W, H, now, f);
    this._layoutEdges(W, H);
  }

  _placePlane(m, c, rank, frame, camera, W, H, now, f) {
    const killer = this._killerNick !== null && c.nick === this._killerNick;
    if (killer !== m.killer) {
      m.killer = killer;
      m.root.classList.toggle('is-killer', killer);
    }
    m.setColor(killer ? KILLER_COLOR : c.color);
    // Nome intero ai più vicini, iniziale agli altri (e sempre su telefono):
    // nessun elemento compare o sparisce quando cambia l'ordine di vicinanza.
    const short = this._isMobile || rank >= FULL_LABELS;
    if (short !== m.short || c.nick !== m.nick) {
      m.short = short;
      m.nick = c.nick;
      const initial = initialOf(c.nick);
      m.labelName.textContent = short ? initial : c.nick;
      m.badge.textContent = initial;
    }
    const close = c.dist < CLOSE_DIM;
    if (close !== m.close) {
      m.close = close;
      m.label.style.opacity = close ? '0.45' : '';
    }

    const p = c.pos;
    const len = p.length() || 1;
    _v.copy(p).multiplyScalar((len + LABEL_LIFT) / len).project(camera);
    const occluded = segmentHitsSphere(camera.position, p.x, p.y, p.z, OCCLUDE_RADIUS_PLANE);
    const onScreen = !occluded && _v.z < 1 && _v.z > -1
      && Math.abs(_v.x) < 0.96 && Math.abs(_v.y) < 0.96;

    if (onScreen) {
      m.setOn(true);
      m.setMode(false, false);
      m.moveTo((_v.x * 0.5 + 0.5) * W, (-_v.y * 0.5 + 0.5) * H);
    } else if (frame.alive || killer) {
      m.setOn(true);
      m.setMode(true, occluded);
      this._placeOnEdge(m, p.x, p.y, p.z, f);
    } else {
      m.setOn(false);
      return;
    }
    m.setDistance(c.dist, now);
  }

  _placeTarget(target, frame, camera, W, H, now, f) {
    const m = this._target;
    if (!target) { m.setOn(false); return; }
    if (target.theta !== this._targetTheta || target.phi !== this._targetPhi) {
      // La quota del terreno vero sotto il bersaglio, non il raggio 50 fisso.
      this._targetTheta = target.theta;
      this._targetPhi = target.phi;
      this._targetR = surfaceRadiusSpherical(target.theta, target.phi) + 0.3;
      const c = sphericalToCartesian(target.theta, target.phi, this._targetR);
      _targetPos.set(c.x, c.y, c.z);
      m.textAt = -Infinity;
    }
    const p = _targetPos;
    _v.copy(p).project(camera);
    // Per un punto a terra la sfera di prova sta poco sotto il punto stesso:
    // visibile se la linea di vista non scende sotto l'orizzonte.
    const occluded = segmentHitsSphere(camera.position, p.x, p.y, p.z, this._targetR - 1.2);
    const onScreen = !occluded && _v.z < 1 && _v.z > -1
      && Math.abs(_v.x) < 0.94 && Math.abs(_v.y) < 0.94;
    if (onScreen) {
      m.setOn(true);
      m.setMode(false, false);
      m.moveTo((_v.x * 0.5 + 0.5) * W, (-_v.y * 0.5 + 0.5) * H);
    } else if (frame.alive) {
      m.setOn(true);
      m.setMode(true, occluded);
      this._placeOnEdge(m, p.x, p.y, p.z, f);
    } else {
      m.setOn(false);
      return;
    }
    m.setDistance(_localPos.distanceTo(p), now);
  }

  /**
   * Direzione "dritto davanti" a schermo, una volta per frame: un punto poco
   * avanti all'aereo lungo la rotta, proiettato. Con la camera dietro è quasi
   * sempre "su"; in virata la camera rolla e la direzione ne tiene conto.
   */
  _computeAhead(camera, W, H, f) {
    this._aheadX = 0;
    this._aheadY = -1;
    _v.copy(_localPos).project(camera);
    _w.set(
      _localPos.x + f.dx * TURN_PROBE,
      _localPos.y + f.dy * TURN_PROBE,
      _localPos.z + f.dz * TURN_PROBE,
    ).project(camera);
    if (_v.z >= 1 || _w.z >= 1) return;
    const sx = (_w.x - _v.x) * W, sy = -(_w.y - _v.y) * H;
    const l = Math.hypot(sx, sy);
    if (l < 1e-3) return;
    this._aheadX = sx / l;
    this._aheadY = sy / l;
  }

  /**
   * Freccia verso dove virare: la rotta relativa del bersaglio (0 = dritto,
   * positiva = a destra, ±π = alle spalle) applicata alla direzione "davanti"
   * dello schermo. Su = dritto, destra = vira a destra, giù = alle spalle.
   * La posizione sull'ellisse si decide dopo, tutte insieme (_layoutEdges).
   */
  _placeOnEdge(m, x, y, z, f) {
    const rel = relativeBearing(f, x, y, z);
    const c = Math.cos(rel), s = Math.sin(rel);
    // Rotazione in senso orario nello schermo (y verso il basso).
    const dx = this._aheadX * c - this._aheadY * s;
    const dy = this._aheadX * s + this._aheadY * c;
    m.edgeAngle = Math.atan2(dy, dx);
    m.pointTo(Math.atan2(dx, -dy) * (180 / Math.PI));
    if (this._edgeN < this._edgeList.length) this._edgeList[this._edgeN++] = m;
  }

  /**
   * Piazza le frecce sull'ellisse, allargando quelle troppo vicine: con più
   * bersagli nella stessa direzione i badge si coprivano l'un l'altro. La
   * punta resta comunque orientata sulla direzione vera.
   */
  _layoutEdges(W, H) {
    const list = this._edgeList;
    const n = this._edgeN;
    for (let i = 1; i < n; i++) {
      const m = list[i];
      let j = i;
      while (j > 0 && list[j - 1].edgeAngle > m.edgeAngle) { list[j] = list[j - 1]; j--; }
      list[j] = m;
    }
    let prev = -Infinity;
    for (let i = 0; i < n; i++) {
      const m = list[i];
      const a = Math.max(m.edgeAngle, prev + EDGE_MIN_SEP);
      prev = a;
      const ca = Math.cos(a), sa = Math.sin(a);
      const t = 1 / Math.sqrt((ca / this._ax) ** 2 + (sa / this._ay) ** 2);
      m.moveTo(W * 0.5 + ca * t, H * 0.5 + sa * t);
    }
  }

  /**
   * Semiassi dell'ellisse delle frecce. Più stretta dei bordi: così le frecce
   * non finiscono su radar, classifica, pillole e comandi touch, e restano
   * nella visione periferica vicino al mirino.
   */
  _updateEllipse(W, H) {
    if (W === this._lastW && H === this._lastH) return;
    this._lastW = W;
    this._lastH = H;
    this._isMobile = document.body.classList.contains('is-mobile');
    const insetX = this._isMobile ? Math.min(200, W * 0.24) : Math.min(250, W * 0.2);
    const insetY = this._isMobile ? 62 : 96;
    this._ax = Math.max(60, W * 0.5 - insetX);
    this._ay = Math.max(60, H * 0.5 - insetY);
    // Cambio di layout: le etichette vanno riscritte (nome intero o iniziale).
    for (const m of this._slots) m.short = null;
  }
}
