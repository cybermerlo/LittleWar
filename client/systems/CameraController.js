import * as THREE from 'three';

const CAMERA_BACK   = 6.0;   // distanza dietro l'aereo
const CAMERA_UP     = 2.2;   // altezza sopra l'aereo
const LERP_FACTOR   = 0.08;

export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this._target = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
  }

  update(airplaneMesh) {
    if (!airplaneMesh) return;

    // "Dietro" l'aereo = asse -X locale dell'aereo (fusoliera va verso +X)
    const back = new THREE.Vector3(-1, 0, 0).applyQuaternion(airplaneMesh.quaternion);
    const up   = new THREE.Vector3( 0, 1, 0).applyQuaternion(airplaneMesh.quaternion);

    const desiredPos = airplaneMesh.position.clone()
      .addScaledVector(back, CAMERA_BACK)
      .addScaledVector(up,   CAMERA_UP);

    this.camera.position.lerp(desiredPos, LERP_FACTOR);

    this._lookAt.lerp(airplaneMesh.position, 0.12);
    this.camera.lookAt(this._lookAt);
  }
}
