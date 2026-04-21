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

// ── Esplosione: geometrie e materiali pre-allocati ────────────────────────────
// Geometrie con scale fisse — variazione visiva ottenuta con mesh.scale per
// evitare allocazioni BufferGeometry a runtime durante gli eventi di gioco.
const EXPL_SHARDS = 8;
const _explGeo = new THREE.SphereGeometry(0.25, 4, 4);
const _explScales = [0.6, 1.0, 0.7, 1.1, 0.8, 0.55, 0.9, 0.65]; // precalcolati
const _explOffsetY = [0.0, 0.3, 0.5, 0.1, 0.4, 0.2, 0.35, 0.15];

// Pool di gruppi esplosione riusabili (max 4 simultanée)
const EXPL_POOL_SIZE = 4;
const _explPool = Array.from({ length: EXPL_POOL_SIZE }, () => {
  const g = new THREE.Group();
  g.visible = false;
  for (let i = 0; i < EXPL_SHARDS; i++) {
    // Materiale separato per shard (opacity indipendente), transparent pre-impostato
    const mat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true });
    const mesh = new THREE.Mesh(_explGeo, mat);
    mesh.scale.setScalar(_explScales[i]);
    g.add(mesh);
  }
  return g;
});
let _explPoolIdx = 0;

export function spawnExplosion(scene, theta, phi, radius, color = 0xff6600) {
  const pos = sphericalToCartesian(theta, phi, radius);

  // Prendi il prossimo slot dal pool (round-robin: sovrascrive se troppo frequenti)
  const group = _explPool[_explPoolIdx % EXPL_POOL_SIZE];
  _explPoolIdx++;

  // Interrompi eventuale animazione precedente su questo slot
  group._cancelled = true;

  group.position.set(pos.x, pos.y, pos.z);
  group.scale.setScalar(1);
  group.visible = true;
  if (!group.parent) scene.add(group);

  for (let i = 0; i < EXPL_SHARDS; i++) {
    const mesh = group.children[i];
    const a = (i / EXPL_SHARDS) * Math.PI * 2;
    mesh.position.set(Math.cos(a) * 0.5, _explOffsetY[i], Math.sin(a) * 0.5);
    mesh.material.color.setHex(color);
    mesh.material.opacity = 1;
  }

  let elapsed = 0;
  group._cancelled = false;
  const animate = () => {
    if (group._cancelled) return;
    elapsed += 16;
    const t = elapsed / 600;
    group.scale.setScalar(1 + t * 4);
    const op = Math.max(0, 1 - t);
    for (const c of group.children) c.material.opacity = op;
    if (t < 1) requestAnimationFrame(animate);
    else group.visible = false;
  };
  requestAnimationFrame(animate);
}
