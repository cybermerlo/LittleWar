import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TREE_MODEL_URLS = [
  '/models/tree-pine.glb',
  '/models/tree-deciduous-a.glb',
  '/models/tree-deciduous-b.glb',
  '/models/tree-deciduous-c.glb',
  '/models/tree-deciduous-d.glb',
];

/** Altezza tipica in unità mondo (pianeta raggio ~50), allineata agli alberi procedurali precedenti */
const TREE_TEMPLATE_TARGET_SIZE = 1.65;

const _treeLoader = new GLTFLoader();
let _treeTemplatesPromise = null;

// Orienta un oggetto sulla sfera: "up" = verso l'esterno, "up world" = Y
function orientOnSphere(obj, pos) {
  const up = pos.clone().normalize();
  obj.position.copy(pos);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  obj.quaternion.copy(q);
  // Rotazione casuale attorno alla normale per varietà
  obj.rotateOnAxis(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
}

/** Normalizza pivot (base al centro, suolo Y=0) e scala per un ingombro coerente col terreno */
function prepareTreeTemplate(sourceScene) {
  const root = sourceScene.clone(true);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const s = TREE_TEMPLATE_TARGET_SIZE / maxDim;
  root.scale.setScalar(s);
  root.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(root);
  root.position.set(
    -(b2.min.x + b2.max.x) * 0.5,
    -b2.min.y,
    -(b2.min.z + b2.max.z) * 0.5,
  );
  return root;
}

/**
 * Carica i modelli albero da /public/models. Risolve a un array di template pronti al clone;
 * in caso di errori parziali usa solo i file riusciti; se nessuno ok → array vuoto.
 */
export function loadTreeTemplates() {
  if (_treeTemplatesPromise) return _treeTemplatesPromise;

  _treeTemplatesPromise = Promise.all(
    TREE_MODEL_URLS.map(
      (url) => new Promise((resolve) => {
        _treeLoader.load(
          url,
          (gltf) => {
            try {
              resolve(prepareTreeTemplate(gltf.scene));
            } catch {
              resolve(null);
            }
          },
          undefined,
          () => resolve(null),
        );
      }),
    ),
  ).then((roots) => roots.filter(Boolean));

  return _treeTemplatesPromise;
}

// ── Albero procedurale (fallback se i GLB non caricano) ───────────────────────
function makeProceduralTree() {
  const group = new THREE.Group();
  const trunkH = 0.5 + Math.random() * 0.4;
  const coneH  = 1.0 + Math.random() * 0.8;
  const coneR  = 0.4 + Math.random() * 0.3;

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.12, trunkH, 5),
    new THREE.MeshLambertMaterial({ color: 0x7a5230, flatShading: true }),
  );
  trunk.position.y = trunkH / 2;

  const green = new THREE.Color().setHSL(0.30 + Math.random() * 0.05, 0.7, 0.3 + Math.random() * 0.1);
  const leaves = new THREE.Mesh(
    new THREE.ConeGeometry(coneR, coneH, 6),
    new THREE.MeshLambertMaterial({ color: green, flatShading: true }),
  );
  leaves.position.y = trunkH + coneH / 2;

  group.add(trunk, leaves);
  return group;
}

function makeTree(treeTemplates) {
  if (treeTemplates.length > 0) {
    const template = treeTemplates[Math.floor(Math.random() * treeTemplates.length)];
    const inst = template.clone(true);
    const jitter = 0.78 + Math.random() * 0.5;
    inst.scale.multiplyScalar(jitter);
    return inst;
  }
  return makeProceduralTree();
}

// ── Edificio ──────────────────────────────────────────────────────────────────
function makeBuilding() {
  const w = 0.6 + Math.random() * 0.8;
  const h = 0.8 + Math.random() * 2.0;
  const d = 0.6 + Math.random() * 0.8;

  const palette = [0xd4b896, 0xc0c0c0, 0xe8d8c0, 0xa8b8c8, 0xf0e0d0];
  const col = palette[Math.floor(Math.random() * palette.length)];

  const building = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: col, flatShading: true }),
  );
  building.position.y = h / 2;

  if (Math.random() > 0.4) {
    const roofColor = new THREE.Color(col).multiplyScalar(0.75);
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(Math.max(w, d) * 0.75, 0.5, 4),
      new THREE.MeshLambertMaterial({ color: roofColor, flatShading: true }),
    );
    roof.position.y = h + 0.25;
    const group = new THREE.Group();
    group.add(building, roof);
    return group;
  }

  return building;
}

/**
 * @param {THREE.Object3D[]} [treeTemplates] - risultato di loadTreeTemplates(); se omesso usa solo procedurali
 */
export function createTerrain(scene, heightData, posAttr, treeTemplates = []) {
  const terrainGroup = new THREE.Group();

  const count = posAttr.count;
  const indices = Array.from({ length: count }, (_, i) => i);

  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.abs(Math.sin(i * 9301 + 49297)) * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  let trees = 0, buildings = 0;
  const MAX_TREES = 180;
  const MAX_BUILDINGS = 60;

  for (const i of indices) {
    const h = heightData[i];
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const pos = new THREE.Vector3(x, y, z);

    if (trees < MAX_TREES && h > 0.08 && h < 0.45) {
      const tree = makeTree(treeTemplates);
      orientOnSphere(tree, pos);
      terrainGroup.add(tree);
      trees++;
    } else if (buildings < MAX_BUILDINGS && h > 0.04 && h < 0.20) {
      const building = makeBuilding();
      orientOnSphere(building, pos);
      terrainGroup.add(building);
      buildings++;
    }

    if (trees >= MAX_TREES && buildings >= MAX_BUILDINGS) break;
  }

  scene.add(terrainGroup);
  return terrainGroup;
}
