import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { FLY_ALTITUDE } from '../../shared/constants.js';

const weaponGeo  = new THREE.BoxGeometry(0.7, 0.7, 0.7);
const shieldGeo  = new THREE.SphereGeometry(0.5, 8, 8);
const weaponMat  = new THREE.MeshLambertMaterial({ color: 0xffd700, flatShading: true });
const shieldMat  = new THREE.MeshLambertMaterial({ color: 0x44aaff, flatShading: true });

export class PowerUpEntity {
  constructor(scene, id, type, theta, phi) {
    this.id = id;
    this.type = type;
    this.theta = theta;
    this.phi = phi;

    const geo = type === 'weapon' ? weaponGeo : shieldGeo;
    const mat = type === 'weapon' ? weaponMat : shieldMat;
    this.mesh = new THREE.Mesh(geo, mat);
    scene.add(this.mesh);

    this._updatePosition();
  }

  _updatePosition() {
    const pos = sphericalToCartesian(this.theta, this.phi, FLY_ALTITUDE);
    this.mesh.position.set(pos.x, pos.y, pos.z);
  }

  tick(delta) {
    // Rotazione cosmetica
    this.mesh.rotation.y += delta * 1.5;
    // Pulsazione scala
    const t = performance.now() / 800;
    const scale = 1 + Math.sin(t) * 0.15;
    this.mesh.scale.setScalar(scale);
  }

  dispose(scene) {
    scene.remove(this.mesh);
  }
}
