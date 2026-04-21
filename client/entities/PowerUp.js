import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { FLY_ALTITUDE } from '../../shared/constants.js';

// Module-level reusables — no per-frame allocation
const _up       = new THREE.Vector3(0, 1, 0);
const _pNormal  = new THREE.Vector3();
const _spinAxis = new THREE.Vector3(0, 1, 0);
const _spinQuat = new THREE.Quaternion();

const loader = new GLTFLoader();

let multishotGltf = null;
let shieldGltf = null;
let speedGltf = null;

const multishotPromise = loader.loadAsync('/models/Powerup_Multishot.glb').then(gltf => {
  multishotGltf = gltf;
});
const shieldPromise = loader.loadAsync('/models/Powerup_Shield.glb').then(gltf => {
  shieldGltf = gltf;
});
const speedPromise = loader.loadAsync('/models/Powerup_Speed.glb').then(gltf => {
  speedGltf = gltf;
});

function powerupModelPromise(type) {
  if (type === 'extreme_boost') return speedPromise;
  if (type === 'shield') return shieldPromise;
  return multishotPromise;
}

function powerupGltfForType(type) {
  if (type === 'extreme_boost') return speedGltf;
  if (type === 'shield') return shieldGltf;
  return multishotGltf;
}

// Fallback geometrico (stessi colori di prima)
const WEAPON_COLOR = new THREE.Color(0xffd700);
const SHIELD_COLOR = new THREE.Color(0x44aaff);
const EXTREME_BOOST_COLOR = new THREE.Color(0xff3300);

export class PowerUpEntity {
  constructor(scene, id, type, theta, phi) {
    this.id    = id;
    this.type  = type;
    this.theta = theta;
    this.phi   = phi;
    this._scene = scene;
    /** Rotazione intorno all'asse radiale (spin del collectible). */
    this._spinAngle = 0;

    this.root = new THREE.Object3D();
    scene.add(this.root);

    /** Orientamento base (Y locale = normale al pianeta) — calcolato una volta sola in _updatePosition(). */
    this._baseQuat = new THREE.Quaternion();
    this._updatePosition();

    const gltf = powerupGltfForType(type);
    if (gltf) {
      this._attachModel();
    } else {
      this._addFallback();
      powerupModelPromise(type).then(() => {
        this._removeFallback();
        this._attachModel();
      });
    }
  }

  _addFallback() {
    const geo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
    const mat = new THREE.MeshLambertMaterial({
      color: this.type === 'weapon' ? WEAPON_COLOR : this.type === 'extreme_boost' ? EXTREME_BOOST_COLOR : SHIELD_COLOR,
      flatShading: true,
    });
    this._fallback = new THREE.Mesh(geo, mat);
    this.root.add(this._fallback);
  }

  _removeFallback() {
    if (this._fallback) {
      this.root.remove(this._fallback);
      this._fallback = null;
    }
  }

  _attachModel() {
    const gltf = powerupGltfForType(this.type);
    if (!gltf || this._model) return;

    this._model = gltf.scene.clone(true);
    // Scala unica ragionevole per collectible in volo; modelli GLB hanno materiali originali.
    this._model.scale.setScalar(this.type === 'extreme_boost' ? 0.5 : 0.55);

    this.root.add(this._model);
  }

  _updatePosition() {
    const pos = sphericalToCartesian(this.theta, this.phi, FLY_ALTITUDE);
    this.root.position.set(pos.x, pos.y, pos.z);
    // Base orientation: Y locale allineato alla normale sferica.
    // Calcolato qui (raro) e riusato ogni frame in tick().
    _pNormal.set(pos.x, pos.y, pos.z).normalize();
    this._baseQuat.setFromUnitVectors(_up, _pNormal);
    this._applySpin();
  }

  _applySpin() {
    _spinQuat.setFromAxisAngle(_spinAxis, this._spinAngle);
    this.root.quaternion.copy(this._baseQuat).multiply(_spinQuat);
  }

  update(theta, phi) {
    this.theta = theta;
    this.phi = phi;
    this._updatePosition();
  }

  tick(delta) {
    this._spinAngle += delta * 1.8;
    this._applySpin(); // no setFromUnitVectors — base già calcolata in _updatePosition
    const t = performance.now() / 800;
    this.root.scale.setScalar(1 + Math.sin(t) * 0.15);
  }

  dispose(scene) {
    scene.remove(this.root);
  }
}
