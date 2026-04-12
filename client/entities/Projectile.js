import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { FLY_ALTITUDE } from '../../shared/constants.js';

const bulletGeo = new THREE.SphereGeometry(0.18, 5, 5);
const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffee22 });

export class ProjectileEntity {
  constructor(scene, id, theta, phi) {
    this.id = id;
    this.mesh = new THREE.Mesh(bulletGeo, bulletMat);
    scene.add(this.mesh);
    this.update(theta, phi);
  }

  update(theta, phi) {
    const pos = sphericalToCartesian(theta, phi, FLY_ALTITUDE + 0.1);
    this.mesh.position.set(pos.x, pos.y, pos.z);
  }

  dispose(scene) {
    scene.remove(this.mesh);
  }
}
