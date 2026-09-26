import * as THREE from 'three';
import { CAMERA_BANK_FOLLOW } from '../../shared/constants.js';

const CAMERA_BACK = 14.0;  // unità dietro il naso (+X locale = avanti)
const CAMERA_UP   =  4.5;  // unità sopra l'asse del corpo
/**
 * Smorzamento esponenziale (1/s). Prima erano frazioni fisse per frame (0.07 e
 * 0.10): a 144 Hz la camera stava attaccata all'aereo, a 30 Hz lo inseguiva
 * con un ritardo più che doppio. Questi valori riproducono il comportamento
 * originale a 60 Hz, ma uguale a qualunque frame rate.
 */
const POS_RATE    = 4.35;
const ROT_RATE    = 6.3;
const ZOOM_MIN    = 7.0;
const ZOOM_MAX    = 28.0;
const ZOOM_STEP   = 1.2;
/**
 * Oltre questa distanza dal punto voluto la camera salta invece di inseguire.
 * Era 150, ma la camera sta a raggio ~62: la distanza massima possibile è
 * ~124, quindi lo scatto non avveniva mai e dopo un respawn la camera volava
 * in linea retta ATTRAVERSO il pianeta per quasi un secondo. Il respawn ora
 * chiama `snap()`; questa soglia resta come rete di sicurezza.
 */
const SNAP_DISTANCE = 40;

// FOV: l'inquadratura si allarga col boost (e di più con l'extreme boost).
const FOV_BOOST   = 6;
const FOV_EXTREME = 13;
const FOV_RATE    = 6;
const BOOST_BACK  = 0.10;  // +10% di distanza in boost

// Scossoni: "trauma" 0..1 che decade; l'ampiezza è trauma², così i colpi
// piccoli restano piccoli e quelli grossi si sentono davvero.
const TRAUMA_DECAY = 1.6;  // 1/s
const SHAKE_YAW    = 0.035;
const SHAKE_PITCH  = 0.035;
const SHAKE_ROLL   = 0.05;
// Due seni a frequenze incommensurabili per asse: rumore senza allocazioni.
const SHAKE_F1 = [23.1, 27.7, 19.3];
const SHAKE_F2 = [37.3, 31.9, 41.7];
const SHAKE_P  = [0.0, 1.7, 3.1];

// Camera della morte
const DEATH_DISTANCE   = 24;
const DEATH_ORBIT_RATE = 0.25; // rad/s
const DEATH_LOOK_DELAY = 0.9;  // s prima di girarsi verso chi ha sparato
const DEATH_KILLER_MAX = 90;   // oltre, il killer non si cerca (dietro l'orizzonte)

// Oggetti riusabili — evita GC pressure nel loop
const _offset     = new THREE.Vector3();
const _targetPos  = new THREE.Vector3();
const _worldUp    = new THREE.Vector3();
const _lookAt     = new THREE.Vector3();
const _lookMat    = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();
const _upSphere   = new THREE.Vector3();
const _upFull     = new THREE.Vector3();
const _q          = new THREE.Quaternion();
const _euler      = new THREE.Euler();

function prefersReducedMotion() {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

function shakeNoise(t, axis) {
  return 0.6 * Math.sin(t * SHAKE_F1[axis] + SHAKE_P[axis])
       + 0.4 * Math.sin(t * SHAKE_F2[axis] + SHAKE_P[axis] * 2.3);
}

export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this._ready  = false;
    this._cameraBack = CAMERA_BACK;
    /**
     * Stato smorzato della camera, separato da camera.position/quaternion:
     * lo scossone si applica sopra e non deve rientrare nel filtro, altrimenti
     * verrebbe "inseguito" e allungato dallo smorzamento.
     */
    this._pos = new THREE.Vector3().copy(camera.position);
    this._quat = new THREE.Quaternion().copy(camera.quaternion);

    const reduced = prefersReducedMotion();
    /** Moltiplicatore degli scossoni (main lo abbassa col giroscopio). */
    this.shakeScale = 1;
    this._motionScale = reduced ? 0.3 : 1;
    this._fovKick = !reduced;
    this._baseFov = camera.fov;
    this._fov = camera.fov;
    this._boost = 0;
    this._extreme = 0;
    this._trauma = 0;
    this._shakeT = 0;

    this._death = false;
    this._deathT = 0;
    this._deathCenter = new THREE.Vector3();
    this._deathOffset = new THREE.Vector3();
    this._deathLook = new THREE.Vector3();
    this._deathLen0 = CAMERA_BACK;
    this._deathKiller = null;

    this._onWheel = (e) => {
      // deltaY > 0: rotella giù (allontana), deltaY < 0: avvicina
      const dir = Math.sign(e.deltaY);
      if (!dir) return;
      this._cameraBack = THREE.MathUtils.clamp(
        this._cameraBack + dir * ZOOM_STEP,
        ZOOM_MIN,
        ZOOM_MAX,
      );
      e.preventDefault();
    };
    window.addEventListener('wheel', this._onWheel, { passive: false });
  }

  /** Il prossimo update salta direttamente in posizione (respawn, teletrasporto). */
  snap() {
    this._ready = false;
  }

  /** Scossone: si somma a quello in corso, fino a 1. */
  addTrauma(amount) {
    this._trauma = Math.min(1, this._trauma + Math.max(0, amount));
  }

  /**
   * @param {THREE.Object3D} airplaneMesh
   * @param {THREE.Quaternion} [sphereQuaternion] orientamento senza banking (per mescolare il roll sulla camera)
   * @param {THREE.Quaternion} [flightQuaternion] orientamento con banking ma senza spin
   * @param {number} [delta] secondi dall'ultimo frame
   * @param {number} [boost] 0..1, boost normale attivo
   * @param {boolean} [extreme] extreme boost attivo
   */
  update(airplaneMesh, sphereQuaternion, flightQuaternion, delta = 1 / 60, boost = 0, extreme = false) {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    if (!airplaneMesh) return;
    this._death = false;
    const followQuat = flightQuaternion ?? sphereQuaternion ?? airplaneMesh.quaternion;

    const kb = 1 - Math.exp(-FOV_RATE * dt);
    this._boost += (THREE.MathUtils.clamp(boost, 0, 1) - this._boost) * kb;
    this._extreme += ((extreme ? 1 : 0) - this._extreme) * kb;

    // ── 1. Posizione target ──────────────────────────────────────────────────
    // L'offset nel sistema locale dell'aereo è (-BACK, UP, 0):
    // -X perché il naso è +X, +Y perché "su" è Y locale.
    const back = this._cameraBack * (1 + BOOST_BACK * Math.max(this._boost, this._extreme) * this._motionScale);
    const upOffset = CAMERA_UP * (this._cameraBack / CAMERA_BACK);
    _offset.set(-back, upOffset, 0);
    _offset.applyQuaternion(followQuat); // → world space
    _targetPos.copy(airplaneMesh.position).add(_offset);

    if (isNaN(_targetPos.x)) return;

    const snapped = !this._ready || this._pos.distanceTo(_targetPos) > SNAP_DISTANCE;
    if (snapped) {
      this._pos.copy(_targetPos);
      this._ready = true;
    } else {
      this._pos.lerp(_targetPos, 1 - Math.exp(-POS_RATE * dt));
    }

    // ── 2. Orientamento camera ───────────────────────────────────────────────
    // Up della lookAt: mix tra "su" senza rollio (stabile sulla sfera) e "su"
    // con banking, così la camera sente l'inclinazione in virata ma resta più leggibile.
    _upSphere.set(0, 1, 0).applyQuaternion(sphereQuaternion ?? followQuat);
    _upFull.set(0, 1, 0).applyQuaternion(followQuat);
    _worldUp.lerpVectors(_upSphere, _upFull, CAMERA_BANK_FOLLOW).normalize();

    // Punto di mira = centro dell'aereo
    _lookAt.copy(airplaneMesh.position);

    // Matrix4.lookAt costruisce la matrice di rotazione corretta con il
    // vettore up fornito (a differenza di camera.lookAt che usa world up fisso)
    _lookMat.lookAt(this._pos, _lookAt, _worldUp);
    _targetQuat.setFromRotationMatrix(_lookMat);

    // Slerp del quaternione → rotazione fluida senza gimbal lock. Dopo uno
    // scatto di posizione anche l'orientamento salta: girarsi piano da
    // un'inquadratura di un altro emisfero vorrebbe dire guardare il vuoto.
    if (snapped) this._quat.copy(_targetQuat);
    else this._quat.slerp(_targetQuat, 1 - Math.exp(-ROT_RATE * dt));

    this._apply(dt);
  }

  /**
   * Camera della morte: si allontana dall'esplosione girandole attorno e,
   * dopo un attimo, si volta verso chi ha sparato (se è in vista).
   * @param {THREE.Vector3} center        punto dell'esplosione
   * @param {THREE.Object3D|null} killer  mesh dell'aereo che ha sparato
   */
  startDeathCam(center, killer = null) {
    this._death = true;
    this._deathT = 0;
    this._deathCenter.copy(center);
    this._deathOffset.copy(this._pos).sub(center);
    if (this._deathOffset.lengthSq() < 1e-4) this._deathOffset.copy(center).normalize().multiplyScalar(CAMERA_BACK);
    this._deathLen0 = this._deathOffset.length();
    this._deathLook.copy(center);
    this._deathKiller = killer;
  }

  /** Da chiamare a ogni frame mentre il giocatore è morto. */
  updateDeath(delta) {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    if (!this._death) {
      this._apply(dt);
      return;
    }
    this._deathT += dt;
    const t = this._deathT;
    const up = _upSphere.copy(this._deathCenter).normalize();

    // Orbita lenta attorno alla verticale del punto d'impatto.
    _q.setFromAxisAngle(up, DEATH_ORBIT_RATE * dt * this._motionScale);
    this._deathOffset.applyQuaternion(_q);
    // Mai sotto l'orizzonte locale: sopra di almeno un terzo della distanza.
    const len = this._deathOffset.length();
    const radial = this._deathOffset.dot(up);
    if (radial < 0.35 * len) this._deathOffset.addScaledVector(up, (0.35 * len - radial) * Math.min(1, dt * 3));
    const e = Math.min(1, t / 1.6);
    const targetLen = THREE.MathUtils.lerp(this._deathLen0, DEATH_DISTANCE, 1 - (1 - e) * (1 - e));
    this._deathOffset.setLength(targetLen);
    this._pos.copy(this._deathCenter).add(this._deathOffset);

    // Dopo un attimo si guarda verso il killer, senza perdere del tutto
    // l'esplosione: il punto di mira sta fra i due.
    _lookAt.copy(this._deathCenter);
    const k = this._deathKiller;
    if (t > DEATH_LOOK_DELAY && k?.visible && k.position.distanceTo(this._deathCenter) < DEATH_KILLER_MAX) {
      const w = THREE.MathUtils.smoothstep(t, DEATH_LOOK_DELAY, DEATH_LOOK_DELAY + 1.0) * 0.8;
      _lookAt.lerp(k.position, w);
    }
    this._deathLook.lerp(_lookAt, 1 - Math.exp(-3 * dt));

    _lookMat.lookAt(this._pos, this._deathLook, up);
    _targetQuat.setFromRotationMatrix(_lookMat);
    this._quat.slerp(_targetQuat, 1 - Math.exp(-ROT_RATE * 0.6 * dt));

    this._boost += (0 - this._boost) * (1 - Math.exp(-FOV_RATE * dt));
    this._extreme += (0 - this._extreme) * (1 - Math.exp(-FOV_RATE * dt));
    this._apply(dt);
  }

  /** Stato smorzato + FOV + scossone → camera vera. */
  _apply(dt) {
    const cam = this.camera;
    cam.position.copy(this._pos);
    cam.quaternion.copy(this._quat);

    this._trauma = Math.max(0, this._trauma - TRAUMA_DECAY * dt);
    this._shakeT += dt;
    if (this._shakeT > 1000) this._shakeT -= 1000;
    const shake = this._trauma * this._trauma * this.shakeScale * this._motionScale;
    if (shake > 1e-4) {
      const t = this._shakeT;
      // Solo rotazioni: spostare la camera farebbe tremare anche il sole
      // (lights.follow usa la posizione della camera) e i marcatori HUD.
      _euler.set(
        SHAKE_PITCH * shake * shakeNoise(t, 0),
        SHAKE_YAW * shake * shakeNoise(t, 1),
        SHAKE_ROLL * shake * shakeNoise(t, 2),
      );
      _q.setFromEuler(_euler);
      cam.quaternion.multiply(_q);
    }

    const target = this._baseFov + (this._fovKick ? FOV_BOOST * this._boost + FOV_EXTREME * this._extreme : 0);
    this._fov += (target - this._fov) * (1 - Math.exp(-FOV_RATE * dt));
    if (Math.abs(cam.fov - this._fov) > 0.01) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Distanza della camera da un punto (per dosare gli scossoni delle esplosioni). */
  distanceTo(point) {
    return this._pos.distanceTo(point);
  }

  destroy() {
    window.removeEventListener('wheel', this._onWheel);
  }
}
