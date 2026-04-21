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

// Reused every frame — safe because JS is single-threaded
const _dir = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();

export class ProjectileEntity {
  /**
   * @param {THREE.Scene} scene
   * @param {string} id
   * @param {number} theta
   * @param {number} phi
   * @param {number} [altitude] - Raggio di rendering dal centro del pianeta.
   *        Default: FLY_ALTITUDE + 0.1 (quota degli aerei). I proiettili delle
   *        torrette passano la quota del tip del cannone per non apparire
   *        "sopra" il cannone al momento dello spawn.
   */
  constructor(scene, id, theta, phi, altitude = FLY_ALTITUDE + 0.1) {
    this.id = id;
    this._altitude = altitude;
    this.mesh = new THREE.Mesh(bulletGeo, bulletMat);
    this.mesh.scale.set(1, 1, 1.5);
    this.mesh.renderOrder = 3;
    this.prevPosition = new THREE.Vector3();
    this.currPosition = new THREE.Vector3();
    this.initialized = false;

    const trailPositions = new Float32Array(6);
    this._trailPositions = trailPositions;
    const trailAttr = new THREE.BufferAttribute(trailPositions, 3);
    trailAttr.usage = THREE.DynamicDrawUsage;
    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute('position', trailAttr);
    this.trail = new THREE.Line(this.trailGeometry, trailMat);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 2;

    scene.add(this.mesh);
    scene.add(this.trail);
    this.update(theta, phi);
  }

  update(theta, phi) {
    this.prevPosition.copy(this.currPosition);
    const pos = sphericalToCartesian(theta, phi, this._altitude);
    this.currPosition.set(pos.x, pos.y, pos.z);
    if (!this.initialized) {
      this.prevPosition.copy(this.currPosition);
      this.initialized = true;
    }
    this.mesh.position.copy(this.currPosition);

    _dir.subVectors(this.currPosition, this.prevPosition);
    if (_dir.lengthSq() > 1e-6) {
      _dir.normalize();
      _lookTarget.copy(_dir).multiplyScalar(0.22).add(this.currPosition);
      this.mesh.lookAt(_lookTarget);
      this.mesh.rotateX(Math.PI / 2);
    }

    const tp = this._trailPositions;
    tp[0] = this.currPosition.x;
    tp[1] = this.currPosition.y;
    tp[2] = this.currPosition.z;
    _lookTarget.copy(this.currPosition).sub(_dir.setLength(0.6));
    tp[3] = _lookTarget.x;
    tp[4] = _lookTarget.y;
    tp[5] = _lookTarget.z;
    this.trailGeometry.attributes.position.needsUpdate = true;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    scene.remove(this.trail);
    this.trailGeometry.dispose();
  }
}
