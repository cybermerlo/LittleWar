import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { PLANET_RADIUS } from '../../shared/constants.js';

export class TargetEntity {
  constructor(scene, theta, phi) {
    this.theta = theta;
    this.phi = phi;

    // Anello rosso sulla superficie
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.5, 0.2, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xff2222 }),
    );
    // Cerchio interno
    const inner = new THREE.Mesh(
      new THREE.TorusGeometry(1.0, 0.15, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xff8800 }),
    );
    // Centro puntino
    const center = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 16),
      new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide }),
    );

    this.group = new THREE.Group();
    this.group.add(ring, inner, center);
    scene.add(this.group);

    this._place();
  }

  _place() {
    const pos = new THREE.Vector3(...Object.values(
      sphericalToCartesian(this.theta, this.phi, PLANET_RADIUS + 0.3),
    ));
    this.group.position.copy(pos);

    // Orienta l'anello perpendicolare alla superficie (piano tangente)
    const up = pos.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    this.group.quaternion.copy(q);
  }

  tick() {
    this.group.rotation.z += 0.012; // rotazione lenta dell'anello
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}
