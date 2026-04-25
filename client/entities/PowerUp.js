import * as THREE from 'three';
import { createGLTFLoader } from '../utils/createGLTFLoader.js';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { FLY_ALTITUDE } from '../../shared/constants.js';

// Module-level reusables — no per-frame allocation
const _up       = new THREE.Vector3(0, 1, 0);
const _pNormal  = new THREE.Vector3();
const _spinAxis = new THREE.Vector3(0, 1, 0);
const _spinQuat = new THREE.Quaternion();

const loader = createGLTFLoader();

let multishotGltf = null;
let shieldGltf = null;
let speedGltf = null;

function loadPowerupTemplate(url, assign) {
  return loader.loadAsync(url)
    .then((gltf) => { assign(gltf); return gltf; })
    .catch(() => null);
}

const multishotPromise = loadPowerupTemplate('/models/Powerup_Multishot.glb', (gltf) => { multishotGltf = gltf; });
const shieldPromise = loadPowerupTemplate('/models/Powerup_Shield.glb', (gltf) => { shieldGltf = gltf; });
const speedPromise = loadPowerupTemplate('/models/Powerup_Speed.glb', (gltf) => { speedGltf = gltf; });

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
const FALLBACK_GEO = new THREE.BoxGeometry(0.7, 0.7, 0.7);
const FALLBACK_MATS = {
  weapon: new THREE.MeshLambertMaterial({ color: WEAPON_COLOR, flatShading: true }),
  shield: new THREE.MeshLambertMaterial({ color: SHIELD_COLOR, flatShading: true }),
  extreme_boost: new THREE.MeshLambertMaterial({ color: EXTREME_BOOST_COLOR, flatShading: true }),
};

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
        if (!this.root.parent) return;
        this._removeFallback();
        this._attachModel();
      });
    }
  }

  _addFallback() {
    this._fallback = new THREE.Mesh(FALLBACK_GEO, FALLBACK_MATS[this.type] ?? FALLBACK_MATS.weapon);
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
