import * as THREE from 'three';
import { Airplane } from '../entities/Airplane.js';
import { moveOnSphere } from '../utils/SphereUtils.js';
import { BASE_SPEED, BOOST_SPEED_MULT } from '../../shared/constants.js';
import {
  makeFlightFrame, fillFlightFrame, relativeBearing, angleFrom, forwardFromQuaternion,
} from '../systems/hud/hudMath.js';

/**
 * Lobby "dal vivo": dietro al pannello il pianeta vero ruota lentamente e ci
 * vola sopra uno Spitfire col pilota automatico, nel colore scelto.
 *
 * Prima, in lobby, il loop disegnava tutta la scena col bloom a DPR pieno e a
 * 60 fps, con la camera che guardava il cielo, sotto un gradiente CSS opaco:
 * GPU spesa per non mostrare niente. Ora si disegna qualcosa che si vede, a
 * 30 fps (24 in qualità bassa) e a DPR ≤ 1, e niente del tutto finché il
 * mondo non è pronto (la copertura CSS è ancora opaca).
 *
 * Due inquadrature che si alternano senza tagli: orbita larga attorno al
 * pianeta e inseguimento largo dell'aereo dimostrativo. Il pianeta è spostato
 * a sinistra con un view offset della camera (niente distorsione), da togliere
 * all'ingresso in partita. Premendo GIOCA la camera plana dall'orbita fino
 * dietro al proprio aereo, su un arco che non attraversa il pianeta.
 *
 * L'aereo dimostrativo è remoto (isLocal = false): non prende slot del
 * LightPool, che servono all'aereo vero.
 */

const ORBIT_RADIUS = 125;
const ORBIT_SPEED = 0.06;          // rad/s
const ORBIT_SPEED_REDUCED = 0.01;  // prefers-reduced-motion
const ORBIT_ELEV = 25 * Math.PI / 180;
const ORBIT_ELEV_SWING = 10 * Math.PI / 180;
const SHOT_ORBIT_S = 14;
const SHOT_CHASE_S = 9;
const CHASE_BACK = 20;
const CHASE_UP = 7;
const CAM_MIN_RADIUS = 62;         // la camera non scende mai sotto: vette a 55, aerei a 56
/** Raggio che il pianeta con l'atmosfera deve occupare nell'inquadratura. */
const PLANET_FIT_RADIUS = 64;
/** Lontano da qui l'aereo dimostrativo vira verso il lato inquadrato. */
const DEMO_LEASH = 0.55;           // rad
const DEMO_BOOST_EVERY = 9;        // s
const DEMO_BOOST_FOR = 1.5;        // s
const BOARD_S = 1.3;               // durata della planata verso il proprio aereo
const BOARD_BACK = 14;             // come CameraController (dietro, sopra)
const BOARD_UP = 4.5;

const _target = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _orbitDir = new THREE.Vector3();
const _dirA = new THREE.Vector3();
const _dirB = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qPath = new THREE.Quaternion();
const _qStep = new THREE.Quaternion();
const _qId = new THREE.Quaternion();
const _f3 = { x: 0, y: 0, z: 0 };

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class LobbyAttract {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {object}   [o.shadows]         PlaneShadows: ombra dell'aereo dimostrativo
   * @param {boolean}  [o.lowQuality]
   * @param {Function} [o.setRenderScale]  (dpr) → cambia la risoluzione di rendering
   * @param {number}   [o.lobbyDpr]        risoluzione in lobby
   * @param {Function} [o.getGameDpr]      () → risoluzione da ripristinare in partita
   */
  constructor({ scene, camera, shadows = null, lowQuality = false, setRenderScale = null, lobbyDpr = 1, getGameDpr = null }) {
    this.scene = scene;
    this.camera = camera;
    this.shadows = shadows;
    this.setRenderScale = setRenderScale;
    this.lobbyDpr = lobbyDpr;
    this.getGameDpr = getGameDpr;
    this.fps = lowQuality ? 24 : 30;
    this.reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.color = '#ff0000';
    this.running = false;
    this.worldReady = false;
    this.demo = null;

    this._t = 0;
    this._acc = 0;
    this._snap = true;
    this._az = Math.random() * Math.PI * 2;
    this._orbitR = ORBIT_RADIUS;
    this._chase = false;
    this._shotT = 0;
    this._demoT = 0;
    this._theta = Math.PI / 2;
    this._phi = 0;
    this._heading = 0;
    this._frame = makeFlightFrame();

    this._board = { active: false, t: 0, from: new THREE.Vector3(), fromQuat: new THREE.Quaternion() };
    /** Ultima posa della camera di lobby: la camera di gioco la sovrascrive nel frame d'ingresso. */
    this._lastPos = new THREE.Vector3();
    this._lastQuat = new THREE.Quaternion();
    this._offX = 0;
    this._offY = 0;

    window.addEventListener('resize', () => { if (this.running) this._applyViewOffset(); });
  }

  /** Colore scelto in lobby: l'aereo dimostrativo si ritinge subito. */
  setColor(color) {
    if (!color || color === this.color) return;
    this.color = color;
    if (!this.demo) return;
    // Airplane non sa cambiare colore: se ne crea uno nuovo nello stesso
    // punto. Stessi materiali, quindi nessuno shader da compilare.
    this.demo.dispose(this.scene);
    this._createDemo();
  }

  setWorldReady() { this.worldReady = true; }

  /** True durante la planata d'ingresso: l'HUD tiene spenti mirino e frecce. */
  get boarding() { return this._board.active; }

  /**
   * Da chiamare a ogni frame, dopo la camera di gioco e prima del render.
   * @param {number}  delta
   * @param {boolean} inGame
   * @param {number}  nightFactor
   * @param {object}  [local]  { airplane, alive } dell'aereo del giocatore
   * @returns {boolean} true se questo frame NON va disegnato (lobby a 30 fps)
   */
  frame(delta, inGame, nightFactor, local) {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    if (inGame) {
      if (this.running) this._leave();
      if (this._board.active) this._tickBoard(dt, local);
      return false;
    }
    if (!this.running) this._enter();
    this._tickLobby(dt, nightFactor);

    // Finché la copertura è opaca non si disegna nulla.
    if (!this.worldReady) return true;
    const interval = 1 / this.fps;
    this._acc += delta;
    if (this._acc + 0.004 < interval) return true;
    this._acc = Math.min(Math.max(0, this._acc - interval), interval);
    return false;
  }

  // ── Lobby ──────────────────────────────────────────────────────────────────

  _enter() {
    this.running = true;
    this._snap = true;
    this._acc = 0;
    this._shotT = 0;
    this._chase = false;
    this._board.active = false;
    this._orbitDirection(_orbitDir);
    // L'aereo parte sul lato inquadrato.
    this._theta = Math.acos(THREE.MathUtils.clamp(_orbitDir.y, -1, 1));
    this._phi = Math.atan2(_orbitDir.z, _orbitDir.x);
    this._heading = Math.random() * Math.PI * 2;
    this._createDemo();
    this._applyViewOffset();
    this.setRenderScale?.(this.lobbyDpr);
  }

  _leave() {
    this.running = false;
    if (this.demo) {
      this.demo.dispose(this.scene);
      this.demo = null;
    }
    this.setRenderScale?.(this.getGameDpr?.() ?? this.lobbyDpr);
    if (this.reducedMotion) {
      this.camera.clearViewOffset();
      return;
    }
    // Il view offset si scioglie durante la planata (vedi _tickBoard).
    this._board.active = true;
    this._board.t = 0;
    this._board.from.copy(this._lastPos);
    this._board.fromQuat.copy(this._lastQuat);
  }

  _createDemo() {
    this.demo = new Airplane(this.scene, THREE, this.color, 'spitfire', false);
    this.demo.update(this._theta, this._phi, this._heading, 0, false, 1 / 60, 0);
  }

  /**
   * View offset: sposta il pianeta a sinistra (a colonna singola, in alto)
   * senza distorcere la prospettiva. Il raggio d'orbita si allarga quando la
   * finestra è stretta, perché il pianeta stia comunque nella larghezza.
   */
  _applyViewOffset() {
    const W = window.innerWidth, H = window.innerHeight;
    const cam = this.camera;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    this._orbitR = Math.max(ORBIT_RADIUS, PLANET_FIT_RADIUS / (tanHalf * (W / H)));
    // Stessa soglia della colonna singola in index.html.
    const singleColumn = (W <= 900 && H > W) || W <= 640;
    this._offX = singleColumn ? 0 : 0.17;
    this._offY = singleColumn ? 0.22 : 0;
    this._setOffset(1);
  }

  /** View offset scalato (1 = lobby, 0 = nessuno). */
  _setOffset(scale) {
    const W = window.innerWidth, H = window.innerHeight;
    if (scale <= 0) { this.camera.clearViewOffset(); return; }
    this.camera.setViewOffset(W, H, W * this._offX * scale, H * this._offY * scale, W, H);
  }

  _orbitDirection(out) {
    const el = ORBIT_ELEV + ORBIT_ELEV_SWING * Math.sin(this._t * 0.07);
    return out.set(Math.cos(el) * Math.cos(this._az), Math.sin(el), Math.cos(el) * Math.sin(this._az));
  }

  _tickLobby(dt, nightFactor) {
    this._t += dt;
    this._az += (this.reducedMotion ? ORBIT_SPEED_REDUCED : ORBIT_SPEED) * dt;
    this._orbitDirection(_orbitDir);
    this._stepDemo(dt, nightFactor);

    this._shotT += dt;
    if (!this.reducedMotion && this._shotT > (this._chase ? SHOT_CHASE_S : SHOT_ORBIT_S)) {
      this._chase = !this._chase;
      this._shotT = 0;
    }

    const plane = this.demo?.mesh;
    if (this._chase && plane) {
      _up.copy(plane.position).normalize();
      forwardFromQuaternion(this.demo.sphereQuaternion, _f3);
      _fwd.set(_f3.x, _f3.y, _f3.z);
      _target.copy(plane.position).addScaledVector(_fwd, -CHASE_BACK).addScaledVector(_up, CHASE_UP);
      _look.copy(plane.position).addScaledVector(_fwd, 4);
    } else {
      _target.copy(_orbitDir).multiplyScalar(this._orbitR);
      _look.set(0, 0, 0);
      _up.set(0, 1, 0);
    }

    const cam = this.camera;
    if (this._snap) {
      this._snap = false;
      cam.position.copy(_target);
      _m.lookAt(cam.position, _look, _up);
      cam.quaternion.setFromRotationMatrix(_m);
    } else {
      // Passaggio morbido fra le inquadrature: lento subito dopo il cambio,
      // poi più stretto per non restare indietro all'aereo.
      const k = Math.min(1, this._shotT / 2.5);
      const rate = 0.9 + 2.6 * k * k;
      cam.position.lerp(_target, 1 - Math.exp(-rate * dt));
      if (cam.position.lengthSq() < CAM_MIN_RADIUS * CAM_MIN_RADIUS) cam.position.setLength(CAM_MIN_RADIUS);
      _m.lookAt(cam.position, _look, _up);
      _q.setFromRotationMatrix(_m);
      cam.quaternion.slerp(_q, 1 - Math.exp(-rate * 1.4 * dt));
    }

    this._lastPos.copy(cam.position);
    this._lastQuat.copy(cam.quaternion);

    if (plane && this.shadows) {
      this.shadows.begin(nightFactor);
      this.shadows.add(plane.position);
      this.shadows.end();
    }
  }

  /**
   * Pilota automatico: virate morbide (due seni non armonici) e, quando
   * l'aereo si allontana dal lato inquadrato, una virata verso di esso. Ogni
   * 9 s una raffica di boost per mostrare le particelle.
   */
  _stepDemo(dt, nightFactor) {
    if (!this.demo) return;
    this._demoT += dt;
    const t = this._demoT;
    let turn = 0.32 * Math.sin(t * 0.23) + 0.16 * Math.sin(t * 0.71 + 1.3);
    const f = fillFlightFrame(this._frame, this._theta, this._phi, this._heading);
    const away = angleFrom(f, _orbitDir.x, _orbitDir.y, _orbitDir.z);
    if (away > DEMO_LEASH) {
      const w = Math.min(1, (away - DEMO_LEASH) / 0.4);
      const rel = relativeBearing(f, _orbitDir.x, _orbitDir.y, _orbitDir.z);
      turn = turn * (1 - w) + THREE.MathUtils.clamp(rel * 1.2, -0.9, 0.9) * w;
    }
    this._heading += turn * dt;
    const boosting = (t % DEMO_BOOST_EVERY) > DEMO_BOOST_EVERY - DEMO_BOOST_FOR;
    const moved = moveOnSphere(this._theta, this._phi, this._heading, BASE_SPEED * (boosting ? BOOST_SPEED_MULT : 1) * dt);
    this._theta = moved.theta;
    this._phi = moved.phi;
    this._heading = moved.heading;
    this.demo.setNightFactor(nightFactor);
    this.demo.update(this._theta, this._phi, this._heading, 0, false, dt, boosting ? 1 : 0);
  }

  // ── Ingresso in partita ────────────────────────────────────────────────────

  /**
   * Planata dall'orbita a dietro il proprio aereo. La posizione d'arrivo è
   * quella ideale della camera di inseguimento, calcolata qui: la camera di
   * gioco continua a girare sotto, e a fine planata riprende da dove siamo.
   * Direzione interpolata sulla sfera e raggio a parte, così il percorso non
   * taglia mai il pianeta. Intanto il view offset della lobby si scioglie: il
   * pianeta torna al centro senza scatti, e poiché l'offset sta nella matrice
   * di proiezione le proiezioni dell'HUD restano giuste anche a metà strada.
   */
  _tickBoard(dt, local) {
    const b = this._board;
    const plane = local?.airplane;
    if (!plane || !local.alive) {
      b.active = false;
      this._setOffset(0);
      return;
    }
    b.t += dt;
    const k = Math.min(1, b.t / BOARD_S);
    const e = easeInOutCubic(k);

    _offset.set(-BOARD_BACK, BOARD_UP, 0).applyQuaternion(plane.flightQuaternion);
    _target.copy(plane.mesh.position).add(_offset);
    _up.set(0, 1, 0).applyQuaternion(plane.sphereQuaternion);
    _m.lookAt(_target, plane.mesh.position, _up);
    _q.setFromRotationMatrix(_m);

    _dirA.copy(b.from).normalize();
    _dirB.copy(_target).normalize();
    _qPath.setFromUnitVectors(_dirA, _dirB);
    _qStep.copy(_qId).slerp(_qPath, e);
    const radius = THREE.MathUtils.lerp(b.from.length(), _target.length(), e);
    this.camera.position.copy(_dirA).applyQuaternion(_qStep).multiplyScalar(Math.max(CAM_MIN_RADIUS, radius));
    this.camera.quaternion.copy(b.fromQuat).slerp(_q, e);
    this._setOffset(1 - e);

    if (k >= 1) b.active = false;
  }
}
