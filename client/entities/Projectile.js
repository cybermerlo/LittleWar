import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { FLY_ALTITUDE } from '../../shared/constants.js';

const bulletGeo = new THREE.CapsuleGeometry(0.07, 0.28, 4, 8);
const bulletMat = new THREE.MeshStandardMaterial({
  color: 0xffef9a,
  emissive: 0xffb53f,
  emissiveIntensity: 0.9,
  roughness: 0.45,
  metalness: 0.05,
});
const trailMat = new THREE.LineBasicMaterial({
  color: 0xffd36b,
  transparent: true,
  opacity: 0.42,
  depthWrite: false,
});

export class ProjectileEntity {
  constructor(scene, id, theta, phi) {
    this.id = id;
    this.mesh = new THREE.Mesh(bulletGeo, bulletMat);
    this.mesh.scale.set(1, 1, 1.5);
    this.mesh.renderOrder = 3;
    this.prevPosition = new THREE.Vector3();
    this.currPosition = new THREE.Vector3();
    this.initialized = false;

    this.trailGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.trail = new THREE.Line(this.trailGeometry, trailMat);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 2;

    scene.add(this.mesh);
    scene.add(this.trail);
    this.update(theta, phi);
  }

  update(theta, phi) {
    this.prevPosition.copy(this.currPosition);
    const pos = sphericalToCartesian(theta, phi, FLY_ALTITUDE + 0.1);
    this.currPosition.set(pos.x, pos.y, pos.z);
    if (!this.initialized) {
      this.prevPosition.copy(this.currPosition);
      this.initialized = true;
    }
    this.mesh.position.copy(this.currPosition);

    const dir = new THREE.Vector3().subVectors(this.currPosition, this.prevPosition);
    if (dir.lengthSq() > 1e-6) {
      dir.normalize();
      const up = dir.clone().multiplyScalar(0.22).add(this.currPosition);
      this.mesh.lookAt(up);
      this.mesh.rotateX(Math.PI / 2);
    }

    const trailStart = this.currPosition.clone();
    const trailEnd = this.currPosition.clone().sub(dir.setLength(0.6));
    this.trailGeometry.setFromPoints([trailStart, trailEnd]);
    this.trailGeometry.computeBoundingSphere();
  }

  dispose(scene) {
    scene.remove(this.mesh);
    scene.remove(this.trail);
    this.trailGeometry.dispose();
  }
}
