import * as THREE from 'three';
import { sampleGroundSpherical, makeSurfaceHit, createConformingRingGeometry } from '../scene/planetSurface.js';

const RING_OUTER = 2.7;
const RING_INNER = 2.5;
const INNER_OUTER = 1.15;
const INNER_INNER = 1.0;

const _hit = makeSurfaceHit();

/**
 * Bersaglio del bombardamento.
 *
 * Gli anelli sono conformati al terreno renderizzato: un `TorusGeometry` piatto
 * appoggiato su un raggio fisso sprofondava nelle colline e restava sospeso
 * negli avvallamenti, perché la superficie visibile è fatta di facce piatte
 * larghe ~10 unità che si scostano anche di 1.7 unità dalla sfera ideale.
 */
export class TargetEntity {
  constructor(scene, theta, phi) {
    this.theta = theta;
    this.phi = phi;
    this._scene = scene;

    const hit = sampleGroundSpherical(theta, phi, _hit);
    const dir = hit.point.clone().normalize();

    this.group = new THREE.Group();
    this.group.position.copy(hit.point);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hit.normal);

    // Anelli in coordinate world → mesh fuori dal gruppo che ruota.
    this.ringMat  = new THREE.MeshBasicMaterial({ color: 0xff2222, side: THREE.DoubleSide, depthWrite: false });
    this.innerMat = new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide, depthWrite: false });

    this.ring  = new THREE.Mesh(createConformingRingGeometry(dir, RING_INNER, RING_OUTER, 48, 0.16), this.ringMat);
    this.inner = new THREE.Mesh(createConformingRingGeometry(dir, INNER_INNER, INNER_OUTER, 32, 0.16), this.innerMat);
    this.ring.renderOrder = 1;
    this.inner.renderOrder = 1;
    this.ring.matrixAutoUpdate = false;
    this.inner.matrixAutoUpdate = false;
    scene.add(this.ring, this.inner);

    // Puntino centrale: piccolo, resta agganciato al gruppo orientato.
    this.centerMat = new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide });
    const center = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16), this.centerMat);
    center.rotation.x = -Math.PI / 2;
    center.position.y = 0.18;
    this.center = center;
    this.group.add(center);
    scene.add(this.group);
  }

  tick() {
    this.group.rotation.y += 0.012; // lenta rotazione del puntino centrale
  }

  dispose(scene) {
    scene.remove(this.group, this.ring, this.inner);
    this.ring.geometry.dispose();
    this.inner.geometry.dispose();
    this.center.geometry.dispose();
    this.ringMat.dispose();
    this.innerMat.dispose();
    this.centerMat.dispose();
  }
}
