import * as THREE from 'three';
import { createGLTFLoader } from '../utils/createGLTFLoader.js';
import { terrainDensityScale, useDetailedTerrainModels } from '../utils/performanceProfile.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PLANET_RADIUS } from '../../shared/planetField.js';
import { sampleGround, makeSurfaceHit, fitGroundPlane } from './planetSurface.js';

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
 * Positivo = verso l'esterno dal pianeta.
 *
 * Ora che il piazzamento avviene sulla superficie *renderizzata* questi valori
 * servono solo per l'affondamento voluto (radici, fondamenta): non devono più
 * compensare l'errore tra mesh e campo analitico, che era di 0.28 unità in
 * media e fino a 1.74 — più dell'altezza di un albero intero.
 */
const TREE_GROUND_NORMAL_OFFSET = -0.05;      // radici appena dentro il terreno
const BUILDING_GROUND_NORMAL_OFFSET = -0.04;  // fondamenta a filo
const HOSPITAL_GROUND_NORMAL_OFFSET = -0.04;

const _treeLoader = createGLTFLoader();
let _treeTemplatesPromise    = null;
let _buildingTemplatesPromise = null;
let _hospitalTemplatesPromise = null;

const _refAxis   = new THREE.Vector3();
const MAX_TREE_SLOPE     = 0.55; // scarta direzioni troppo ripide per gli alberi
const MAX_BUILDING_SLOPE = 0.28; // edifici: solo terreni quasi piatti

/**
 * Dislivello massimo tollerato sotto la base di un edificio. Il piano
 * d'appoggio poggia sul punto più alto dell'impronta, quindi un terreno
 * accidentato lascerebbe un angolo sospeso in aria: oltre questa soglia il
 * sito viene scartato e se ne cerca un altro.
 */
const MAX_BUILDING_GROUND_GAP = 0.22;

/** Inclinazione massima di un albero rispetto alla verticale locale. */
const MAX_TREE_TILT = 0.42; // rad (~24°)

// ── Anti-compenetrazione edifici (stima footprint su sfera) ───────────────────
const BUILDING_CLEARANCE = 0.55;      // padding in unità mondo tra impronte
const MAX_BUILDING_TRIES = 28;        // tentativi per trovare una posizione libera

// ── Alberi: non si sovrappongono; padding piccolo + spawn vicini (foresta) ───
const TREE_CLEARANCE = 0.14;
/** Angolo massimo (rad) da un albero “genitore”; esponente < 1 favorisce vicinanza */
const TREE_CLUSTER_ANGLE_MAX = 0.2;
const TREE_ATTACH_PROB = 0.8;
const TERRAIN_DENSITY_SCALE = terrainDensityScale();
const USE_DETAILED_TERRAIN_MODELS = useDetailedTerrainModels();
const MAX_TREE_FILL_ATTEMPTS = Math.round(5200 * TERRAIN_DENSITY_SCALE);

const _candDir = new THREE.Vector3();
const _forestT = new THREE.Vector3();
const _forestB = new THREE.Vector3();

const _upAxis = new THREE.Vector3(0, 1, 0);
const _tiltQuat = new THREE.Quaternion();
const _tiltAxis = new THREE.Vector3();
const _clampedNormal = new THREE.Vector3();

/**
 * Limita l'inclinazione di una normale rispetto alla verticale locale.
 * Un albero perpendicolare a una faccia molto ripida sembrerebbe caduto.
 */
function clampTilt(normal, radial, maxAngle, out) {
  const dot = THREE.MathUtils.clamp(normal.dot(radial), -1, 1);
  const angle = Math.acos(dot);
  if (angle <= maxAngle) return out.copy(normal);
  _tiltAxis.crossVectors(radial, normal);
  if (_tiltAxis.lengthSq() < 1e-12) return out.copy(radial);
  _tiltAxis.normalize();
  _tiltQuat.setFromAxisAngle(_tiltAxis, maxAngle);
  return out.copy(radial).applyQuaternion(_tiltQuat).normalize();
}

/**
 * Appoggia un oggetto sul terreno renderizzato: "up" = normale della faccia su
 * cui poggia (con `flatShading` è esattamente il piano che l'occhio vede),
 * quindi l'oggetto risulta piantato e non sospeso né sepolto.
 */
function orientOnSurface(obj, point, normal, normalOffset = 0) {
  obj.position.copy(point).addScaledVector(normal, normalOffset);
  obj.quaternion.setFromUnitVectors(_upAxis, normal);
  obj.rotateOnAxis(_upAxis, Math.random() * Math.PI * 2);
}

/**
 * Appoggia la base (piano Y = 0 in locale) di una struttura sul terreno reale.
 *
 * Campiona l'impronta sulla mesh visibile, ricava la giacitura media e alza il
 * piano fino al campione più alto: la base non entra mai nel terreno. Se sotto
 * l'impronta resta un dislivello superiore a `MAX_BUILDING_GROUND_GAP`
 * restituisce `false` — il sito è troppo accidentato e il chiamante ne cerca
 * un altro invece di lasciare un edificio con un angolo per aria.
 *
 * @returns {boolean} true se l'edificio è stato appoggiato
 */
function placeBuildingBaseOnTerrain(building, dir, normalOffset, maxGap = MAX_BUILDING_GROUND_GAP) {
  building.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(building);
  const hw = Math.max((box.max.x - box.min.x) * 0.5, 1e-3);
  const hd = Math.max((box.max.z - box.min.z) * 0.5, 1e-3);

  const yaw = Math.random() * Math.PI * 2;
  const fit = fitGroundPlane(dir, hw, hd, yaw);
  if (fit.gap > maxGap) return false;

  // Base ortonormale DESTRORSA del piano d'appoggio, con X/Z ruotati di `yaw`.
  // L'ordine dei prodotti vettoriali non è arbitrario: con `z = n × x` la terna
  // (x, n, z) è mancina, `makeBasis` produce una riflessione e
  // `setFromRotationMatrix` ne ricava un quaternione privo di significato —
  // l'edificio finisce ruotato a caso e sepolto nel terreno.
  const n = fit.normal;
  _refAxis.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0);
  const xAxis = new THREE.Vector3().crossVectors(n, _refAxis).normalize();
  const zAxis = new THREE.Vector3().crossVectors(xAxis, n).normalize();
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const rotX = xAxis.clone().multiplyScalar(cos).addScaledVector(zAxis, sin);
  const rotZ = xAxis.clone().multiplyScalar(-sin).addScaledVector(zAxis, cos);

  building.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(rotX, n, rotZ),
  );
  building.position.copy(fit.origin).addScaledVector(n, normalOffset);
  return true;
}

/**
 * Prepara un template: dimensione coerente col terreno e **origine sulla base**,
 * al centro dell'impronta.
 *
 * L'origine sulla base è ciò che rende sensato scrivere `obj.position = punto
 * sul terreno`. Prima la normalizzazione veniva scritta nella `position` del
 * root del modello — ma sia `orientOnSurface` sia `placeBuildingBaseOnTerrain`
 * *sovrascrivono* quella stessa `position` per piazzare l'oggetto, quindi la
 * normalizzazione veniva buttata via a ogni piazzamento e i modelli finivano
 * appoggiati per la loro origine arbitraria: alberi e case sprofondati o
 * sospesi di oltre un'unità a seconda di dove l'artista aveva messo il pivot.
 * (I fallback procedurali non ne soffrivano, perché costruiscono già i figli
 * con la base a Y = 0 — per questo il difetto si vedeva solo in qualità alta.)
 *
 * Ora l'offset vive in un figlio e il root resta libero: `root.position` è
 * sempre e solo "dove poggia l'oggetto".
 */
function prepareTemplate(sourceScene, targetSize) {
  const model = sourceScene.clone(true);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const s = targetSize / maxDim;

  // Scalare anche la posizione mantiene omogenea la trasformazione del modello,
  // anche quando il glTF ha un'origine spostata.
  model.scale.multiplyScalar(s);
  model.position.multiplyScalar(s);
  model.updateMatrixWorld(true);

  const b2 = new THREE.Box3().setFromObject(model);
  model.position.x -= (b2.min.x + b2.max.x) * 0.5;
  model.position.y -= b2.min.y;
  model.position.z -= (b2.min.z + b2.max.z) * 0.5;

  const root = new THREE.Group();
  root.add(model);
  return root;
}

/**
 * Applica una variazione di dimensione conservando l'appoggio: il root ha
 * origine (0,0,0) sulla base, quindi scalarlo scala anche l'offset del modello
 * al suo interno e la base resta esattamente sull'origine.
 */
function applyScaleJitter(instance, jitter) {
  instance.scale.multiplyScalar(jitter);
  return instance;
}

/**
 * Incapsula un oggetto costruito a mano in un root la cui origine è il centro
 * della base, come per i template glTF.
 *
 * Serve perché il piazzamento assegna `root.position`: qualunque offset scritto
 * nella posizione dell'oggetto stesso verrebbe cancellato. Era il caso di
 * `makeProceduralBuilding`, che restituisce una Mesh con `position.y = h / 2`:
 * piazzata, finiva mezza sottoterra. Riguardava la qualità bassa — cioè proprio
 * le macchine meno potenti, dove i GLB non vengono usati.
 */
function withGroundOrigin(object) {
  const root = new THREE.Group();
  root.add(object);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  object.position.x -= (box.min.x + box.max.x) * 0.5;
  object.position.y -= box.min.y;
  object.position.z -= (box.min.z + box.max.z) * 0.5;
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
  if (!USE_DETAILED_TERRAIN_MODELS) return Promise.resolve([]);
  if (!_treeTemplatesPromise)
    _treeTemplatesPromise = loadTemplates(TREE_MODEL_URLS, prepareTreeTemplate);
  return _treeTemplatesPromise;
}

export function loadBuildingTemplates() {
  if (!USE_DETAILED_TERRAIN_MODELS) return Promise.resolve([]);
  if (!_buildingTemplatesPromise)
    _buildingTemplatesPromise = loadTemplates(BUILDING_MODEL_URLS, prepareBuildingTemplate);
  return _buildingTemplatesPromise;
}

export function loadHospitalTemplates() {
  if (!USE_DETAILED_TERRAIN_MODELS) return Promise.resolve([]);
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
  return withGroundOrigin(group);
}

function makeTree(treeTemplates) {
  if (USE_DETAILED_TERRAIN_MODELS && treeTemplates.length > 0) {
    const template = treeTemplates[Math.floor(Math.random() * treeTemplates.length)];
    return applyScaleJitter(template.clone(true), 0.78 + Math.random() * 0.5);
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
    return withGroundOrigin(group);
  }

  return withGroundOrigin(building);
}

function makeBuilding(buildingTemplates) {
  if (USE_DETAILED_TERRAIN_MODELS && buildingTemplates.length > 0) {
    const template = buildingTemplates[Math.floor(Math.random() * buildingTemplates.length)];
    return applyScaleJitter(template.clone(true), 0.85 + Math.random() * 0.3);
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
  return withGroundOrigin(group);
}

function makeHospital(hospitalTemplates) {
  if (USE_DETAILED_TERRAIN_MODELS && hospitalTemplates.length > 0) {
    const template = hospitalTemplates[Math.floor(Math.random() * hospitalTemplates.length)];
    return applyScaleJitter(template.clone(true), 0.92 + Math.random() * 0.22);
  }
  return makeProceduralHospital();
}

/**
 * Firma visiva di un materiale: due materiali con la stessa firma producono
 * pixel identici, quindi possono condividere la stessa draw call.
 *
 * I nove modelli GLB del terreno portano quasi 200 istanze di materiale
 * distinte, ma moltissime sono lo stesso "marrone corteccia" o lo stesso
 * "verde foglia" ripetuti da un albero all'altro: raggruppando per uuid si
 * pagavano ~194 draw call per disegnare una manciata di aspetti diversi.
 */
function materialSignature(m) {
  return [
    m.type,
    m.color?.getHexString() ?? '-',
    m.emissive?.getHexString() ?? '-',
    m.map?.uuid ?? '-',
    m.normalMap?.uuid ?? '-',
    m.emissiveMap?.uuid ?? '-',
    m.roughnessMap?.uuid ?? '-',
    m.metalnessMap?.uuid ?? '-',
    m.alphaMap?.uuid ?? '-',
    m.aoMap?.uuid ?? '-',
    m.roughness ?? '-',
    m.metalness ?? '-',
    m.opacity,
    m.transparent ? 1 : 0,
    m.flatShading ? 1 : 0,
    m.side,
    m.vertexColors ? 1 : 0,
    m.alphaTest,
    m.depthWrite ? 1 : 0,
    m.blending,
  ].join('|');
}

/**
 * Fonde tutte le mesh statiche del terreno raggruppandole per aspetto.
 * Riduce centinaia di draw call individuali (alberi, edifici, ospedali) a
 * poche decine — una per ogni aspetto realmente distinto.
 *
 * Object3D.clone() condivide geometry e material con il template originale, e
 * le normali vengono trasformate correttamente da applyMatrix4.
 *
 * NOTA — spezzare il merge in chunk spaziali per far funzionare il frustum
 * culling è stato provato e misurato: faceva salire le draw call del 26% per
 * risparmiare la metà di appena 48k triangoli, un pessimo scambio. Se un
 * giorno il terreno diventasse molto più pesante, la dedup dei materiali qui
 * sotto rende il chunking molto più conveniente di quanto lo fosse allora.
 */
function mergeStaticTerrain(group) {
  const byLook = new Map(); // firma → { material, geos[] }
  const keep = new Set(['position', 'normal', 'uv']);

  group.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (!obj.geometry || !obj.material || Array.isArray(obj.material)) return;

    obj.updateWorldMatrix(true, false);
    const geo = obj.geometry.clone();
    geo.applyMatrix4(obj.matrixWorld);

    // Rimuovi attributi non usati per ridurre memoria (es. uv2, color se
    // presenti) ma mantieni position/normal/uv, che servono ai materiali.
    for (const name of Object.keys(geo.attributes)) {
      if (!keep.has(name)) geo.deleteAttribute(name);
    }
    // mergeGeometries pretende lo stesso insieme di attributi in tutti i pezzi.
    if (!geo.getAttribute('uv')) {
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
    }

    const key = materialSignature(obj.material);
    if (!byLook.has(key)) byLook.set(key, { material: obj.material, geos: [] });
    byLook.get(key).geos.push(geo);
  });

  // Svuota il gruppo e aggiungi le mesh fuse
  group.clear();

  for (const { material, geos } of byLook.values()) {
    if (geos.length === 0) continue;
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.matrixAutoUpdate = false; // statico: niente ricalcolo matrice per frame
    mesh.updateMatrix();
    group.add(mesh);
  }
}

/**
 * Popola il pianeta di alberi, case e ospedali appoggiandoli sulla superficie
 * renderizzata (vedi `planetSurface.js`), non sul campo di altezza ideale.
 *
 * @param {THREE.Scene}            scene
 * @param {Float32Array}          _heightData         - non più usato: la quota si legge dalla mesh
 * @param {THREE.BufferAttribute}  posAttr            - vertici del pianeta, usati come semi di posizione
 * @param {THREE.Mesh}            _planetMesh         - non più usato (niente raycast sulla mesh)
 * @param {THREE.Object3D[]}      [treeTemplates]     - risultato di loadTreeTemplates()
 * @param {THREE.Object3D[]}      [buildingTemplates] - risultato di loadBuildingTemplates()
 * @param {THREE.Object3D[]}      [hospitalTemplates] - risultato di loadHospitalTemplates()
 */
export function createTerrain(scene, _heightData, posAttr, _planetMesh, treeTemplates = [], buildingTemplates = [], hospitalTemplates = []) {
  const terrainGroup = new THREE.Group();

  const count = posAttr.count;
  const indices = Array.from({ length: count }, (_, i) => i);

  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.abs(Math.sin(i * 9301 + 49297)) * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  let trees = 0, buildings = 0;
  const MAX_TREES = Math.max(45, Math.round(180 * TERRAIN_DENSITY_SCALE));
  const MAX_BUILDINGS = Math.max(18, Math.round(80 * TERRAIN_DENSITY_SCALE));
  const MAX_HOSPITALS = Math.max(3, Math.round(12 * TERRAIN_DENSITY_SCALE));
  let hospitals = 0;

  const placedBuildings = [];
  const placedTrees = [];
  const planetRadius = PLANET_RADIUS;

  /**
   * Diagnostica di appoggio, raccolta solo in sviluppo per la verifica
   * automatica (tests/visual-ground-check.mjs). Dopo il merge le singole mesh
   * non esistono più, quindi va registrata qui.
   *
   * Non basta l'origine del gruppo: quella è per definizione dove l'abbiamo
   * messa. Si misurano gli angoli inferiori del bounding box del modello, che
   * sono ciò che l'occhio vede toccare (o non toccare) il terreno.
   */
  const placements = [];
  const COLLECT_PLACEMENTS = !!import.meta.env?.DEV;
  const _vtx = new THREE.Vector3();
  const _vtxHit = makeSurfaceHit();
  const _localUp = new THREE.Vector3();
  const _localDelta = new THREE.Vector3();

  function recordPlacement(kind, obj) {
    if (!COLLECT_PLACEMENTS) return;
    obj.updateMatrixWorld(true);

    // Primo passaggio: il vertice più vicino al centro del pianeta.
    let minR = Infinity;
    const lowest = [];
    obj.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      const pos = child.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        _vtx.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(child.matrixWorld);
        const r = _vtx.length();
        if (r < minR) minR = r;
        lowest.push({ v: _vtx.clone(), r });
      }
    });
    if (!lowest.length) return;

    // Secondo passaggio: solo i candidati davvero bassi vengono confrontati col
    // terreno sottostante (una query di superficie costa, un vertice no).
    let worst = Infinity;
    for (const c of lowest) {
      if (c.r > minR + 0.6) continue;
      sampleGround(c.v, _vtxHit);
      worst = Math.min(worst, c.r - _vtxHit.radius);
    }

    // Quota del vertice più basso nel frame dell'oggetto. Se non è ~0 il
    // problema non è il terreno: o il modello non ha l'origine sulla base, o la
    // rotazione applicata non è quella che si crede — una terna mancina passata
    // a `makeBasis` è una riflessione, e da lì esce un quaternione senza senso.
    const localUp = _localUp.set(0, 1, 0).applyQuaternion(obj.quaternion);
    let localMinY = Infinity;
    for (const c of lowest) {
      localMinY = Math.min(localMinY, _localDelta.copy(c.v).sub(obj.position).dot(localUp));
    }

    placements.push({ kind, point: obj.position.clone(), baseDelta: worst, localMinY });
  }

  function treeAndBuildingObstacles() {
    return placedTrees.length ? [...placedBuildings, ...placedTrees] : placedBuildings;
  }

  function dirFromIndex(idx) {
    const x = posAttr.getX(idx), y = posAttr.getY(idx), z = posAttr.getZ(idx);
    return new THREE.Vector3(x, y, z).normalize();
  }

  /**
   * Direzione casuale in prossimità di un vertice della mesh. I vertici da
   * soli darebbero solo 2160 posizioni possibili, tutte su spigoli di
   * triangolo: gli alberi finirebbero allineati sul reticolo. Il jitter li
   * distribuisce sulle facce, dove ora sappiamo appoggiarli con precisione.
   */
  function jitteredDirNear(idx, spreadRad = 0.09) {
    const dir = dirFromIndex(idx);
    return sampleBiasedForestDirection(dir, spreadRad, new THREE.Vector3());
  }

  const scratchInfo = makeSurfaceHit();

  // Budget globale: appoggiare una base costa ~25 campionamenti del terreno.
  // Su un pianeta senza abbastanza pianure il ciclo potrebbe altrimenti
  // consumare secondi di caricamento cercando siti che non esistono.
  let fitBudget = Math.round(4000 * TERRAIN_DENSITY_SCALE);

  function tryPlaceBuildingLike(makeFn, normalOffset, heightMin, heightMax) {
    if (fitBudget <= 0) return false;
    const obj = makeFn();
    const footprint = estimateFootprintRadiusXZ(obj);

    for (let attempt = 0; attempt < MAX_BUILDING_TRIES && fitBudget > 0; attempt++) {
      const idx = indices[Math.floor(Math.random() * indices.length)];
      const dir = jitteredDirNear(idx);

      // Quota e pendenza vengono lette sulla superficie renderizzata: sono le
      // stesse che il giocatore vede, comprese le bande di colore del terreno.
      sampleGround(dir, scratchInfo);
      if (scratchInfo.height01 <= heightMin || scratchInfo.height01 >= heightMax) continue;
      if (scratchInfo.slope > MAX_BUILDING_SLOPE) continue;
      if (!canPlaceOnSphere(dir, footprint, treeAndBuildingObstacles(), planetRadius)) continue;
      fitBudget--;
      if (!placeBuildingBaseOnTerrain(obj, dir, normalOffset)) continue;

      terrainGroup.add(obj);
      placedBuildings.push({ dir: dir.clone(), footprintRadius: footprint });
      recordPlacement('building', obj);
      return true;
    }

    return false;
  }

  function tryPlaceTree(dir) {
    sampleGround(dir, scratchInfo);
    if (scratchInfo.height01 <= 0.08 || scratchInfo.height01 >= 0.45) return false;
    if (scratchInfo.slope > MAX_TREE_SLOPE) return false;

    const tree = makeTree(treeTemplates);
    const fp = estimateFootprintRadiusXZ(tree);
    if (!canPlaceOnSphere(dir, fp, treeAndBuildingObstacles(), planetRadius)) return false;

    clampTilt(scratchInfo.normal, dir, MAX_TREE_TILT, _clampedNormal);
    orientOnSurface(tree, scratchInfo.point, _clampedNormal, TREE_GROUND_NORMAL_OFFSET);
    terrainGroup.add(tree);
    placedTrees.push({ dir: dir.clone(), footprintRadius: fp });
    recordPlacement('tree', tree);
    trees++;
    return true;
  }

  for (const i of indices) {
    const dir = jitteredDirNear(i);
    const h = sampleGround(dir, scratchInfo).height01;

    if (trees < MAX_TREES && h > 0.08 && h < 0.45) {
      tryPlaceTree(dir);
    } else if ((buildings < MAX_BUILDINGS || hospitals < MAX_HOSPITALS) && h > 0.04 && h < 0.20) {
      const canPlaceHospital = hospitals < MAX_HOSPITALS && buildings > 6;
      const wantsHospital = canPlaceHospital && (Math.random() < 0.18) && (buildings < MAX_BUILDINGS);

      if (wantsHospital) {
        if (tryPlaceBuildingLike(
          () => makeHospital(hospitalTemplates),
          HOSPITAL_GROUND_NORMAL_OFFSET,
          0.04,
          0.20,
        )) hospitals++;
      } else if (buildings < MAX_BUILDINGS) {
        if (tryPlaceBuildingLike(
          () => makeBuilding(buildingTemplates),
          BUILDING_GROUND_NORMAL_OFFSET,
          0.04,
          0.20,
        )) buildings++;
      }
    }

    if (trees >= MAX_TREES && buildings >= MAX_BUILDINGS && hospitals >= MAX_HOSPITALS) break;
  }

  // Raggiungi MAX_TREES con molti spawn “attaccati” ad alberi esistenti (macchie forestali).
  let treeFillAttempts = 0;
  while (trees < MAX_TREES && treeFillAttempts < MAX_TREE_FILL_ATTEMPTS) {
    treeFillAttempts++;
    if (Math.random() < TREE_ATTACH_PROB && placedTrees.length > 0) {
      const seed = placedTrees[Math.floor(Math.random() * placedTrees.length)].dir;
      sampleBiasedForestDirection(seed, TREE_CLUSTER_ANGLE_MAX, _candDir);
      tryPlaceTree(_candDir);
    } else {
      tryPlaceTree(jitteredDirNear(indices[Math.floor(Math.random() * indices.length)]));
    }
  }

  mergeStaticTerrain(terrainGroup);
  terrainGroup.userData.isTerrainGroup = true;
  terrainGroup.userData.placements = placements;
  scene.add(terrainGroup);
  return terrainGroup;
}
