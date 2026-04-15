import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TREE_MODEL_URLS = [
  '/models/tree-pine.glb',
  '/models/tree-deciduous-a.glb',
  '/models/tree-deciduous-b.glb',
  '/models/tree-deciduous-c.glb',
  '/models/tree-deciduous-d.glb',
];

const BUILDING_MODEL_URLS = [
  '/models/building-house.glb',
];

const HOSPITAL_MODEL_URLS = [
  '/models/hospital.glb',
];

/** Altezza tipica in unità mondo (pianeta raggio ~50), allineata agli alberi procedurali precedenti */
const TREE_TEMPLATE_TARGET_SIZE = 1.65;
const BUILDING_TEMPLATE_TARGET_SIZE = 3.2;
const HOSPITAL_TEMPLATE_TARGET_SIZE = 4.0;

/**
 * Micro-spostamento lungo la normale locale del piano d'appoggio (dopo il fit a 4 punti).
 * Positivo = verso l'esterno dal pianeta.
 */
const BUILDING_HEIGHT_OFFSET = 0.7;

const _treeLoader = new GLTFLoader();
let _treeTemplatesPromise    = null;
let _buildingTemplatesPromise = null;
let _hospitalTemplatesPromise = null;

const _raycaster = new THREE.Raycaster();
const _rayOrigin = new THREE.Vector3();
const _rayDir    = new THREE.Vector3();
const _refAxis   = new THREE.Vector3();
const _lc        = new THREE.Vector3();
const RAY_START  = 85;

// Orienta un oggetto sulla sfera: "up" = verso l'esterno, "up world" = Y
function orientOnSphere(obj, pos, radialOffset = 0) {
  const up = pos.clone().normalize();
  obj.position.copy(pos).addScaledVector(up, radialOffset);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  obj.quaternion.copy(q);
  obj.rotateOnAxis(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
}

function raycastPlanetSurface(planetMesh, worldPointHint) {
  const dir = worldPointHint.clone().normalize();
  _rayOrigin.copy(dir).multiplyScalar(RAY_START);
  _rayDir.copy(dir).negate();
  _raycaster.set(_rayOrigin, _rayDir);
  const hits = _raycaster.intersectObject(planetMesh, false);
  return hits.length ? hits[0].point : null;
}

/** Normale poligono (Newell), coerente con l'ordine dei vertici. */
function polygonNormalNewell(p0, p1, p2, p3) {
  const n = new THREE.Vector3();
  const pts = [p0, p1, p2, p3];
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.normalize();
}

/**
 * Appoggia la base (piano Y=0 in locale) su un piano definito da 4 colpi sul terreno
 * agli angoli dell'impronta in pianta. La rotazione allinea X/Z alla griglia locale.
 */
function placeBuildingBaseOnTerrain(building, pos, planetMesh, radialOffset) {
  building.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(building);
  const hw = (box.max.x - box.min.x) * 0.5;
  const hd = (box.max.z - box.min.z) * 0.5;
  if (hw < 1e-4 || hd < 1e-4) {
    orientOnSphere(building, pos, radialOffset);
    return;
  }

  const yaw = Math.random() * Math.PI * 2;
  const up = pos.clone().normalize();
  _refAxis.set(Math.abs(up.y) < 0.9 ? 0 : 1, Math.abs(up.y) < 0.9 ? 1 : 0, 0);
  const t0 = new THREE.Vector3().crossVectors(up, _refAxis).normalize();
  const b0 = new THREE.Vector3().crossVectors(up, t0).normalize();
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const u = t0.clone().multiplyScalar(cos).add(b0.clone().multiplyScalar(sin));
  const v = t0.clone().multiplyScalar(-sin).add(b0.clone().multiplyScalar(cos));

  const c0 = pos.clone().addScaledVector(u, -hw).addScaledVector(v, -hd);
  const c1 = pos.clone().addScaledVector(u, hw).addScaledVector(v, -hd);
  const c2 = pos.clone().addScaledVector(u, hw).addScaledVector(v, hd);
  const c3 = pos.clone().addScaledVector(u, -hw).addScaledVector(v, hd);

  const p0 = raycastPlanetSurface(planetMesh, c0);
  const p1 = raycastPlanetSurface(planetMesh, c1);
  const p2 = raycastPlanetSurface(planetMesh, c2);
  const p3 = raycastPlanetSurface(planetMesh, c3);
  if (!p0 || !p1 || !p2 || !p3) {
    orientOnSphere(building, pos, radialOffset);
    return;
  }

  let n = polygonNormalNewell(p0, p1, p2, p3);
  if (n.dot(pos) < 0) n.negate();

  let xAxis = new THREE.Vector3().subVectors(p1, p0);
  xAxis.sub(n.clone().multiplyScalar(n.dot(xAxis)));
  if (xAxis.lengthSq() < 1e-10) {
    orientOnSphere(building, pos, radialOffset);
    return;
  }
  xAxis.normalize();
  const zAxis = new THREE.Vector3().crossVectors(xAxis, n).normalize();
  xAxis.crossVectors(n, zAxis).normalize();

  const rotMat = new THREE.Matrix4().makeBasis(xAxis, n, zAxis);
  const q = new THREE.Quaternion().setFromRotationMatrix(rotMat);

  const cornersLocal = [
    new THREE.Vector3(-hw, 0, -hd),
    new THREE.Vector3(hw, 0, -hd),
    new THREE.Vector3(hw, 0, hd),
    new THREE.Vector3(-hw, 0, hd),
  ];
  const hits = [p0, p1, p2, p3];
  const T = new THREE.Vector3();
  for (let k = 0; k < 4; k++) {
    _lc.copy(cornersLocal[k]).applyQuaternion(q);
    T.add(hits[k].clone().sub(_lc));
  }
  T.multiplyScalar(0.25);
  T.addScaledVector(n, radialOffset);

  building.position.copy(T);
  building.quaternion.copy(q);
}

/** Normalizza pivot (base al centro, suolo Y=0) e scala per un ingombro coerente col terreno */
function prepareTemplate(sourceScene, targetSize) {
  const root = sourceScene.clone(true);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const s = targetSize / maxDim;
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

function prepareTreeTemplate(sourceScene)     { return prepareTemplate(sourceScene, TREE_TEMPLATE_TARGET_SIZE); }
function prepareBuildingTemplate(sourceScene) { return prepareTemplate(sourceScene, BUILDING_TEMPLATE_TARGET_SIZE); }
function prepareHospitalTemplate(sourceScene) { return prepareTemplate(sourceScene, HOSPITAL_TEMPLATE_TARGET_SIZE); }

/**
 * Carica i modelli albero da /public/models. Risolve a un array di template pronti al clone;
 * in caso di errori parziali usa solo i file riusciti; se nessuno ok → array vuoto.
 */
function loadTemplates(urls, prepare) {
  return Promise.all(
    urls.map(
      (url) => new Promise((resolve) => {
        _treeLoader.load(
          url,
          (gltf) => { try { resolve(prepare(gltf.scene)); } catch { resolve(null); } },
          undefined,
          () => resolve(null),
        );
      }),
    ),
  ).then((roots) => roots.filter(Boolean));
}

export function loadTreeTemplates() {
  if (!_treeTemplatesPromise)
    _treeTemplatesPromise = loadTemplates(TREE_MODEL_URLS, prepareTreeTemplate);
  return _treeTemplatesPromise;
}

export function loadBuildingTemplates() {
  if (!_buildingTemplatesPromise)
    _buildingTemplatesPromise = loadTemplates(BUILDING_MODEL_URLS, prepareBuildingTemplate);
  return _buildingTemplatesPromise;
}

export function loadHospitalTemplates() {
  if (!_hospitalTemplatesPromise)
    _hospitalTemplatesPromise = loadTemplates(HOSPITAL_MODEL_URLS, prepareHospitalTemplate);
  return _hospitalTemplatesPromise;
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
function makeProceduralBuilding() {
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

function makeBuilding(buildingTemplates) {
  if (buildingTemplates.length > 0) {
    const template = buildingTemplates[Math.floor(Math.random() * buildingTemplates.length)];
    const inst = template.clone(true);
    const jitter = 0.85 + Math.random() * 0.3;
    inst.scale.multiplyScalar(jitter);
    return inst;
  }
  return makeProceduralBuilding();
}

function makeProceduralHospital() {
  const group = new THREE.Group();

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 1.2, 1.4),
    new THREE.MeshLambertMaterial({ color: 0xf2f2f2, flatShading: true }),
  );
  base.position.y = 0.6;

  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.18, 1.5),
    new THREE.MeshLambertMaterial({ color: 0xd9d9d9, flatShading: true }),
  );
  roof.position.y = 1.26;

  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.55, 0.08),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
  );
  sign.position.set(0, 1.05, 0.75);

  const crossMat = new THREE.MeshLambertMaterial({ color: 0xdd3333, flatShading: true });
  const crossA = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.10, 0.02), crossMat);
  const crossB = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.32, 0.02), crossMat);
  crossA.position.set(0, 0, 0.05);
  crossB.position.set(0, 0, 0.05);
  sign.add(crossA, crossB);

  group.add(base, roof, sign);
  return group;
}

function makeHospital(hospitalTemplates) {
  if (hospitalTemplates.length > 0) {
    const template = hospitalTemplates[Math.floor(Math.random() * hospitalTemplates.length)];
    const inst = template.clone(true);
    const jitter = 0.92 + Math.random() * 0.22;
    inst.scale.multiplyScalar(jitter);
    return inst;
  }
  return makeProceduralHospital();
}

/**
 * @param {THREE.Mesh}         planetMesh         - mesh terreno per raycast agli angoli della base
 * @param {THREE.Object3D[]} [treeTemplates]     - risultato di loadTreeTemplates()
 * @param {THREE.Object3D[]} [buildingTemplates] - risultato di loadBuildingTemplates()
 * @param {THREE.Object3D[]} [hospitalTemplates] - risultato di loadHospitalTemplates()
 */
export function createTerrain(scene, heightData, posAttr, planetMesh, treeTemplates = [], buildingTemplates = [], hospitalTemplates = []) {
  const terrainGroup = new THREE.Group();

  const count = posAttr.count;
  const indices = Array.from({ length: count }, (_, i) => i);

  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.abs(Math.sin(i * 9301 + 49297)) * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  let trees = 0, buildings = 0;
  const MAX_TREES = 180;
  const MAX_BUILDINGS = 80;
  const MAX_HOSPITALS = 12;
  let hospitals = 0;

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
    } else if ((buildings < MAX_BUILDINGS || hospitals < MAX_HOSPITALS) && h > 0.04 && h < 0.20) {
      const canPlaceHospital = hospitals < MAX_HOSPITALS && buildings > 6;
      const wantsHospital = canPlaceHospital && (Math.random() < 0.18) && (buildings < MAX_BUILDINGS);

      if (wantsHospital) {
        const hospital = makeHospital(hospitalTemplates);
        placeBuildingBaseOnTerrain(hospital, pos, planetMesh, BUILDING_HEIGHT_OFFSET);
        terrainGroup.add(hospital);
        hospitals++;
      } else if (buildings < MAX_BUILDINGS) {
        const building = makeBuilding(buildingTemplates);
        placeBuildingBaseOnTerrain(building, pos, planetMesh, BUILDING_HEIGHT_OFFSET);
        terrainGroup.add(building);
        buildings++;
      }
    }

    if (trees >= MAX_TREES && buildings >= MAX_BUILDINGS && hospitals >= MAX_HOSPITALS) break;
  }

  scene.add(terrainGroup);
  return terrainGroup;
}
