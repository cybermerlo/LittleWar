import * as THREE from 'three';
import { createGLTFLoader } from '../utils/createGLTFLoader.js';
import { terrainDensityScale, useDetailedTerrainModels } from '../utils/performanceProfile.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PLANET_RADIUS } from '../../shared/planetField.js';
import { sampleGround, makeSurfaceHit, fitGroundPlane } from './planetSurface.js';
import { BIOME, biomeAt, hash01 } from './planetBiomes.js';
import { patchWorldMaterial, WINDOW_NEVER, HOSPITAL_SEED_MAX } from './worldShaders.js';

/**
 * Alberi per famiglia: il bioma sceglie la famiglia (pini in tundra e in
 * quota, latifoglie nei prati e nei boschi, qualche albero autunnale).
 */
const TREE_MODELS = [
  { url: '/models/tree-pine.glb', kind: 'pine' },
  { url: '/models/alberello_lowpoly_rosso.glb', kind: 'autumn' },
  { url: '/models/Tree_LowPoly_Yellow.glb', kind: 'autumn' },
  { url: '/models/tree-deciduous-a.glb', kind: 'leafy' },
  { url: '/models/tree-deciduous-b.glb', kind: 'leafy' },
  { url: '/models/tree-deciduous-c.glb', kind: 'leafy' },
  { url: '/models/tree-deciduous-d.glb', kind: 'leafy' },
];

/**
 * Generatore pseudo-casuale con seme fisso: boschi e paesi nascono uguali su
 * tutti i client, quindi due giocatori vedono lo stesso mondo (prima ognuno
 * aveva la sua foresta).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(20260924);

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
const BUILDING_CLEARANCE = 0.3;       // padding in unità mondo tra impronte
const MAX_BUILDING_TRIES = 28;        // tentativi per trovare una posizione libera

// ── Alberi: non si sovrappongono; padding piccolo + spawn vicini (foresta) ───
const TREE_CLEARANCE = 0.14;
/** Angolo massimo (rad) da un albero “genitore”; esponente < 1 favorisce vicinanza */
const TREE_CLUSTER_ANGLE_MAX = 0.2;
const TREE_ATTACH_PROB = 0.8;
const TERRAIN_DENSITY_SCALE = terrainDensityScale();
const USE_DETAILED_TERRAIN_MODELS = useDetailedTerrainModels();
const MAX_TREE_FILL_ATTEMPTS = Math.round(9000 * TERRAIN_DENSITY_SCALE);

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
  obj.rotateOnAxis(_upAxis, rand() * Math.PI * 2);
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

  const yaw = rand() * Math.PI * 2;
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
  // Già che la scatola c'è: l'altezza serve al vento sugli alberi.
  obj.userData.height = box.max.y - box.min.y;
  // Media tra cerchio inscritto e circoscritto al rettangolo hw×hd: il
  // circoscritto da solo teneva le case a 6 unità l'una dall'altra e nei
  // paesi ne entravano due o tre.
  return (Math.max(hw, hd) + Math.sqrt(hw * hw + hd * hd)) * 0.5;
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
  const theta = Math.pow(rand(), 1.55) * maxAngleRad;
  const phi = rand() * Math.PI * 2;
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
  if (!_treeTemplatesPromise) {
    _treeTemplatesPromise = Promise.all(TREE_MODELS.map(({ url, kind }) =>
      loadTemplates([url], prepareTreeTemplate).then(([root]) => (root ? { root, kind } : null)),
    )).then((list) => list.filter(Boolean));
  }
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

// ── Decori procedurali (qualità bassa, o se i GLB non caricano) ───────────────
/**
 * Un solo materiale per tutti i decori procedurali, con il colore nei vertici.
 *
 * Prima ogni albero aveva una chioma di colore HSL casuale, quindi un
 * materiale diverso: il merge per aspetto non poteva unirle e la qualità
 * *bassa* pagava ~78 draw call di sole chiome, più ~10 di case — circa quattro
 * volte il terreno della qualità alta (24). Con il colore nei vertici tutto il
 * terreno procedurale, finestre comprese, è una draw call sola, e i colori
 * restano vari come prima.
 */
const PROC_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const TRUNK_COLOR = new THREE.Color(0x7a5230);
/** Vetri di giorno; di notte li accende il materiale (worldShaders.js). */
const PROC_WINDOW_COLOR = new THREE.Color(0x86cfe6);

function procMesh(geometry, color) {
  const count = geometry.getAttribute('position').count;
  const rgb = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    rgb[i * 3] = color.r;
    rgb[i * 3 + 1] = color.g;
    rgb[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  return new THREE.Mesh(geometry, PROC_MATERIAL);
}

/**
 * Fasce di finestre attorno a un blocco w×h×d appoggiato a Y = 0: poche
 * facce, e di notte si accendono come le finestre dei modelli GLB.
 */
function windowBands(w, h, d) {
  const rows = Math.max(1, Math.floor(h / 0.9));
  const bands = [];
  for (let i = 0; i < rows; i++) {
    const band = procMesh(new THREE.BoxGeometry(w * 1.02, 0.13, d * 1.02), PROC_WINDOW_COLOR);
    band.position.y = h * (i + 0.6) / (rows + 0.2);
    band.userData.isWindow = true;
    bands.push(band);
  }
  return bands;
}

function makeProceduralTree(kind = 'leafy') {
  const group = new THREE.Group();
  const trunkH = 0.5 + rand() * 0.4;
  const coneH  = (kind === 'pine' ? 1.4 : 1.0) + rand() * 0.8;
  const coneR  = (kind === 'pine' ? 0.32 : 0.4) + rand() * 0.3;

  const trunk = procMesh(new THREE.CylinderGeometry(0.08, 0.12, trunkH, 5), TRUNK_COLOR);
  trunk.position.y = trunkH / 2;

  const green = kind === 'autumn'
    ? new THREE.Color().setHSL(0.04 + rand() * 0.08, 0.75, 0.45)
    : new THREE.Color().setHSL((kind === 'pine' ? 0.36 : 0.30) + rand() * 0.05, 0.6, 0.28 + rand() * 0.1);
  const leaves = procMesh(new THREE.ConeGeometry(coneR, coneH, 6), green);
  leaves.position.y = trunkH + coneH / 2;

  group.add(trunk, leaves);
  return withGroundOrigin(group);
}

function makeTree(treeTemplates, kind) {
  if (USE_DETAILED_TERRAIN_MODELS && treeTemplates.length > 0) {
    const pool = treeTemplates.filter((t) => t.kind === kind);
    const from = pool.length ? pool : treeTemplates;
    const template = from[Math.floor(rand() * from.length)].root;
    return applyScaleJitter(template.clone(true), 0.78 + rand() * 0.5);
  }
  return makeProceduralTree(kind);
}

// ── Edificio ──────────────────────────────────────────────────────────────────
function makeProceduralBuilding() {
  const w = 0.6 + rand() * 0.8;
  const h = 0.8 + rand() * 2.0;
  const d = 0.6 + rand() * 0.8;

  const palette = [0xd4b896, 0xc0c0c0, 0xe8d8c0, 0xa8b8c8, 0xf0e0d0];
  const col = palette[Math.floor(rand() * palette.length)];

  const group = new THREE.Group();
  const building = procMesh(new THREE.BoxGeometry(w, h, d), new THREE.Color(col));
  building.position.y = h / 2;
  group.add(building, ...windowBands(w, h, d));

  if (rand() > 0.4) {
    const roofColor = new THREE.Color(col).multiplyScalar(0.75);
    const roof = procMesh(new THREE.ConeGeometry(Math.max(w, d) * 0.75, 0.5, 4), roofColor);
    roof.position.y = h + 0.25;
    group.add(roof);
  }

  return withGroundOrigin(group);
}

function makeBuilding(buildingTemplates) {
  if (USE_DETAILED_TERRAIN_MODELS && buildingTemplates.length > 0) {
    const template = buildingTemplates[Math.floor(rand() * buildingTemplates.length)];
    return applyScaleJitter(template.clone(true), 0.85 + rand() * 0.3);
  }
  return makeProceduralBuilding();
}

function makeProceduralHospital() {
  const group = new THREE.Group();

  const base = procMesh(new THREE.BoxGeometry(1.8, 1.2, 1.4), new THREE.Color(0xf2f2f2));
  base.position.y = 0.6;

  const roof = procMesh(new THREE.BoxGeometry(1.9, 0.18, 1.5), new THREE.Color(0xd9d9d9));
  roof.position.y = 1.26;

  const sign = procMesh(new THREE.BoxGeometry(0.55, 0.55, 0.08), new THREE.Color(0xffffff));
  sign.position.set(0, 1.05, 0.75);

  const crossColor = new THREE.Color(0xdd3333);
  const crossA = procMesh(new THREE.BoxGeometry(0.32, 0.10, 0.02), crossColor);
  const crossB = procMesh(new THREE.BoxGeometry(0.10, 0.32, 0.02), crossColor);
  crossA.position.set(0, 0, 0.05);
  crossB.position.set(0, 0, 0.05);
  sign.add(crossA, crossB);

  group.add(base, roof, sign, ...windowBands(1.8, 1.2, 1.4));
  return withGroundOrigin(group);
}

function makeHospital(hospitalTemplates) {
  if (USE_DETAILED_TERRAIN_MODELS && hospitalTemplates.length > 0) {
    const template = hospitalTemplates[Math.floor(rand() * hospitalTemplates.length)];
    return applyScaleJitter(template.clone(true), 0.92 + rand() * 0.22);
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

const _cheapMaterials = new Map();

/**
 * Materiale Lambert equivalente a un materiale fisico che non usa nulla di
 * fisico.
 *
 * GLTFLoader promuove a MeshPhysicalMaterial ogni materiale che dichiara le
 * estensioni ior, specular, clearcoat o transmission, anche a fattore zero:
 * case e ospedali arrivavano così, gli alberi come MeshStandardMaterial, il
 * pianeta è Lambert — tre modelli d'illuminazione diversi e uno shader fisico
 * completo per casette di colori piatti. Nessuno di questi materiali usa
 * metallo, mappe di rilievo o riflessi; con ior = 1 (case e ospedali) il
 * riflesso speculare era già nullo, e a rugosità 0.8–1 (alberi) quasi. La luce
 * diffusa è la stessa formula in entrambi, quindi il colore non cambia mentre
 * il costo per pixel scende.
 */
function cheapMaterial(m) {
  if (!m.isMeshStandardMaterial) return m;
  const cached = _cheapMaterials.get(m);
  if (cached) return cached;
  const physical = m.isMeshPhysicalMaterial
    && (m.transmission > 0 || m.clearcoat > 0 || m.sheen > 0 || m.iridescence > 0);
  const reliefOrReflections = m.normalMap || m.bumpMap || m.displacementMap || m.envMap
    || m.roughnessMap || m.metalnessMap || m.lightMap || m.aoMap;
  // La metallicità non conta: nella scena non c'è alcuna mappa d'ambiente,
  // quindi un metallo senza nulla da riflettere esce quasi nero. Succedeva
  // alle pareti dell'ospedale (e a un materiale della casa), che nel glTF non
  // dichiarano metallicFactor e ricevono il default 1: erano intonaco bianco.
  let out = m;
  if (!physical && !reliefOrReflections) {
    out = new THREE.MeshLambertMaterial({
      name: m.name,
      color: m.color,
      map: m.map,
      emissive: m.emissive,
      emissiveMap: m.emissiveMap,
      emissiveIntensity: m.emissiveIntensity,
      alphaMap: m.alphaMap,
      alphaTest: m.alphaTest,
      transparent: m.transparent,
      opacity: m.opacity,
      side: m.side,
      vertexColors: m.vertexColors,
      flatShading: m.flatShading,
      depthWrite: m.depthWrite,
    });
  }
  _cheapMaterials.set(m, out);
  return out;
}

/**
 * Vetri dei modelli GLB: 'Gesso (2)' in building-house, 'Gesso (5)' in
 * hospital. Se una decimazione rinominasse i materiali (vedi CLAUDE.md) resta
 * il ripiego sul colore: sono gli unici azzurri chiari e saturi del terreno.
 */
const WINDOW_MATERIAL_NAMES = new Set(['Gesso (2)', 'Gesso (5)']);
function isWindowMesh(mesh) {
  if (mesh.userData.isWindow) return true;
  const m = mesh.material;
  if (WINDOW_MATERIAL_NAMES.has(m.name)) return true;
  const c = m.color; // lineare
  return !!c && c.b > 0.95 && c.g > 0.65 && c.r < 0.6;
}

/** Ospedali: si accendono per primi e restano accesi fino all'alba, con luce fredda. */
const HOSPITAL_WINDOW_SEED = HOSPITAL_SEED_MAX * 0.4;

/**
 * Peso del vento per ogni vertice di un albero: 0 al piede, `k` in cima, con
 * andamento quadratico (il tronco quasi fermo, la chioma che ondeggia), più
 * la fase dell'albero.
 */
function swayWeights(geo, base, up, sway) {
  const pos = geo.getAttribute('position');
  const out = new Float32Array(pos.count * 2);
  const inv = 1 / Math.max(sway.h, 1e-3);
  for (let i = 0; i < pos.count; i++) {
    const y = ((pos.getX(i) - base.x) * up.x + (pos.getY(i) - base.y) * up.y + (pos.getZ(i) - base.z) * up.z) * inv;
    const t = Math.min(Math.max(y, 0), 1);
    out[i * 2] = sway.k * t * t;
    out[i * 2 + 1] = sway.phase;
  }
  return out;
}

/**
 * Fonde tutte le mesh statiche del terreno raggruppandole per aspetto.
 * Riduce centinaia di draw call individuali (alberi, edifici, ospedali) a
 * poche decine — una per ogni aspetto realmente distinto.
 *
 * Object3D.clone() condivide geometry e material con il template originale, e
 * le normali vengono trasformate correttamente da applyMatrix4.
 *
 * Il merge sa ancora a quale oggetto appartiene ogni mesh, e ne approfitta
 * per scrivere nei vertici ciò che serve agli shader del mondo vivo
 * (worldShaders.js), solo nei gruppi che ne hanno bisogno:
 *  - `aSeed` nei gruppi con finestre: la soglia di accensione dell'edificio,
 *    una per casa, così le case si accendono una alla volta;
 *  - `aSway` nei gruppi con alberi: peso e fase del vento.
 * Tutte le finestre del pianeta finiscono in una o due mesh fuse: accenderle
 * di notte non costa nessuna draw call.
 *
 * NOTA — spezzare il merge in chunk spaziali per far funzionare il frustum
 * culling è stato provato e misurato: faceva salire le draw call del 26% per
 * risparmiare la metà di appena 48k triangoli, un pessimo scambio. Se un
 * giorno il terreno diventasse molto più pesante, la dedup dei materiali qui
 * sotto rende il chunking molto più conveniente di quanto lo fosse allora.
 */
function mergeStaticTerrain(group) {
  const byLook = new Map(); // firma → { material, parts[], windows, sway }
  const keep = new Set(['position', 'normal', 'uv']);
  const up = new THREE.Vector3();

  group.children.forEach((root, index) => {
    root.updateMatrixWorld(true);
    const { kind, sway } = root.userData;
    // `windowSeed` permette a chi aggiunge altri edifici di sceglierne l'ora
    // di accensione: 0.12 appena cala il sole, 0.92 a notte fonda; sotto
    // HOSPITAL_SEED_MAX la luce è fredda, come negli ospedali.
    const windowSeed = root.userData.windowSeed
      ?? (kind === 'hospital' ? HOSPITAL_WINDOW_SEED : (kind === 'house' ? 0.12 + hash01(index) * 0.8 : undefined));
    if (sway) up.set(0, 1, 0).applyQuaternion(root.quaternion);

    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (!obj.geometry || !obj.material || Array.isArray(obj.material)) return;

      const material = cheapMaterial(obj.material);
      const geo = obj.geometry.clone();
      geo.applyMatrix4(obj.matrixWorld);

      // Rimuovi gli attributi che nessun materiale legge (es. uv2) per ridurre
      // memoria; il colore resta solo se il materiale usa i colori di vertice.
      for (const name of Object.keys(geo.attributes)) {
        if (!keep.has(name) && !(name === 'color' && material.vertexColors)) geo.deleteAttribute(name);
      }
      // mergeGeometries pretende lo stesso insieme di attributi in tutti i pezzi.
      if (!geo.getAttribute('uv')) {
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
      }

      const part = {
        geo,
        seed: windowSeed !== undefined && isWindowMesh(obj) ? windowSeed : WINDOW_NEVER,
        sway: sway ? swayWeights(geo, root.position, up, sway) : null,
      };
      const key = materialSignature(material);
      let look = byLook.get(key);
      if (!look) byLook.set(key, look = { material, parts: [], windows: false, sway: false });
      look.parts.push(part);
      if (part.seed !== WINDOW_NEVER) look.windows = true;
      if (part.sway) look.sway = true;
    });
  });

  // Svuota il gruppo e aggiungi le mesh fuse
  group.clear();

  for (const look of byLook.values()) {
    // Gli attributi extra vanno in tutti i pezzi del gruppo o in nessuno.
    const geos = look.parts.map(({ geo, seed, sway }) => {
      const n = geo.getAttribute('position').count;
      if (look.windows) geo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(n).fill(seed), 1));
      if (look.sway) geo.setAttribute('aSway', new THREE.BufferAttribute(sway ?? new Float32Array(n * 2), 2));
      return geo;
    });
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    // Copia: la patch va sul materiale della mesh fusa, non su quello del template.
    const material = patchWorldMaterial(look.material.clone(), {
      clouds: true,
      windows: look.windows,
      sway: look.sway,
    });
    const mesh = new THREE.Mesh(merged, material);
    mesh.matrixAutoUpdate = false; // statico: niente ricalcolo matrice per frame
    mesh.updateMatrix();
    group.add(mesh);
  }
}

/** Bioma del terreno sotto un campione di superficie. */
function biomeOfHit(hit, dir) {
  return biomeAt(dir.x, dir.y, dir.z, hit.radius - PLANET_RADIUS, hit.slope);
}

/**
 * Probabilità di accettare un albero per bioma, e famiglia di albero.
 * Deserto, spiaggia, neve e mare restano spogli.
 */
function treeRule(biome, elevation) {
  switch (biome) {
    case BIOME.FOREST: return { p: 1.0, kind: rand() < 0.2 ? 'pine' : (rand() < 0.1 ? 'autumn' : 'leafy') };
    case BIOME.GRASS: return { p: 0.3, kind: rand() < 0.18 ? 'autumn' : 'leafy' };
    case BIOME.SAVANNA: return { p: 0.12, kind: rand() < 0.5 ? 'autumn' : 'leafy' };
    case BIOME.TUNDRA: return { p: 0.55, kind: 'pine' };
    case BIOME.ROCK: return elevation < 3.3 ? { p: 0.12, kind: 'pine' } : null;
    default: return null;
  }
}

/**
 * Popola il pianeta di alberi, case e ospedali appoggiandoli sulla superficie
 * renderizzata (vedi `planetSurface.js`), non sul campo di altezza ideale.
 *
 * Case e ospedali sono raggruppati in paesi su prati e savane pianeggianti;
 * gli alberi seguono i biomi (boschi fitti nelle foreste, pini in tundra e in
 * quota, radi nei prati, nulla nel deserto). Tutto con un seme fisso.
 *
 * @param {THREE.Scene}                         scene
 * @param {{root:THREE.Object3D, kind:string}[]} [treeTemplates]     - loadTreeTemplates()
 * @param {THREE.Object3D[]}                    [buildingTemplates] - loadBuildingTemplates()
 * @param {THREE.Object3D[]}                    [hospitalTemplates] - loadHospitalTemplates()
 */
export function createTerrain(scene, treeTemplates = [], buildingTemplates = [], hospitalTemplates = []) {
  rand = mulberry32(20260924);
  const terrainGroup = new THREE.Group();

  const MAX_TREES = Math.max(60, Math.round(280 * TERRAIN_DENSITY_SCALE));
  const TOWNS = Math.max(4, Math.round(11 * TERRAIN_DENSITY_SCALE));
  const HOUSES_PER_TOWN = USE_DETAILED_TERRAIN_MODELS ? [4, 8] : [3, 5];
  const FARMS = Math.round(10 * TERRAIN_DENSITY_SCALE);

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

  function obstacles() {
    return placedTrees.length ? [...placedBuildings, ...placedTrees] : placedBuildings;
  }

  function randomDir(out = new THREE.Vector3()) {
    const z = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    return out.set(r * Math.cos(a), z, r * Math.sin(a));
  }

  const scratchInfo = makeSurfaceHit();

  // Budget globale: appoggiare una base costa ~25 campionamenti del terreno.
  // Su un pianeta senza abbastanza pianure il ciclo potrebbe altrimenti
  // consumare secondi di caricamento cercando siti che non esistono.
  let fitBudget = Math.round(3000 * Math.max(0.5, TERRAIN_DENSITY_SCALE));

  /** Prova a piazzare una casa/ospedale vicino a `centerDir` (entro `spread` rad). */
  function tryPlaceBuildingNear(makeFn, normalOffset, centerDir, spread, kind = 'house') {
    if (fitBudget <= 0) return false;
    const obj = makeFn();
    const footprint = estimateFootprintRadiusXZ(obj);

    for (let attempt = 0; attempt < MAX_BUILDING_TRIES && fitBudget > 0; attempt++) {
      const dir = sampleBiasedForestDirection(centerDir, spread, new THREE.Vector3());
      sampleGround(dir, scratchInfo);
      const elevation = scratchInfo.radius - PLANET_RADIUS;
      if (elevation < 0.5 || elevation > 2.2) continue;
      if (scratchInfo.slope > MAX_BUILDING_SLOPE) continue;
      const biome = biomeOfHit(scratchInfo, dir);
      if (biome !== BIOME.GRASS && biome !== BIOME.SAVANNA && biome !== BIOME.FOREST) continue;
      if (!canPlaceOnSphere(dir, footprint, obstacles(), planetRadius)) continue;
      fitBudget--;
      if (!placeBuildingBaseOnTerrain(obj, dir, normalOffset)) continue;

      obj.userData.kind = kind;
      terrainGroup.add(obj);
      placedBuildings.push({
        dir: dir.clone(),
        footprintRadius: footprint,
        position: obj.position.clone(),
        up: new THREE.Vector3(0, 1, 0).applyQuaternion(obj.quaternion),
        size: footprint,
        kind,
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.x,
      });
      recordPlacement('building', obj);
      return true;
    }
    return false;
  }

  // ── Paesi ────────────────────────────────────────────────────────────────
  // Il centro di un paese va bene solo se tutto l'intorno è pianura emersa:
  // altrimenti le case finiscono sulla scarpata della spiaggia o in mare.
  const TOWN_RADIUS = 0.085; // rad (~4.5 unità)
  const _ring = new THREE.Vector3();
  function isTownSite(dir) {
    sampleGround(dir, scratchInfo);
    const e0 = scratchInfo.radius - PLANET_RADIUS;
    if (e0 < 0.6 || e0 > 1.4 || scratchInfo.slope > 0.06) return false;
    const biome = biomeOfHit(scratchInfo, dir);
    if (biome !== BIOME.GRASS && biome !== BIOME.SAVANNA) return false;
    _refAxis.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0);
    _forestT.crossVectors(dir, _refAxis).normalize();
    _forestB.crossVectors(dir, _forestT).normalize();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      _ring.copy(dir)
        .addScaledVector(_forestT, Math.cos(a) * TOWN_RADIUS)
        .addScaledVector(_forestB, Math.sin(a) * TOWN_RADIUS)
        .normalize();
      const e = sampleGround(_ring, scratchInfo).radius - PLANET_RADIUS;
      if (Math.abs(e - e0) > 0.25) return false;
    }
    return true;
  }

  const towns = [];
  for (let attempt = 0; attempt < 6000 && towns.length < TOWNS; attempt++) {
    const dir = randomDir();
    if (towns.some((t) => t.angleTo(dir) < 0.42)) continue;
    if (!isTownSite(dir)) continue;
    towns.push(dir.clone());
  }

  towns.forEach((center, i) => {
    const [lo, hi] = HOUSES_PER_TOWN;
    const houses = lo + Math.floor(rand() * (hi - lo + 1));
    if (i % 2 === 0) {
      tryPlaceBuildingNear(() => makeHospital(hospitalTemplates), HOSPITAL_GROUND_NORMAL_OFFSET, center, 0.03, 'hospital');
    }
    for (let h = 0; h < houses; h++) {
      tryPlaceBuildingNear(() => makeBuilding(buildingTemplates), BUILDING_GROUND_NORMAL_OFFSET, center, TOWN_RADIUS * 1.5);
    }
  });

  // Case sparse (fattorie) nei prati
  for (let f = 0, tries = 0; f < FARMS && tries < 400; tries++) {
    const dir = randomDir();
    if (tryPlaceBuildingNear(() => makeBuilding(buildingTemplates), BUILDING_GROUND_NORMAL_OFFSET, dir, 0.02)) f++;
  }

  // ── Alberi ───────────────────────────────────────────────────────────────
  let trees = 0;
  function tryPlaceTree(dir) {
    sampleGround(dir, scratchInfo);
    const elevation = scratchInfo.radius - PLANET_RADIUS;
    if (elevation < 0.45 || scratchInfo.slope > MAX_TREE_SLOPE) return false;
    const rule = treeRule(biomeOfHit(scratchInfo, dir), elevation);
    if (!rule || rand() > rule.p) return false;

    const tree = makeTree(treeTemplates, rule.kind);
    const fp = estimateFootprintRadiusXZ(tree);
    if (!canPlaceOnSphere(dir, fp, obstacles(), planetRadius)) return false;

    clampTilt(scratchInfo.normal, dir, MAX_TREE_TILT, _clampedNormal);
    orientOnSurface(tree, scratchInfo.point, _clampedNormal, TREE_GROUND_NORMAL_OFFSET);
    // Vento: i pini più rigidi delle latifoglie; la fase da un hash, non da
    // rand(), per non spostare boschi e paesi rispetto alle versioni precedenti.
    tree.userData.kind = 'tree';
    tree.userData.sway = { h: tree.userData.height, k: rule.kind === 'pine' ? 0.6 : 1, phase: hash01(trees + 7919) * Math.PI * 2 };
    terrainGroup.add(tree);
    placedTrees.push({ dir: dir.clone(), footprintRadius: fp });
    recordPlacement('tree', tree);
    trees++;
    return true;
  }

  // Semi sparsi, poi crescita a macchie attorno agli alberi già piantati.
  for (let i = 0; i < MAX_TREE_FILL_ATTEMPTS && trees < MAX_TREES; i++) {
    if (placedTrees.length > 0 && rand() < TREE_ATTACH_PROB) {
      const seed = placedTrees[Math.floor(rand() * placedTrees.length)].dir;
      tryPlaceTree(sampleBiasedForestDirection(seed, TREE_CLUSTER_ANGLE_MAX, _candDir));
    } else {
      tryPlaceTree(randomDir(_candDir));
    }
  }

  if (import.meta.env?.DEV) console.log('[terrain]', JSON.stringify({ towns: towns.length, buildings: placedBuildings.length, trees }));
  mergeStaticTerrain(terrainGroup);
  terrainGroup.userData.isTerrainGroup = true;
  // Per chi decora il mondo dopo la costruzione (luci notturne, fumo, fari…):
  // centri dei paesi (direzioni unitarie) ed edifici piazzati (posizione world,
  // verticale locale, raggio d'impronta, 'house' | 'hospital').
  terrainGroup.userData.towns = towns.map((t) => t.clone());
  terrainGroup.userData.buildings = placedBuildings.map(({ position, up, size, kind, quaternion, scale }) => ({ position, up, size, kind, quaternion, scale }));
  terrainGroup.userData.placements = placements;
  scene.add(terrainGroup);
  return terrainGroup;
}
