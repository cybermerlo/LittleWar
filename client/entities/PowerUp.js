import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { FLY_ALTITUDE } from '../../shared/constants.js';

const loader = new GLTFLoader();
let starGltf = null;

// Pre-carica il modello una sola volta
const starPromise = loader.loadAsync('/models/Star.glb').then(gltf => {
  starGltf = gltf;
});

// Colori per tipo
const WEAPON_COLOR = new THREE.Color(0xffd700);
const SHIELD_COLOR = new THREE.Color(0x44aaff);

export class PowerUpEntity {
  constructor(scene, id, type, theta, phi) {
    this.id    = id;
    this.type  = type;
    this.theta = theta;
    this.phi   = phi;
    this._scene = scene;

    this.root = new THREE.Object3D();
    scene.add(this.root);

    this._updatePosition();

    if (starGltf) {
      this._attachModel();
    } else {
      // Fallback geometrico finché il modello non è pronto
      this._addFallback();
      starPromise.then(() => {
        this._removeFallback();
        this._attachModel();
      });
    }
  }

  _addFallback() {
    const geo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
    const mat = new THREE.MeshLambertMaterial({
      color: this.type === 'weapon' ? WEAPON_COLOR : SHIELD_COLOR,
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
    this._model = starGltf.scene.clone(true);
    this._model.scale.setScalar(0.55);

    const color = this.type === 'weapon' ? WEAPON_COLOR : SHIELD_COLOR;
    this._model.traverse(child => {
      if (child.isMesh) {
        child.material = child.material.clone();
        child.material.color.set(color);
        if (child.material.emissive) {
          child.material.emissive.set(color).multiplyScalar(0.25);
        }
      }
    });

    this.root.add(this._model);
  }

  _updatePosition() {
    const pos = sphericalToCartesian(this.theta, this.phi, FLY_ALTITUDE);
    this.root.position.set(pos.x, pos.y, pos.z);
    // Orienta la stella verso l'esterno della sfera (up = radiale)
    this.root.lookAt(0, 0, 0);
    this.root.rotateX(Math.PI); // corregge eventuale flip del modello
  }

  update(theta, phi) {
    this.theta = theta;
    this.phi = phi;
    this._updatePosition();
  }

  tick(delta) {
    this.root.rotation.y += delta * 1.8;
    const t = performance.now() / 800;
    const scale = 1 + Math.sin(t) * 0.15;
    this.root.scale.setScalar(scale);
  }

  dispose(scene) {
    scene.remove(this.root);
  }
}
