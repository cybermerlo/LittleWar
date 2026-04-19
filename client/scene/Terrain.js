import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { surfaceAt, radiusAt, PLANET_RADIUS, heightAt01 } from './planetHeight.js';

const TREE_MODEL_URLS = [
  '/models/tree-pine.glb',
  '/models/alberello_lowpoly_rosso.glb',
  '/models/Tree_LowPoly_Yellow.glb',
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
 * Spostamento lungo la normale locale dopo l'appoggio sul terreno.
 * Positivo = verso l'esterno dal pianeta (edifici: dopo il fit a 4 punti sugli angoli).
 * Un valore per categoria così puoi correggere sink/float per modello.
 */
const TREE_GROUND_NORMAL_OFFSET = 0;
const BUILDING_GROUND_NORMAL_OFFSET = 0.6;
const HOSPITAL_GROUND_NORMAL_OFFSET = 0.2;

const _treeLoader = new GLTFLoader();
let _treeTemplatesPromise    = null;
let _buildingTemplatesPromise = null;
let _hospitalTemplatesPromise = null;

const _refAxis   = new THREE.Vector3();
const _lc        = new THREE.Vector3();
const _surfInfo  = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
const MAX_TREE_SLOPE     = 0.55; // scarta direzioni troppo ripide per gli alberi
const MAX_BUILDING_SLOPE = 0.28; // edifici: solo terreni quasi piatti

// ── Anti-compenetrazione edifici (stima footprint su sfera) ───────────────────
const BUILDING_CLEARANCE = 0.55;      // padding in unità mondo tra impronte
const MAX_BUILDING_TRIES = 28;        // tentativi per trovare una posizione libera

// ── Alberi: non si sovrappongono; padding piccolo + spawn vicini (foresta) ───
const TREE_CLEARANCE = 0.14;
/** Angolo massimo (rad) da un albero “genitore”; esponente < 1 favorisce vicinanza */
const TREE_CLUSTER_ANGLE_MAX = 0.2;
const TREE_ATTACH_PROB = 0.8;
const MAX_TREE_FILL_ATTEMPTS = 5200;

const _candDir = new THREE.Vector3();
const _forestT = new THREE.Vector3();
const _forestB = new THREE.Vector3();

// Orienta un oggetto usando la normale analitica della superficie: "up" =
// normale reale (non radiale), così l'albero segue l'inclinazione del pendio.
function orientOnSurface(obj, point, normal, radialOffset = 0) {
  obj.position.copy(point).addScaledVector(normal, radialOffset);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  obj.quaternion.copy(q);
  obj.rotateOnAxis(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
}

// Punto sulla superficie analitica lungo una direzione (usato per gli angoli
// della base degli edifici al posto del raycast sulla mesh a bassa risoluzione).
const _sampleDir = new THREE.Vector3();
function analyticSurfacePoint(dirHint, out) {
  _sampleDir.copy(dirHint).normalize();
  const r = radiusAt(_sampleDir.x, _sampleDir.y, _sampleDir.z);
  return out.copy(_sampleDir).multiplyScalar(r);
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
function placeBuildingBaseOnTerrain(building, pos, radialOffset) {
  building.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(building);
  const hw = (box.max.x - box.min.x) * 0.5;
  const hd = (box.max.z - box.min.z) * 0.5;

  const up = pos.clone().normalize();
  surfaceAt(up, _surfInfo);
  const fallbackPoint = _surfInfo.point.clone();
  const fallbackNormal = _surfInfo.normal.clone();

  if (hw < 1e-4 || hd < 1e-4) {
    orientOnSurface(building, fallbackPoint, fallbackNormal, radialOffset);
    return;
  }

  const yaw = Math.random() * Math.PI * 2;
  _refAxis.set(Math.abs(up.y) < 0.9 ? 0 : 1, Math.abs(up.y) < 0.9 ? 1 : 0, 0);
  const t0 = new THREE.Vector3().crossVectors(up, _refAxis).normalize();
  const b0 = new THREE.Vector3().crossVectors(up, t0).normalize();
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const u = t0.clone().multiplyScalar(cos).add(b0.clone().multiplyScalar(sin));
  const v = t0.clone().multiplyScalar(-sin).add(b0.clone().multiplyScalar(cos));

  const c0 = pos.clone().addScaledVector(u, -hw).addScaledVector(v, -hd);
  const c1 = pos.clone().addScaledVector(u,  hw).addScaledVector(v, -hd);
  const c2 = pos.clone().addScaledVector(u,  hw).addScaledVector(v,  hd);
  const c3 = pos.clone().addScaledVector(u, -hw).addScaledVector(v,  hd);

  const p0 = analyticSurfacePoint(c0, new THREE.Vector3());
  const p1 = analyticSurfacePoint(c1, new THREE.Vector3());
  const p2 = analyticSurfacePoint(c2, new THREE.Vector3());
  const p3 = analyticSurfacePoint(c3, new THREE.Vector3());

  let n = polygonNormalNewell(p0, p1, p2, p3);
  if (n.dot(pos) < 0) n.negate();

  let xAxis = new THREE.Vector3().subVectors(p1, p0);
  xAxis.sub(n.clone().multiplyScalar(n.dot(xAxis)));
  if (xAxis.lengthSq() < 1e-10) {
    orientOnSurface(building, fallbackPoint, fallbackNormal, radialOffset);
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

function estimateFootprintRadiusXZ(obj) {
  // Stima dell'impronta in pianta (XZ) usando la bounding box, prima di appoggiare sul terreno.
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const hw = Math.max((box.max.x - box.min.x) * 0.5, 0.01);
  const hd = Math.max((box.max.z - box.min.z) * 0.5, 0.01);
  // raggio del cerchio che contiene il rettangolo hw×hd
  return Math.sqrt(hw * hw + hd * hd);
}

function spherePlacementPad(footprintRadius) {
  return footprintRadius < 0.82 ? TREE_CLEARANCE : BUILDING_CLEARANCE;
}

function canPlaceOnSphere(dir, footprintRadius, placed, planetRadius) {
  const R = Math.max(planetRadius, 1e-6);
  for (const p of placed) {
    const sep = dir.angleTo(p.dir);
    const minSepAngle = (
      footprintRadius
      + p.footprintRadius
      + spherePlacementPad(footprintRadius)
      + spherePlacementPad(p.footprintRadius)
    ) / R;
    if (sep < minSepAngle) return false;
  }
  return true;
}

/** Direzione casuale in un cappello sferico attorno a parentDir (più probabile vicino al centro). */
function sampleBiasedForestDirection(parentDir, maxAngleRad, out) {
  out.copy(parentDir).normalize();
  _refAxis.set(Math.abs(out.y) < 0.9 ? 0 : 1, Math.abs(out.y) < 0.9 ? 1 : 0, 0);
  _forestT.crossVectors(out, _refAxis).normalize();
  _forestB.crossVectors(out, _forestT).normalize();
  const px = out.x, py = out.y, pz = out.z;
  const theta = Math.pow(Math.random(), 1.55) * maxAngleRad;
  const phi = Math.random() * Math.PI * 2;
  const c = Math.cos(theta), s = Math.sin(theta), cp = Math.cos(phi), sp = Math.sin(phi);
  out.set(
    px * c + _forestT.x * s * cp + _forestB.x * s * sp,
    py * c + _forestT.y * s * cp + _forestB.y * s * sp,
    pz * c + _forestT.z * s * cp + _forestB.z * s * sp,
  ).normalize();
  return out;
}

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
export function createTerrain(scene, heightData, posAttr, _planetMesh, treeTemplates = [], buildingTemplates = [], hospitalTemplates = []) {
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

  const placedBuildings = [];
  const placedTrees = [];
  const planetRadius = PLANET_RADIUS;

  function treeAndBuildingObstacles() {
    return placedTrees.length ? [...placedBuildings, ...placedTrees] : placedBuildings;
  }

  function dirFromIndex(idx) {
    const x = posAttr.getX(idx), y = posAttr.getY(idx), z = posAttr.getZ(idx);
    return new THREE.Vector3(x, y, z).normalize();
  }

  const scratchInfo = { point: new THREE.Vector3(), normal: new THREE.Vector3() };

  function tryPlaceBuildingLike(makeFn, placeFn, heightMin, heightMax) {
    const obj = makeFn();
    const footprint = estimateFootprintRadiusXZ(obj);

    for (let attempt = 0; attempt < MAX_BUILDING_TRIES; attempt++) {
      const idx = indices[Math.floor(Math.random() * indices.length)];
      const h = heightData[idx];
      if (h <= heightMin || h >= heightMax) continue;

      const dir = dirFromIndex(idx);
      surfaceAt(dir, scratchInfo);
      if (scratchInfo.slope > MAX_BUILDING_SLOPE) continue;
      if (!canPlaceOnSphere(dir, footprint, treeAndBuildingObstacles(), planetRadius)) continue;

      placeFn(obj, scratchInfo.point.clone());
      terrainGroup.add(obj);
      placedBuildings.push({ dir: dir.clone(), footprintRadius: footprint });
      return true;
    }

    return false;
  }

  for (const i of indices) {
    const h = heightData[i];
    const dir = dirFromIndex(i);

    if (trees < MAX_TREES && h > 0.08 && h < 0.45) {
      surfaceAt(dir, scratchInfo);
      if (scratchInfo.slope <= MAX_TREE_SLOPE) {
        const tree = makeTree(treeTemplates);
        const fp = estimateFootprintRadiusXZ(tree);
        if (canPlaceOnSphere(dir, fp, treeAndBuildingObstacles(), planetRadius)) {
          orientOnSurface(tree, scratchInfo.point, scratchInfo.normal, TREE_GROUND_NORMAL_OFFSET);
          terrainGroup.add(tree);
          placedTrees.push({ dir: dir.clone(), footprintRadius: fp });
          trees++;
        }
      }
    } else if ((buildings < MAX_BUILDINGS || hospitals < MAX_HOSPITALS) && h > 0.04 && h < 0.20) {
      const canPlaceHospital = hospitals < MAX_HOSPITALS && buildings > 6;
      const wantsHospital = canPlaceHospital && (Math.random() < 0.18) && (buildings < MAX_BUILDINGS);

      if (wantsHospital) {
        const ok = tryPlaceBuildingLike(
          () => makeHospital(hospitalTemplates),
          (obj, p) => placeBuildingBaseOnTerrain(obj, p, HOSPITAL_GROUND_NORMAL_OFFSET),
          0.04,
          0.20,
        );
        if (ok) hospitals++;
      } else if (buildings < MAX_BUILDINGS) {
        const ok = tryPlaceBuildingLike(
          () => makeBuilding(buildingTemplates),
          (obj, p) => placeBuildingBaseOnTerrain(obj, p, BUILDING_GROUND_NORMAL_OFFSET),
          0.04,
          0.20,
        );
        if (ok) buildings++;
      }
    }

    if (trees >= MAX_TREES && buildings >= MAX_BUILDINGS && hospitals >= MAX_HOSPITALS) break;
  }

  // Raggiungi MAX_TREES con molti spawn “attaccati” ad alberi esistenti (macchie forestali).
  let treeFillAttempts = 0;
  while (trees < MAX_TREES && treeFillAttempts < MAX_TREE_FILL_ATTEMPTS) {
    treeFillAttempts++;
    let dir;
    if (Math.random() < TREE_ATTACH_PROB && placedTrees.length > 0) {
      const seed = placedTrees[Math.floor(Math.random() * placedTrees.length)].dir;
      sampleBiasedForestDirection(seed, TREE_CLUSTER_ANGLE_MAX, _candDir);
      dir = _candDir;
    } else {
      dir = dirFromIndex(indices[Math.floor(Math.random() * indices.length)]);
    }

    const h01 = heightAt01(dir.x, dir.y, dir.z);
    if (h01 <= 0.08 || h01 >= 0.45) continue;
    surfaceAt(dir, scratchInfo);
    if (scratchInfo.slope > MAX_TREE_SLOPE) continue;

    const tree = makeTree(treeTemplates);
    const fp = estimateFootprintRadiusXZ(tree);
    if (!canPlaceOnSphere(dir, fp, treeAndBuildingObstacles(), planetRadius)) continue;

    orientOnSurface(tree, scratchInfo.point, scratchInfo.normal, TREE_GROUND_NORMAL_OFFSET);
    terrainGroup.add(tree);
    placedTrees.push({ dir: dir.clone(), footprintRadius: fp });
    trees++;
  }

  scene.add(terrainGroup);
  return terrainGroup;
}
