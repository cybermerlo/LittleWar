import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';

const bombGeo = new THREE.SphereGeometry(0.35, 7, 7);
const bombMat = new THREE.MeshLambertMaterial({ color: 0x222222, flatShading: true });

export class BombEntity {
  constructor(scene, id, theta, phi, altitude) {
    this.id = id;
    this.mesh = new THREE.Mesh(bombGeo, bombMat);
    scene.add(this.mesh);
    this.update(theta, phi, altitude);
  }

  update(theta, phi, altitude) {
    const pos = sphericalToCartesian(theta, phi, altitude);
    this.mesh.position.set(pos.x, pos.y, pos.z);
  }

  dispose(scene) {
    scene.remove(this.mesh);
  }
}

// Piccola esplosione visiva (flash di sfere che si espandono)
export function spawnExplosion(scene, theta, phi, radius, color = 0xff6600) {
  const pos = sphericalToCartesian(theta, phi, radius);
  const group = new THREE.Group();
  group.position.set(pos.x, pos.y, pos.z);

  const shards = 8;
  for (let i = 0; i < shards; i++) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.15 + Math.random() * 0.2, 4, 4),
      new THREE.MeshBasicMaterial({ color }),
    );
    const a = (i / shards) * Math.PI * 2;
    mesh.position.set(Math.cos(a) * 0.5, Math.random() * 0.5, Math.sin(a) * 0.5);
    group.add(mesh);
  }
  scene.add(group);

  let elapsed = 0;
  const animate = () => {
    elapsed += 16;
    const t = elapsed / 600;
    group.scale.setScalar(1 + t * 4);
    group.children.forEach(c => { c.material.opacity = Math.max(0, 1 - t); c.material.transparent = true; });
    if (t < 1) requestAnimationFrame(animate);
    else scene.remove(group);
  };
  requestAnimationFrame(animate);
}
