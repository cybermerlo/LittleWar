import * as THREE from 'three';
import { createGLTFLoader } from '../utils/createGLTFLoader.js';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { mergeMeshesByMaterial } from '../utils/mergeByMaterial.js';
import {
  sampleGroundSpherical,
  makeSurfaceHit,
  fitGroundPlane,
} from '../scene/planetSurface.js';
import { lightPool } from '../scene/LightPool.js';
import {
  OBJECTIVE_TIME,
  glows,
  segments,
  SEG_LASER,
  glowColorFor,
  spawnObjectiveBurst,
  isObjectiveLowQuality,
  createConformingBandGeometry,
  DECAL_VERT,
  DECAL_FRAG_END,
} from './ObjectiveFx.js';
import {
  PLANET_RADIUS,
  FLY_ALTITUDE,
  BUILDING_CONQUEST_RADIUS,
  BUILDING_CONQUEST_TIME,
  TURRET_FIRE_RATE,
  TURRET_RANGE,
} from '../../shared/constants.js';

// ── Modelli e dimensioni ──────────────────────────────────────────────────────

/** Scala della torretta conquistata (0.3 × 0.8 = riduzione 20% richiesta). */
const CESARE_SCALE = 0.24;
/** Scala del modello pre-conquista (piccolo avamposto). */
const PRE_SCALE = 0.5;

/**
 * Posizione locale del nodo "Turret_Pivot" nel glTF della torretta conquistata
 * (unità modello, pre-scale). Serve sia per ruotare attorno al pivot sia per
 * calcolare la posizione world dell'estremità del cannone.
 */
const TURRET_PIVOT_LOCAL = new THREE.Vector3(0.185, 9.326, -0.218);

/**
 * Estremità del cannone nel frame locale del Turret_Pivot (unità modello,
 * pre-scale). Ottenuta dalle coordinate scene fornite dal designer
 * (0.0479, 13.5079, 11.4608) sottraendo la posizione del pivot
 * (0.185, 9.326, -0.218).
 * Usata per muzzle-flash (client) e come riferimento per l'offset del
 * punto di spawn del proiettile (server).
 */
const CANNON_TIP_PIVOT_LOCAL = new THREE.Vector3(-0.1371, 4.1819, 11.6788);

/**
 * Punto esatto del beacon nelle coordinate scene del glTF (pre-scale),
 * fornito dal designer: la sommità della testa.
 */
const BEACON_MODEL_POINT_SCENE = new THREE.Vector3(-0.3617, 20.0666, -0.8266);

/** Stesso punto nel frame locale di `Turret_Pivot` (segue yaw/pitch del cannone). */
const BEACON_TURRET_PIVOT_LOCAL = BEACON_MODEL_POINT_SCENE.clone().sub(TURRET_PIVOT_LOCAL);

/**
 * Stendardo del proprietario sulla testa di Cesare (unità modello). La sola
 * tinta delle fasce e dei capelli, di giorno e da lontano, non diceva di chi
 * fosse la torretta. Asta e drappo entrano nella fusione delle mesh del pivot
 * (drappo nel materiale tinto `Gesso (7)`), quindi non costano draw call.
 */
const PENNANT_POLE_H = 9;
const PENNANT_W = 7;
const PENNANT_H = 4.2;
/** Punta dell'asta, dove sta il beacon. */
const BEACON_TIP_PIVOT_LOCAL = BEACON_TURRET_PIVOT_LOCAL.clone().add(new THREE.Vector3(0, PENNANT_POLE_H + 0.5, 0));

/** Materiali tintati col colore del proprietario (fasce della colonna, capelli). */
const OWNER_TINT_MATERIALS = new Set(['Gesso (5)', 'Gesso (7)']);

/**
 * Stile piatto dell'avamposto neutro. Il cumulo aveva una texture quasi
 * fotografica di fango crepato e le casse legno texturizzato su
 * MeshPhysicalMaterial: stonavano col pianeta a facce piatte e da quota
 * erano una macchia marrone. `false` ripristina i materiali del designer.
 */
const OUTPOST_FLAT_STYLE = true;
const OUTPOST_STYLE = {
  mat20: 0xc9a36b,       // terrapieno color sabbia
  Gesso: 0x6b7a3a,       // casse verde militare
  'Gesso (4)': 0x8d949c, // asta
};

/** Bandiera neutra: bianco panna. Il rosso puro di prima era il colore del giocatore rosso. */
const NEUTRAL_FLAG_COLOR = 0xf4efe6;
/** Quanto si allunga l'asta dell'avamposto (fattore sulla lunghezza originale). */
const POLE_EXTEND = 1.6;

// ── Zona di conquista ─────────────────────────────────────────────────────────

/**
 * Semiapertura (rad, vista dal centro del pianeta) della zona di conquista.
 * Stessa geometria di `Building.distanceTo` sul server: edificio a
 * PLANET_RADIUS, aereo a FLY_ALTITUDE, distanza < BUILDING_CONQUEST_RADIUS.
 * Prima l'anello usava 11.2·50/56 = 10 unità sul terreno, cioè 0.194 rad
 * invece di 0.179: era più largo dell'8.5% e chi volava sopra il bordo
 * interno non conquistava.
 */
export const CONQUEST_ZONE_ANGLE = Math.acos(
  (PLANET_RADIUS ** 2 + FLY_ALTITUDE ** 2 - BUILDING_CONQUEST_RADIUS ** 2)
  / (2 * PLANET_RADIUS * FLY_ALTITUDE),
);
const ZONE_RING_WIDTH = 1.1;
/** Il nastro in quota si vede solo da vicino: sette nastri nel cielo sarebbero confusione. */
const RIBBON_FADE_NEAR = 26;
const RIBBON_FADE_FAR = 42;
const RIBBON_HALF_HEIGHT = 0.45;

const MODE_NEUTRAL = 0;
const MODE_CAPTURING = 1;
const MODE_OWNED = 2;
const MODE_CONTESTED = 3;
const ZONE_MODE_NAMES = ['neutral', 'capturing', 'owned', 'contested'];

// ── Parametri beacon ──────────────────────────────────────────────────────────

const BEACON_BLINK_HZ = 0.55;
const BEACON_SIZE = 1.15;
/** Diametro minimo sullo schermo: da lontano resta un punto riconoscibile. */
const BEACON_MIN_PX = 9;

/**
 * Impronta approssimata della torretta, usata per adattare il piano di
 * appoggio al terreno sottostante invece di infilare la base a raggio fisso.
 */
const TURRET_FOOTPRINT_HALF = 1.15;

/**
 * Quanto la torretta segue l'inclinazione del terreno. Una torre segue il
 * filo a piombo, non il pendio: raddrizziamo quasi del tutto la giacitura
 * conservando solo un accenno di inclinazione, che basta a far leggere
 * l'appoggio senza farla sembrare pendente.
 */
const TURRET_TILT_FOLLOW = 0.25;

const TURRET_FIRE_MS = TURRET_FIRE_RATE * 1000;
/** Oltre il raggio di tiro (più un margine per la latenza) il laser non si disegna. */
const LASER_MAX_DIST = TURRET_RANGE + 6;

/** Scratch riusabili: puntamento, beacon e laser girano per ogni torretta a ogni frame. */
const _aimWorld = new THREE.Vector3();
const _tintColor = new THREE.Color();
const _fxColor = new THREE.Color();
const _beaconPos = new THREE.Vector3();
const _laserFrom = new THREE.Vector3();
const _camRel = new THREE.Vector3();
const _burstPos = new THREE.Vector3();

function smooth01(x) {
  return THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(x, 0, 1), 0, 1);
}

/** Pulse morbido 0..1 con piccola pausa tra un lampo e il successivo. */
function blinkGate(t) {
  const phase = (t * BEACON_BLINK_HZ) % 1;
  const pulseWindow = 0.68;
  if (phase >= pulseWindow) return 0;
  const u = phase / pulseWindow; // 0..1 durante il lampo
  const s = Math.sin(u * Math.PI); // curva naturalmente morbida
  return Math.pow(Math.max(0, s), 1.7);
}

function easeOutBack(t) {
  const c1 = 1.9;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

// ── Pre-caricamento e preparazione dei modelli ────────────────────────────────

const _loader = createGLTFLoader();
/** Modelli pronti da clonare (mesh già fuse per materiale). */
let _cesareTemplate = null;
let _preTemplate = null;
const _cesarePromise = _loader
  .loadAsync('/models/torretta_cesare.glb')
  .then((gltf) => { _cesareTemplate = buildCesareTemplate(gltf); })
  .catch((err) => { console.warn('[Building] fallito caricamento torretta_cesare.glb', err); });
const _prePromise = _loader
  .loadAsync('/models/pre_torretta.glb')
  .then((gltf) => { _preTemplate = buildPreTemplate(gltf); })
  .catch((err) => { console.warn('[Building] fallito caricamento pre_torretta.glb', err); });

/**
 * Risolve quando i glTF delle torrette (neutra + conquistata) sono in memoria.
 * Da includere nel preload iniziale insieme ad alberi/edifici così il parsing
 * di rete/decodifica non avviene allo spawn in partita.
 */
export function preloadTurretBuildingModels() {
  return Promise.all([_cesarePromise, _prePromise]);
}

function isDescendantOf(obj, ancestor) {
  for (let o = obj; o; o = o.parent) if (o === ancestor) return true;
  return false;
}

/** Asta e drappo dello stendardo, nel frame del Turret_Pivot (unità modello). */
function makePennantGeometries() {
  const b = BEACON_TURRET_PIVOT_LOCAL;
  const pole = new THREE.CylinderGeometry(0.2, 0.2, PENNANT_POLE_H, 6);
  pole.translate(b.x, b.y + PENNANT_POLE_H / 2, b.z);

  // Drappo triangolare: prisma sottile che punta all'indietro (−Z; il cannone
  // guarda verso +Z), appeso alla cima dell'asta.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(PENNANT_W, PENNANT_H * 0.5);
  shape.lineTo(0, PENNANT_H);
  shape.closePath();
  const cloth = new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: false });
  cloth.translate(0, 0, -0.175);
  cloth.rotateY(Math.PI / 2);
  cloth.translate(b.x, b.y + PENNANT_POLE_H - PENNANT_H - 0.15, b.z);
  return { pole, cloth };
}

/**
 * Torretta conquistata: da 236 primitive (una draw call ciascuna, 200 con lo
 * stesso materiale) a una mesh per materiale — 4 per la base, 5 per il blocco
 * che ruota. Il nodo `Turret_Pivot` resta con la sua trasformazione, così
 * mira, estremità del cannone (TURRET_PIVOT_LOCAL, CANNON_TIP_PIVOT_LOCAL) e
 * beacon continuano a valere.
 */
function buildCesareTemplate(gltf) {
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  const srcInv = new THREE.Matrix4().copy(src.matrixWorld).invert();
  const pivotSrc = src.getObjectByName('Turret_Pivot');

  const baseMeshes = [];
  const pivotMeshes = [];
  src.traverse((o) => {
    if (!o.isMesh) return;
    (pivotSrc && isDescendantOf(o, pivotSrc) ? pivotMeshes : baseMeshes).push(o);
  });

  const root = new THREE.Group();
  root.name = 'torretta_cesare';
  for (const m of mergeMeshesByMaterial(baseMeshes, srcInv)) root.add(m);

  if (pivotSrc) {
    const pivot = new THREE.Object3D();
    pivot.name = 'Turret_Pivot';
    new THREE.Matrix4().multiplyMatrices(srcInv, pivotSrc.matrixWorld)
      .decompose(pivot.position, pivot.quaternion, pivot.scale);
    const pivotInv = new THREE.Matrix4().copy(pivotSrc.matrixWorld).invert();
    const { pole, cloth } = makePennantGeometries();
    const merged = mergeMeshesByMaterial(pivotMeshes, pivotInv, {
      extra: { Gesso: [pole], 'Gesso (7)': [cloth] },
    });
    for (const m of merged) pivot.add(m);
    root.add(pivot);
  }
  return root;
}

let _outpostMats = null;
function outpostMaterialFor(original) {
  if (!OUTPOST_FLAT_STYLE) return original;
  _outpostMats ??= new Map();
  const name = original.name;
  if (_outpostMats.has(name)) return _outpostMats.get(name);
  const color = OUTPOST_STYLE[name] ?? original.color?.getHex() ?? 0xaaaaaa;
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true, side: original.side });
  m.name = name;
  _outpostMats.set(name, m);
  return m;
}

/**
 * Avamposto neutro: 12 mesh → una per materiale, più la bandiera separata
 * (sale col progresso della conquista e prende il colore di chi conquista).
 * Base centrata e appoggiata su y = 0 una volta per tutte.
 */
function buildPreTemplate(gltf) {
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  const srcInv = new THREE.Matrix4().copy(src.matrixWorld).invert();

  let flagSrc = null;
  const rest = [];
  src.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material?.name === 'Gesso (5)' && !flagSrc) { flagSrc = o; return; }
    rest.push(o);
  });

  const root = new THREE.Group();
  root.name = 'pre_torretta';
  const merged = mergeMeshesByMaterial(rest, srcInv, { materialFor: outpostMaterialFor });
  const box = new THREE.Box3();
  for (const m of merged) box.union(m.geometry.boundingBox);

  let flagMesh = null;
  if (flagSrc) {
    [flagMesh] = mergeMeshesByMaterial([flagSrc], srcInv, {
      materialFor: () => new THREE.MeshLambertMaterial({
        color: NEUTRAL_FLAG_COLOR, flatShading: true, side: THREE.DoubleSide,
      }),
    });
    if (flagMesh) box.union(flagMesh.geometry.boundingBox);
  }

  // Centra in XZ e poggia la base su y = 0 (il glTF ha l'origine decentrata).
  const center = box.getCenter(new THREE.Vector3());
  const shift = new THREE.Vector3(-center.x, -box.min.y, -center.z);
  for (const m of merged) {
    m.geometry.translate(shift.x, shift.y, shift.z);
    m.geometry.computeBoundingBox();
    m.geometry.computeBoundingSphere();
    root.add(m);
  }

  if (flagMesh) {
    const g = flagMesh.geometry;
    g.translate(shift.x, shift.y, shift.z);
    g.computeBoundingBox();
    const fb = g.boundingBox;
    // L'asta è piantata storta nel cumulo: la bandiera deve scorrere lungo il
    // suo asse (e sventolarci attorno), non salire in verticale staccandosene.
    const bottom = new THREE.Vector3(fb.min.x, 0, (fb.min.z + fb.max.z) / 2);
    const axis = new THREE.Vector3(0, 1, 0);
    let rise = 0;
    const pole = merged.find((m) => m.name === 'Gesso (4)')?.geometry;
    if (pole) {
      const ends = poleEnds(pole);
      bottom.copy(ends.bottom);
      axis.subVectors(ends.top, ends.bottom);
      const len = axis.length();
      axis.divideScalar(len);
      // Fra le casse e la cima non c'era spazio per ammainare la bandiera:
      // l'asta si allunga, la bandiera neutra resta dove l'ha messa il
      // designer e quella di chi conquista sale fin sulla nuova cima.
      rise = len * (POLE_EXTEND - 1);
      const pos = pole.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const t = (v.x - bottom.x) * axis.x + (v.y - bottom.y) * axis.y + (v.z - bottom.z) * axis.z;
        v.addScaledVector(axis, t * (POLE_EXTEND - 1));
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      pos.needsUpdate = true;
      pole.computeBoundingBox();
      pole.computeBoundingSphere();
    }
    // Punto dell'asse all'altezza del lembo più basso della bandiera issata.
    const attach = bottom.clone().addScaledVector(axis, (fb.min.y - bottom.y) / axis.y);
    g.translate(-attach.x, -attach.y, -attach.z);
    g.computeBoundingSphere();
    flagMesh.name = 'outpost-flag';
    flagMesh.position.copy(attach);
    root.add(flagMesh);
    root.userData.flag = { attach, axis, rise };
  }
  return root;
}


/** Centri delle due estremità di un'asta (media dei vertici più bassi e più alti). */
function poleEnds(geo) {
  const pos = geo.getAttribute('position');
  const ys = [];
  for (let i = 0; i < pos.count; i++) ys.push(pos.getY(i));
  ys.sort((a, b) => a - b);
  const lo = ys[Math.floor(ys.length * 0.2)];
  const hi = ys[Math.floor(ys.length * 0.8)];
  const bottom = new THREE.Vector3();
  const top = new THREE.Vector3();
  let nb = 0, nt = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y <= lo) { bottom.x += pos.getX(i); bottom.y += y; bottom.z += pos.getZ(i); nb++; }
    if (y >= hi) { top.x += pos.getX(i); top.y += y; top.z += pos.getZ(i); nt++; }
  }
  bottom.divideScalar(Math.max(1, nb));
  top.divideScalar(Math.max(1, nt));
  return { bottom, top };
}

// ── Materiali della zona di conquista ─────────────────────────────────────────

const RING_FRAG = /* glsl */`
  #include <fog_pars_fragment>
  uniform vec3 uColor;
  uniform vec3 uProgColor;
  uniform float uProgress;
  uniform float uMode;
  uniform float uInside;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float u = vUv.x;
    float v = vUv.y;                     // 0 bordo interno, 1 confine vero della zona
    float dv = fwidth(v) * 1.5;
    float du = max(fwidth(u), 1e-5);
    bool capturing = uMode > 0.5 && uMode < 1.5;

    // Filo pieno sul confine vero: chi lo vede sotto l'aereo è al limite.
    float rim = smoothstep(0.86 - dv, 0.86, v) * (1.0 - smoothstep(1.0 - dv, 1.0, v));
    // Fascia tratteggiata subito dentro, che gira lenta (veloce mentre
    // qualcuno conquista). Una sola fascia: con due linee parallele e le
    // traversine in mezzo l'anello sembrava un binario.
    float speed = capturing ? 0.9 : 0.12;
    float dc = fract(u * 48.0 + uTime * speed);
    float dAA = du * 48.0 * 1.5;
    float dash = smoothstep(0.0, dAA, dc) * (1.0 - smoothstep(0.58, 0.58 + dAA, dc));
    float dashBand = smoothstep(0.5 - dv, 0.5, v) * (1.0 - smoothstep(0.8, 0.8 + dv, v));
    // Velo verso l'interno: si legge come un'area, non come un sentiero.
    float veil = smoothstep(0.0, 0.5, v) * (1.0 - smoothstep(0.5, 0.6, v)) * 0.16;

    vec3 col = uColor;
    float a = rim * 0.95 + dash * dashBand * 0.85 + veil;

    if (capturing) {
      // L'anello è la barra di progresso: si riempie in senso orario nel
      // colore di chi conquista, con la punta più chiara.
      float arc = 1.0 - smoothstep(uProgress - du * 1.5, uProgress, u);
      float band = smoothstep(0.45 - dv, 0.45, v);
      col = mix(col, uProgColor, arc * band);
      a = mix(a, 0.95 * band + veil, arc);
      float tip = (1.0 - smoothstep(0.0, 0.01, abs(u - uProgress))) * band;
      col = mix(col, vec3(1.0), tip * 0.7);
      a = max(a, tip);
    } else if (uMode > 2.5) {
      // Contesa: con due aerei in zona il server azzera il progresso.
      float blink = step(0.5, fract(uTime * 3.0));
      col = mix(vec3(1.0, 0.16, 0.1), vec3(1.0), blink);
      a = max(a, smoothstep(0.28, 0.5, v) * 0.55);
    }
    a *= 0.82 + 0.3 * uInside;
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
    ${DECAL_FRAG_END}
  }
`;

function makeRingMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uColor: { value: new THREE.Color(0xf4efe6) },
        uProgColor: { value: new THREE.Color(0xffffff) },
        uProgress: { value: 0 },
        uMode: { value: MODE_NEUTRAL },
        uInside: { value: 0 },
        uTime: { value: 0 },
      },
    ]),
    vertexShader: DECAL_VERT,
    fragmentShader: RING_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    extensions: { derivatives: true },
  });
  mat.uniforms.uTime = OBJECTIVE_TIME;
  return mat;
}

const RIBBON_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const RIBBON_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uProgColor;
  uniform float uProgress;
  uniform float uMode;
  uniform float uInside;
  uniform float uFade;
  uniform float uTime;
  uniform vec3 uPlane;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    // Filo di luce morbido: niente tratteggio, sembrerebbe una transenna.
    float y = abs(vUv.y * 2.0 - 1.0);
    float prof = exp(-y * y * 5.0) * (1.0 - y);
    float shimmer = 0.8 + 0.2 * sin((vUv.x * 24.0 - uTime * 0.6) * 6.2832);
    vec3 col = uColor;
    if (uMode > 0.5 && uMode < 1.5) {
      col = mix(col, uProgColor, step(vUv.x, uProgress));
    } else if (uMode > 2.5) {
      col = mix(vec3(1.0, 0.16, 0.1), vec3(1.0), step(0.5, fract(uTime * 3.0)));
    }
    // Si accende dove l'aereo locale gli è vicino: dice esattamente dove
    // passa il confine rispetto a chi vola, alla sua stessa quota.
    float near = 1.0 - smoothstep(1.5, 9.0, distance(vWorld, uPlane));
    float a = prof * shimmer * (0.3 + 0.3 * uInside + 1.1 * near) * uFade;
    gl_FragColor = vec4(col * a * 1.3, min(a, 1.0) * 0.6);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function makeRibbonMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xf4efe6) },
      uProgColor: { value: new THREE.Color(0xffffff) },
      uProgress: { value: 0 },
      uMode: { value: MODE_NEUTRAL },
      uInside: { value: 0 },
      uFade: { value: 0 },
      uPlane: { value: new THREE.Vector3(0, 0, 1e4) },
      uTime: OBJECTIVE_TIME,
    },
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  mat.uniforms.uTime = OBJECTIVE_TIME;
  return mat;
}

/** Nastro alla quota di volo, esattamente sul confine della zona che conta per il server. */
function createRibbonGeometry(siteDir) {
  const segs = 96;
  const dir = siteDir.clone().normalize();
  const ref = new THREE.Vector3(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0);
  const tu = new THREE.Vector3().crossVectors(dir, ref).normalize();
  const tv = new THREE.Vector3().crossVectors(dir, tu).normalize();
  const ca = Math.cos(CONQUEST_ZONE_ANGLE);
  const sa = Math.sin(CONQUEST_ZONE_ANGLE);
  const pos = new Float32Array((segs + 1) * 2 * 3);
  const uv = new Float32Array((segs + 1) * 2 * 2);
  const idx = [];
  const p = new THREE.Vector3();
  for (let s = 0; s <= segs; s++) {
    const a = -(s / segs) * Math.PI * 2;
    p.copy(dir).multiplyScalar(ca)
      .addScaledVector(tu, sa * Math.cos(a))
      .addScaledVector(tv, sa * Math.sin(a));
    for (let r = 0; r < 2; r++) {
      const radius = FLY_ALTITUDE + (r === 0 ? -RIBBON_HALF_HEIGHT : RIBBON_HALF_HEIGHT);
      const i = s * 2 + r;
      pos[i * 3] = p.x * radius; pos[i * 3 + 1] = p.y * radius; pos[i * 3 + 2] = p.z * radius;
      uv[i * 2] = s / segs; uv[i * 2 + 1] = r;
    }
    if (s < segs) {
      const a0 = s * 2, b0 = a0 + 2;
      idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// Materiali modello: ogni edificio ne clona una copia (uniform proprie).
let _ringTemplate = null;
let _ribbonTemplate = null;
function ringTemplate() { return (_ringTemplate ??= makeRingMaterial()); }
function ribbonTemplate() { return (_ribbonTemplate ??= makeRibbonMaterial()); }
function cloneShared(template) {
  const m = template.clone();
  m.uniforms.uTime = OBJECTIVE_TIME; // il clone copierebbe il valore, non il riferimento
  return m;
}

// ── BuildingEntity ────────────────────────────────────────────────────────────

/**
 * Entità visiva per un edificio conquistabile / torretta difensiva.
 *
 * - Neutrale / post-distruzione → modello `pre_torretta` con bandiera che
 *   sale col progresso nel colore di chi conquista
 * - Conquistato → modello `torretta_cesare` con cannone puntabile, tinta e
 *   stendardo del proprietario, beacon, laser di puntamento prima del colpo
 * - Zona di conquista: anello a terra che fa da barra di progresso, più un
 *   nastro luminoso alla quota di volo (solo in qualità alta)
 */
export class BuildingEntity {
  constructor(scene, id, theta, phi) {
    this.id = id;
    this.theta = theta;
    this.phi = phi;
    this.ownerId = null;
    this.ownerColor = null;
    this.conquestProgress = 0;
    this.conqueringPlayerId = null;
    this.turretTargetId = null;
    /** Ultimo colpo visto (ms, performance.now): dà la carica del laser. */
    this.lastShotAt = 0;
    this._aimSince = 0;
    this._hasState = false;
    this._shownProgress = 0;
    this._mode = MODE_NEUTRAL;
    this._inside = 0;
    this._contenders = 0;
    this._localPos = null;
    this._popT = 1;
    this._time = Math.random() * 10; // desincronizza beacon e bandiere
    this._conquerorColor = new THREE.Color(0xffffff);

    // ── Gruppo appoggiato sul terreno renderizzato ──
    // Prima la torretta veniva piantata a raggio PLANET_RADIUS fisso: su una
    // collina finiva sepolta fino a MOUNTAIN_HEIGHT (5.2 unità), cioè quasi
    // per intero. Ora la base segue la superficie che si vede davvero.
    this.group = new THREE.Group();

    const hit = sampleGroundSpherical(theta, phi, makeSurfaceHit());
    const radial = hit.point.clone().normalize();
    const fit = fitGroundPlane(radial, TURRET_FOOTPRINT_HALF, TURRET_FOOTPRINT_HALF, 0);

    // Giacitura: quasi verticale, con un accenno dell'inclinazione del suolo.
    const up = radial.clone().lerp(fit.normal, TURRET_TILT_FOLLOW).normalize();
    this.group.position.copy(fit.origin);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);

    this.group.userData.isTurretGroup = true;

    /** Direzione radiale del sito: serve agli anelli conformati. */
    this._siteDir = radial;
    /** Punto usato dal server per le distanze (edificio a PLANET_RADIUS). */
    this.sitePoint = radial.clone().multiplyScalar(PLANET_RADIUS);
    /** Centro della zona alla quota di volo (dissolvenza del nastro). */
    this._siteAir = radial.clone().multiplyScalar(FLY_ALTITUDE);

    // ── Wrapper per i due modelli (neutro / conquistato) ──
    this.neutralWrapper = new THREE.Group();
    this.conqueredWrapper = new THREE.Group();
    this.conqueredWrapper.visible = false;
    this.group.add(this.neutralWrapper);
    this.group.add(this.conqueredWrapper);

    /** Riferimento al root scalato della torretta conquistata (cesare). */
    this.cesareRoot = null;
    /** Nodo del Turret_Pivot (ruota yaw+pitch per puntare il bersaglio). */
    this.turretPivot = null;
    /** Materiali tintati per-istanza (`Gesso (5)`, `Gesso (7)`). */
    this._cesareMats = [];

    /** Riferimento al root scalato della pre-torretta. */
    this.preRoot = null;
    this._flag = null;
    this._flagMat = null;
    this._flagInfo = null;

    // Fallback procedurale, sostituito quando il glTF neutro è pronto
    this._fallback = this._buildFallback();
    this.neutralWrapper.add(this._fallback);

    if (_preTemplate) this._attachPreModel();
    else _prePromise.then(() => this._attachPreModel());

    if (_cesareTemplate) this._attachCesareModel();
    else _cesarePromise.then(() => this._attachCesareModel());

    // ── Anello della zona, conformato al terreno ──
    // Raggio misurato come il server: l'angolo della zona a quota di volo,
    // riportato sul terreno lungo i raggi del pianeta.
    const outer = hit.radius * Math.tan(CONQUEST_ZONE_ANGLE);
    this.ringMat = cloneShared(ringTemplate());
    const ring = new THREE.Mesh(
      createConformingBandGeometry(this._siteDir, outer - ZONE_RING_WIDTH, outer, { segments: 96, rings: 2, lift: 0.14 }),
      this.ringMat,
    );
    // Dopo il mare (renderOrder 1): dove l'anello esce in acqua non sparisce.
    ring.renderOrder = 1.2;
    ring.matrixAutoUpdate = false;
    this.ring = ring;
    scene.add(ring);

    // ── Nastro alla quota di volo: il confine dove vola l'aereo, senza la
    // parallasse dell'anello a terra (6 unità più in basso).
    this.ribbon = null;
    this.ribbonMat = null;
    if (!isObjectiveLowQuality()) {
      this.ribbonMat = cloneShared(ribbonTemplate());
      this.ribbon = new THREE.Mesh(createRibbonGeometry(this._siteDir), this.ribbonMat);
      this.ribbon.renderOrder = 3;
      this.ribbon.matrixAutoUpdate = false;
      this.ribbon.frustumCulled = false;
      this.ribbon.visible = false;
      scene.add(this.ribbon);
    }

    /** Scene di appartenenza (serve a spawnMuzzleFlash per aggiungere effetti). */
    this._scene = scene;
    scene.add(this.group);
  }

  _buildFallback() {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xc0c0c0, flatShading: true });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.4, 1.5), mat);
    body.position.y = 1.2;
    g.add(body);
    return g;
  }

  _attachPreModel() {
    if (!_preTemplate || !this.group || this.preRoot) return;
    if (this._fallback) {
      this.neutralWrapper.remove(this._fallback);
      this._fallback = null;
    }
    this.preRoot = _preTemplate.clone(true);
    this.preRoot.scale.setScalar(PRE_SCALE);
    this._flag = this.preRoot.getObjectByName('outpost-flag') ?? null;
    this._flagInfo = _preTemplate.userData.flag ?? null;
    if (this._flag) {
      // Unico materiale per-istanza dell'avamposto: il colore della bandiera.
      this._flagMat = this._flag.material.clone();
      this._flag.material = this._flagMat;
      this._applyFlagColor();
    }
    this.neutralWrapper.add(this.preRoot);
  }

  _attachCesareModel() {
    if (!_cesareTemplate || !this.group || this.cesareRoot) return;
    this.cesareRoot = _cesareTemplate.clone(true);
    this.cesareRoot.scale.setScalar(CESARE_SCALE);

    // Turret_Pivot + Cannone sono già pronti nel glTF: ruotando il nodo
    // ruotiamo attorno al pivot (il transform locale del nodo incarna il pivot).
    this.turretPivot = this.cesareRoot.getObjectByName('Turret_Pivot') || null;
    if (this.turretPivot) {
      // yaw (Y) applicato prima della pitch (X): così l'alzo è coerente
      // con la direzione puntata orizzontalmente.
      this.turretPivot.rotation.order = 'YXZ';
    }

    // Geometrie e materiali sono condivisi con il modello; si clonano solo
    // i due materiali che prendono il colore del proprietario.
    this._cesareMats = [];
    this.cesareRoot.traverse((o) => {
      if (!o.isMesh || !OWNER_TINT_MATERIALS.has(o.material?.name)) return;
      o.material = o.material.clone();
      this._cesareMats.push(o.material);
    });
    this._tintedWith = null;
    if (this.ownerColor) this._applyOwnerTint(this.ownerColor);

    this.conqueredWrapper.add(this.cesareRoot);
  }

  /**
   * Tinta solo i materiali `Gesso (5)` e `Gesso (7)` col colore del
   * proprietario. Gli altri materiali (Gesso, Gesso (1), mat20, …) rimangono
   * con il baseColorFactor originale del glTF.
   */
  _applyOwnerTint(colorInput) {
    if (!colorInput || this._cesareMats.length === 0) return;
    // Ritinta solo se il proprietario è cambiato.
    if (this._tintedWith === colorInput) return;
    this._tintedWith = colorInput;
    _tintColor.set(colorInput);
    for (const m of this._cesareMats) m.color?.copy(_tintColor);
  }

  _applyFlagColor() {
    if (!this._flagMat) return;
    if (this._mode === MODE_CAPTURING || (this.conqueringPlayerId && this.conquestProgress > 0)) {
      this._flagMat.color.copy(this._conquerorColor);
    } else {
      this._flagMat.color.set(NEUTRAL_FLAG_COLOR);
    }
  }

  /**
   * Aggiorna lo stato visivo dell'edificio (evento `buildings`, solo quando
   * cambia). Mira del cannone, anello, bandiera, beacon e laser sono animati
   * per frame (vedi tick, aimAt, drawLaser).
   * @param {object} state
   * @param {number} [nightFactor]
   * @param {string} [conquerorColor]  colore di chi sta conquistando
   */
  update(state, nightFactor = 0, conquerorColor = null) {
    const wasOwner = this.ownerId;
    const hadState = this._hasState;
    this._hasState = true;
    this.ownerId = state.ownerId;
    this.ownerColor = state.ownerColor;
    this.conquestProgress = state.conquestProgress;
    this.conqueringPlayerId = state.conqueringPlayerId ?? null;
    if (state.turretTargetId && !this.turretTargetId) this._aimSince = performance.now();
    this.turretTargetId = state.turretTargetId;
    this._nightFactor = nightFactor;

    const isConquered = !!state.ownerId;
    this.neutralWrapper.visible = !isConquered;
    this.conqueredWrapper.visible = isConquered;

    if (conquerorColor) this._conquerorColor.set(conquerorColor);
    else if (!this.conqueringPlayerId) this._conquerorColor.set(0xffffff);

    const u = this.ringMat.uniforms;
    if (isConquered && state.ownerColor) {
      this._applyOwnerTint(state.ownerColor);
      u.uColor.value.set(state.ownerColor);
      this.ribbonMat?.uniforms.uColor.value.set(state.ownerColor);
    } else {
      u.uColor.value.set(NEUTRAL_FLAG_COLOR);
      this.ribbonMat?.uniforms.uColor.value.set(NEUTRAL_FLAG_COLOR);
    }
    u.uProgColor.value.copy(this._conquerorColor);
    this.ribbonMat?.uniforms.uProgColor.value.copy(this._conquerorColor);

    if (isConquered) this._shownProgress = 0;
    this._updateMode();
    this._applyFlagColor();

    // Conquista appena completata: la torretta spunta con un rimbalzo e parte
    // uno scoppio di coriandoli nel colore del nuovo proprietario. Non al
    // primo stato ricevuto (entrando in partita le torrette sono già lì).
    const justConquered = hadState && !wasOwner && isConquered;
    if (justConquered) this.celebrate();
    return justConquered;
  }

  /**
   * True se un aereo in (x, y, z) è nella zona di conquista: stessa misura
   * del server (edificio a PLANET_RADIUS, distanza cartesiana).
   */
  zoneContains(x, y, z) {
    const dx = x - this.sitePoint.x;
    const dy = y - this.sitePoint.y;
    const dz = z - this.sitePoint.z;
    return dx * dx + dy * dy + dz * dz < BUILDING_CONQUEST_RADIUS * BUILDING_CONQUEST_RADIUS;
  }

  /** Scoppio di conquista (chiamato da update). */
  celebrate() {
    this._popT = 0;
    this.conqueredWrapper.scale.setScalar(0.001);
    _burstPos.copy(this._siteDir).multiplyScalar(this.group.position.length() + 2.2);
    const owner = this.ownerColor ?? '#ffffff';
    spawnObjectiveBurst(_burstPos, [owner, '#ffffff', owner, '#ffe38a'], {
      count: 26, speed: 7.5, ringSize: 9, ringColor: glowColorFor(owner, _fxColor),
    });
  }

  /**
   * Chi c'è nella zona, calcolato dal client sulle posizioni disegnate
   * (main.js). Serve allo stato "conteso": il server azzera il progresso con
   * due aerei in zona, e senza segnale la barra spariva senza spiegazione.
   * @param {boolean} localInside   l'aereo locale è nella zona
   * @param {number} contenders     aerei vivi in zona che possono conquistarla
   * @param {THREE.Vector3|null} [localPos]  posizione disegnata dell'aereo locale
   */
  setZoneState(localInside, contenders, localPos = null) {
    this._inside = localInside ? 1 : 0;
    this._contenders = contenders;
    this._localPos = localPos;
  }

  /** Progresso di conquista come lo mostra l'anello (0..1, levigato): per l'HUD. */
  get captureProgress() { return this._shownProgress; }

  /** 'neutral' | 'capturing' | 'owned' | 'contested': per l'HUD. */
  get zoneMode() { return ZONE_MODE_NAMES[this._mode]; }

  /** L'aereo locale è nella zona di conquista (vedi setZoneState). */
  get localInside() { return this._inside === 1; }

  _updateMode() {
    let mode;
    if (this.ownerId) mode = MODE_OWNED;
    else if (this._contenders >= 2) mode = MODE_CONTESTED;
    else if (this.conqueringPlayerId && (this.conquestProgress > 0 || this._shownProgress > 0.002)) mode = MODE_CAPTURING;
    else if (this._shownProgress > 0.002) mode = MODE_CAPTURING;
    else mode = MODE_NEUTRAL;
    if (mode !== this._mode) {
      this._mode = mode;
      this._applyFlagColor();
    }
    this.ringMat.uniforms.uMode.value = mode;
    if (this.ribbonMat) this.ribbonMat.uniforms.uMode.value = mode;
  }

  /**
   * Avanzamento per frame: progresso levigato, anello, nastro, bandiera,
   * rimbalzo della conquista e beacon.
   */
  tick(delta, nightFactor, camera) {
    const dt = Math.min(Math.max(delta || 0, 0), 0.1);
    this._time += dt;
    if (typeof nightFactor === 'number') this._nightFactor = nightFactor;

    // Il server manda il progresso ~10 volte al secondo, arrotondato al
    // centesimo: qui lo si insegue alla velocità vera della conquista, e lo
    // si lascia cadere subito quando il server lo azzera (contesa, cambio).
    const target = this.ownerId ? 0 : THREE.MathUtils.clamp(this.conquestProgress || 0, 0, 1);
    const diff = target - this._shownProgress;
    if (diff < -0.08) this._shownProgress = Math.max(target, this._shownProgress - dt * 2.5);
    else {
      const rate = 1.6 / BUILDING_CONQUEST_TIME;
      this._shownProgress += THREE.MathUtils.clamp(diff, -rate * dt, rate * dt);
    }
    this._updateMode();

    const ru = this.ringMat.uniforms;
    ru.uProgress.value = this._shownProgress;
    const inside = this.ownerId ? 0 : this._inside;
    ru.uInside.value += (inside - ru.uInside.value) * Math.min(1, dt * 6);

    if (this.ribbon && camera) {
      // Solo sugli avamposti conquistabili: una torretta non si conquista.
      const d = _camRel.copy(camera.position).distanceTo(this._siteAir);
      const fade = this.ownerId ? 0 : 1 - THREE.MathUtils.smoothstep(d, RIBBON_FADE_NEAR, RIBBON_FADE_FAR);
      const fu = this.ribbonMat.uniforms;
      fu.uFade.value = fade;
      fu.uProgress.value = this._shownProgress;
      fu.uInside.value = ru.uInside.value;
      if (this._localPos) fu.uPlane.value.copy(this._localPos);
      else fu.uPlane.value.set(0, 0, 1e4);
      this.ribbon.visible = fade > 0.01;
    }

    if (this._flag && this._flagInfo && this.neutralWrapper.visible) {
      // Sale lungo l'asta col progresso e sventola attorno all'asta.
      const f = this._flagInfo;
      this._flag.position.copy(f.attach).addScaledVector(f.axis, f.rise * this._shownProgress);
      const sway = Math.sin(this._time * 2.3) * 0.26 + Math.sin(this._time * 3.7) * 0.08;
      this._flag.quaternion.setFromAxisAngle(f.axis, sway);
    }

    if (this._popT < 1) {
      this._popT = Math.min(1, this._popT + dt / 0.55);
      this.conqueredWrapper.scale.setScalar(Math.max(0.001, easeOutBack(this._popT)));
    }

    this._updateBeacon();
  }

  /**
   * Beacon in cima allo stendardo. Prima era un puntino di 0.045 unità che
   * compariva solo di notte e solo col bloom (in qualità bassa, invisibile):
   * ora è un alone con una dimensione minima sullo schermo, tenue di giorno e
   * lampeggiante di notte.
   */
  _updateBeacon() {
    if (!this.ownerId || !this.turretPivot || !this.conqueredWrapper.visible || !glows) return;
    const nightVis = smooth01((this._nightFactor - 0.45) / 0.3);
    const day = 0.5 + 0.18 * Math.sin(this._time * 2.6);
    const night = 0.25 + 1.5 * blinkGate(this._time);
    const intensity = day * (1 - nightVis) + night * nightVis;
    _beaconPos.copy(BEACON_TIP_PIVOT_LOCAL);
    this.turretPivot.localToWorld(_beaconPos);
    glowColorFor(this.ownerColor, _fxColor, intensity);
    glows.add(_beaconPos, BEACON_SIZE, _fxColor, 0, BEACON_MIN_PX, 0.35 * (1 - nightVis));
  }

  /** Punta il cannone verso un punto world (l'aereo bersaglio come è disegnato). */
  aimAt(worldPos) {
    if (!this.turretPivot || !this.cesareRoot || !this.conqueredWrapper.visible) return;

    // Coord del bersaglio nel frame locale del cesareRoot (pre-scale).
    const targetLocal = this.cesareRoot.worldToLocal(_aimWorld.copy(worldPos));

    const dx = targetLocal.x - TURRET_PIVOT_LOCAL.x;
    const dy = targetLocal.y - TURRET_PIVOT_LOCAL.y;
    const dz = targetLocal.z - TURRET_PIVOT_LOCAL.z;

    const yaw = Math.atan2(dx, dz);
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    const pitch = -Math.atan2(dy, horizDist);

    this.turretPivot.rotation.y = yaw;
    this.turretPivot.rotation.x = pitch;
  }

  /**
   * Laser di puntamento dal cannone al bersaglio. La carica sale con il tempo
   * dall'ultimo colpo (la torretta spara ogni TURRET_FIRE_RATE secondi):
   * tratteggiato e tenue appena dopo un colpo, pieno e brillante quando il
   * prossimo sta per partire. Il colpo diventa leggibile e schivabile.
   */
  drawLaser(targetPos, now) {
    if (!segments || !this.turretPivot || !this.conqueredWrapper.visible || !this.ownerId) return;
    // Un turretTargetId rimasto indietro (lo stato arriva solo quando cambia)
    // non deve tirare un laser attraverso mezzo pianeta.
    if (targetPos.distanceToSquared(this.sitePoint) > LASER_MAX_DIST * LASER_MAX_DIST) return;
    if (!this.getCannonTipWorld(_laserFrom)) return;
    const since = now - Math.max(this.lastShotAt, this._aimSince);
    const charge = THREE.MathUtils.clamp(since / TURRET_FIRE_MS, 0, 1);
    const width = 0.05 + 0.08 * THREE.MathUtils.smoothstep(charge, 0.75, 1);
    glowColorFor(this.ownerColor, _fxColor);
    segments.add(_laserFrom, targetPos, width, _fxColor, SEG_LASER, charge, 0.55);
  }

  /**
   * Ritorna (riusa `out`) la posizione world dell'estremità del cannone,
   * tenendo conto di yaw/pitch correnti del Turret_Pivot e dello scale.
   * Ritorna null se la torretta non è disponibile.
   */
  getCannonTipWorld(out = new THREE.Vector3()) {
    if (!this.turretPivot) return null;
    out.copy(CANNON_TIP_PIVOT_LOCAL);
    this.turretPivot.updateWorldMatrix(true, false);
    this.turretPivot.localToWorld(out);
    return out;
  }

  /** Muzzle flash visivo (sferetta che si espande e svanisce) all'estremità del cannone. */
  spawnMuzzleFlash() {
    this.lastShotAt = performance.now();
    if (!this.conqueredWrapper.visible) return;
    const tip = this.getCannonTipWorld();
    if (!tip) return;
    muzzleFlashes.spawn(tip, this.ownerColor || '#ffdd88');
  }

  dispose(scene) {
    scene.remove(this.group);
    if (this.ring) {
      scene.remove(this.ring);
      this.ring.geometry.dispose();
    }
    if (this.ribbon) {
      scene.remove(this.ribbon);
      this.ribbon.geometry.dispose();
    }
    this.ringMat?.dispose();
    this.ribbonMat?.dispose();
    this._flagMat?.dispose();
    for (const m of this._cesareMats) m.dispose?.();
    this._cesareMats = [];
  }
}

/**
 * Copie nascoste di tutto ciò che un edificio può mostrare (avamposto,
 * torretta conquistata con i materiali tintati, anello, nastro), da mettere
 * nella scena prima della pre-compilazione degli shader. Senza, i programmi
 * della torretta conquistata si compilavano alla prima conquista.
 */
export function createBuildingPrototypes() {
  const g = new THREE.Group();
  g.name = 'building-prototypes';
  if (_preTemplate) {
    const pre = _preTemplate.clone(true);
    const flag = pre.getObjectByName('outpost-flag');
    if (flag) flag.material = flag.material.clone();
    g.add(pre);
  }
  if (_cesareTemplate) {
    const ces = _cesareTemplate.clone(true);
    ces.traverse((o) => {
      if (o.isMesh && OWNER_TINT_MATERIALS.has(o.material?.name)) o.material = o.material.clone();
    });
    g.add(ces);
  }
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
  g.add(new THREE.Mesh(tri, ringTemplate()));
  if (!isObjectiveLowQuality()) g.add(new THREE.Mesh(tri, ribbonTemplate()));
  return g;
}

// ── Muzzle flash: pool fisso, zero allocazioni per sparo ──────────────────────
//
// Prima ogni colpo di torretta creava una SphereGeometry, un MeshBasicMaterial,
// una PointLight e un proprio ciclo requestAnimationFrame. Con più torrette
// attive significava spazzatura continua per il GC e — soprattutto — un
// conteggio luci della scena che oscillava a ogni sparo, con conseguente
// ricompilazione di tutti gli shader. Qui c'è un pool statico: le mesh esistono
// già, le luci arrivano dal pool a numero fisso e l'animazione gira nel tick
// unico degli effetti.

const MUZZLE_POOL_SIZE = 4;
const MUZZLE_DURATION = 0.14;   // secondi
const MUZZLE_LIGHT_INTENSITY = 2.6;
const _muzzleGeo = new THREE.SphereGeometry(0.35, 8, 8);

class MuzzleFlashPool {
  constructor() {
    this.slots = [];
    this.next = 0;
    this._scene = null;
    this._lights = [];
  }

  /** Registra le mesh nella scena (prima di renderer.compile) e prende le luci. */
  init(scene) {
    if (this._scene) return;
    this._scene = scene;

    for (let i = 0; i < MUZZLE_POOL_SIZE; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffdd88,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(_muzzleGeo, material);
      mesh.renderOrder = 4;
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.slots.push({ mesh, material, time: MUZZLE_DURATION, light: null });
    }

    // Due luci condivise a rotazione: bastano, e restano nella scena per sempre.
    for (let i = 0; i < 2; i++) {
      const slot = lightPool.acquire(6, 2);
      if (slot) this._lights.push(slot);
    }
  }

  spawn(worldPos, color) {
    if (!this._scene) return;
    const slot = this.slots[this.next % MUZZLE_POOL_SIZE];
    this.next++;

    slot.mesh.position.copy(worldPos);
    slot.mesh.scale.setScalar(1);
    slot.mesh.visible = true;
    slot.material.color.set(color);
    slot.material.opacity = 0.95;
    slot.time = 0;

    slot.light = this._lights.length
      ? this._lights[this.next % this._lights.length]
      : null;
    if (slot.light) slot.light.set(worldPos, color, MUZZLE_LIGHT_INTENSITY);
  }

  tick(delta) {
    for (const slot of this.slots) {
      if (slot.time >= MUZZLE_DURATION) continue;
      slot.time += delta;
      const t = Math.min(1, slot.time / MUZZLE_DURATION);
      if (t >= 1) {
        slot.mesh.visible = false;
        slot.material.opacity = 0;
        if (slot.light) { slot.light.off(); slot.light = null; }
        continue;
      }
      slot.mesh.scale.setScalar(1 + t * 2.2);
      slot.material.opacity = 0.95 * (1 - t);
      if (slot.light) slot.light.light.intensity = MUZZLE_LIGHT_INTENSITY * (1 - t);
    }
  }
}

export const muzzleFlashes = new MuzzleFlashPool();

// ── Distruzione torretta: geometrie e materiali pre-allocati ──────────────────
// Dimensioni e colori deterministici precalcolati per evitare new Geometry a runtime.
const SHARD_COUNT = 14;
const _shardSizes  = [0.10, 0.22, 0.15, 0.30, 0.18, 0.25, 0.12, 0.28, 0.20, 0.13, 0.26, 0.17, 0.23, 0.11];
const _shardColors = [0xaaaaaa, 0x886644, 0xaaaaaa, 0x886644, 0xaaaaaa, 0x886644, 0xaaaaaa,
                      0x886644, 0xaaaaaa, 0x886644, 0xaaaaaa, 0x886644, 0xaaaaaa, 0x886644];
const _shardGeos = _shardSizes.map((s, i) =>
  i % 2 === 0 ? new THREE.BoxGeometry(s, s, s) : new THREE.TetrahedronGeometry(s),
);
const _shardMats = _shardColors.map(c =>
  new THREE.MeshLambertMaterial({ color: c, flatShading: true, transparent: true }),
);
const _flashGeo = new THREE.SphereGeometry(1.5, 6, 6);
const _flashMat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true });

// Velocità angolari precalcolate (rad/frame) per evitare moltiplicazioni ripetute
const _shardAngles = Array.from({ length: SHARD_COUNT }, (_, i) =>
  (i / SHARD_COUNT) * Math.PI * 2 + (i % 3) * 0.1,
);
const _shardSpeeds = [1.5, 2.8, 2.1, 3.2, 1.8, 2.5, 2.0, 3.4, 1.6, 2.9, 2.3, 1.7, 3.0, 2.2];
const _shardVY0    = [2.0, 4.5, 3.2, 4.0, 2.8, 3.8, 3.5, 4.8, 2.3, 4.2, 3.6, 2.6, 4.1, 3.3];

// Pool di effetti (max 3 simultanei)
const DESTR_POOL_SIZE = 3;
const _destrPool = Array.from({ length: DESTR_POOL_SIZE }, () => {
  const group = new THREE.Group();
  group.visible = false;
  const shards = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const mesh = new THREE.Mesh(_shardGeos[i], _shardMats[i].clone());
    group.add(mesh);
    shards.push({ mesh, vx: 0, vy: 0, vz: 0 });
  }
  const flash = new THREE.Mesh(_flashGeo, _flashMat.clone());
  group.add(flash);
  group._shards = shards;
  group._flash = flash;
  return group;
});
let _destrPoolIdx = 0;
const DESTR_DURATION = 1.2;   // secondi
const DESTR_GRAVITY = -8;

/**
 * Registra nella scena i pool degli effetti torretta.
 *
 * Vanno aggiunti *prima* di `renderer.compile()`: se una mesh entra in scena
 * per la prima volta durante la partita, il suo shader viene compilato in quel
 * momento e il gioco si inchioda proprio sull'esplosione.
 */
export function initTurretEffects(scene) {
  for (const group of _destrPool) {
    if (!group.parent) scene.add(group);
  }
  muzzleFlashes.init(scene);
}

/**
 * Effetto particellare di distruzione torre. L'animazione avanza nel tick unico
 * degli effetti (`tickTurretEffects`), non in un proprio requestAnimationFrame.
 */
export function spawnTurretDestruction(scene, theta, phi, radius = PLANET_RADIUS + 1.5) {
  const pos = sphericalToCartesian(theta, phi, radius);

  const group = _destrPool[_destrPoolIdx % DESTR_POOL_SIZE];
  _destrPoolIdx++;

  group.position.set(pos.x, pos.y, pos.z);
  group.visible = true;
  if (!group.parent) scene.add(group);

  const { _shards: shards, _flash: flash } = group;

  for (let i = 0; i < SHARD_COUNT; i++) {
    const s = shards[i];
    const speed = _shardSpeeds[i];
    s.vx = Math.cos(_shardAngles[i]) * speed;
    s.vz = Math.sin(_shardAngles[i]) * speed;
    s.vy = _shardVY0[i];
    s.mesh.position.set(0, 0, 0);
    s.mesh.rotation.set(0, 0, 0);
    s.mesh.material.opacity = 1;
  }
  flash.scale.setScalar(1);
  flash.material.opacity = 0.9;
  group._elapsed = 0;
}

/** Avanza esplosioni di torretta e vampate di sparo. Chiamato una volta per frame. */
export function tickTurretEffects(delta) {
  const dt = Math.min(delta, 0.05); // protegge da scatti dopo un freeze o un tab in background

  for (const group of _destrPool) {
    if (!group.visible) continue;
    group._elapsed = (group._elapsed ?? 0) + dt;
    const t = group._elapsed / DESTR_DURATION;
    if (t >= 1) { group.visible = false; continue; }

    const op = 1 - t;
    for (const s of group._shards) {
      s.vy += DESTR_GRAVITY * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += dt * 5;
      s.mesh.rotation.z += dt * 3;
      s.mesh.material.opacity = op;
    }
    group._flash.scale.setScalar(1 + t * 3);
    group._flash.material.opacity = Math.max(0, 0.9 - t * 1.5);
  }

  muzzleFlashes.tick(dt);
}
