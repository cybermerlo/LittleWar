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

// Oggetti riusabili — evita GC pressure nel loop
const _offset     = new THREE.Vector3();
const _targetPos  = new THREE.Vector3();
const _worldUp    = new THREE.Vector3();
const _lookAt     = new THREE.Vector3();
const _lookMat    = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();
const _upSphere   = new THREE.Vector3();
const _upFull     = new THREE.Vector3();

export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this._ready  = false;
    this._cameraBack = CAMERA_BACK;
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

  /**
   * @param {THREE.Object3D} airplaneMesh
   * @param {THREE.Quaternion} [sphereQuaternion] orientamento senza banking (per mescolare il roll sulla camera)
   * @param {THREE.Quaternion} [flightQuaternion] orientamento con banking ma senza spin
   * @param {number} [delta] secondi dall'ultimo frame
   */
  update(airplaneMesh, sphereQuaternion, flightQuaternion, delta = 1 / 60) {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    if (!airplaneMesh) return;
    const followQuat = flightQuaternion ?? sphereQuaternion ?? airplaneMesh.quaternion;

    // ── 1. Posizione target ──────────────────────────────────────────────────
    // L'offset nel sistema locale dell'aereo è (-BACK, UP, 0):
    // -X perché il naso è +X, +Y perché "su" è Y locale.
    const upOffset = CAMERA_UP * (this._cameraBack / CAMERA_BACK);
    _offset.set(-this._cameraBack, upOffset, 0);
    _offset.applyQuaternion(followQuat); // → world space
    _targetPos.copy(airplaneMesh.position).add(_offset);

    if (isNaN(_targetPos.x)) return;

    // Snap al primo frame o dopo un respawn lontano
    if (!this._ready || this.camera.position.distanceTo(_targetPos) > 150) {
      this.camera.position.copy(_targetPos);
      this._ready = true;
    } else {
      this.camera.position.lerp(_targetPos, 1 - Math.exp(-POS_RATE * dt));
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
    _lookMat.lookAt(this.camera.position, _lookAt, _worldUp);
    _targetQuat.setFromRotationMatrix(_lookMat);

    // Slerp del quaternione → rotazione fluida senza gimbal lock
    this.camera.quaternion.slerp(_targetQuat, 1 - Math.exp(-ROT_RATE * dt));
  }

  destroy() {
    window.removeEventListener('wheel', this._onWheel);
  }
}
