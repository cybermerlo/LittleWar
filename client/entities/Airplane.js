import * as THREE from 'three';
import { createGLTFLoader } from '../utils/createGLTFLoader.js';
import { lightPool } from '../scene/LightPool.js';
import { sphericalToCartesian, cartesianToSpherical, sphereOrientation } from '../utils/SphereUtils.js';
import { advanceOnSphere } from '../../shared/movement.js';
import {
  FLY_ALTITUDE,
  MAX_BANK_ANGLE,
  BANK_GAIN,
  BANK_SMOOTH,
  BANK_MAX_DH_FRAME,
  RESPAWN_INVINCIBILITY,
} from '../../shared/constants.js';
import { wingTrails } from './TrailRibbons.js';
import { aircraftFx } from './AircraftFx.js';
import {
  makePlaneLookUniforms,
  dressPlaneMaterial,
  glossFor,
  propDiscGeometry,
  propDiscMaterial,
  shieldGeometry,
  shieldMaterial,
} from './airplaneLook.js';

const _rollQuat = new THREE.Quaternion();
const _orientQuat = new THREE.Quaternion();
const _bankOnlyQuat = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
/**
 * Aerei remoti: dead reckoning.
 *
 * Il game-state dice dove era un aereo quando il server l'ha spedito. Invece di
 * inseguire quel punto (e mostrare l'aereo sempre un po' indietro), si
 * estrapola il volo fino ad *adesso* con velocità e virata ricevute. Quando
 * arriva uno stato nuovo, lo scarto tra la vecchia e la nuova stima viene
 * assorbito in modo morbido invece che con uno scatto.
 */
const REMOTE_ERROR_TAU = 0.12;        // s: tempo di assorbimento degli scarti
const REMOTE_SNAP_DISTANCE = 7;       // unità: oltre, teletrasporto (respawn, lag enorme)
const REMOTE_MAX_EXTRAPOLATION = 0.6; // s: oltre non si inventa più nulla
const REMOTE_MAX_TURN_EXTRAPOLATION = 0.35; // s: la virata dichiarata non dura per sempre
const _predA = new THREE.Vector3();
const _predB = new THREE.Vector3();
const _modelLoader = createGLTFLoader();
const _modelTemplateCache = new Map();

const MODEL_PATHS = {
  spitfire: '/models/spitfire.glb',
};

const MODEL_VISUAL_CONFIG = {
  // spitfire: naso verso -Z → yaw = -π/2; colore giocatore solo su "blue".
  // `propHub` è il nodo animato dalla clip "helice" (GLTFLoader toglie il
  // punto dal nome): se sparisce dopo una decimazione si torna alle pale animate.
  spitfire: {
    yaw: -Math.PI / 2, size: 2.2, tintMaterials: ['blue'], propSpeed: 4.5,
    propHub: ['Cube004_1', 'Cube.004_1'],
  },
};
const BOOST_PARTICLE_COUNT = 84;
const BOOST_PARTICLE_SPAWN_RATE = 180; // particelle/s a boost pieno

const _tailLocal = new THREE.Vector3(-1.1, 0, 0);
const _tailWorld = new THREE.Vector3();
const _forward = new THREE.Vector3(1, 0, 0);
const _backward = new THREE.Vector3();
const _right = new THREE.Vector3(0, 0, 1);
const _up = new THREE.Vector3(0, 1, 0);

const TRAIL_MAX_LENGTH = 10;
const _leftTipLocal = new THREE.Vector3(0, 0, -1.1);
const _rightTipLocal = new THREE.Vector3(0, 0, 1.1);
const _tipTemp = new THREE.Vector3();

// Luci di navigazione: rossa a sinistra, verde a destra, fisse come quelle
// vere, più un doppio lampo bianco anticollisione. Di giorno restano dei
// puntini: aiutano a individuare un aereo lontano, che altrimenti è un
// granello scuro sul terreno.
const NAV_Y_OFFSET = 0.03;
const NAV_SIZE = 0.12;
const NAV_DAY = 0.7;
const NAV_NIGHT = 3.0;          // oltre la soglia del bloom
const NAV_STROBE_PERIOD = 1.4;  // s
const NAVLIGHT_POINT_DISTANCE = 0.55;
const NAVLIGHT_POINT_DECAY = 2.0;
const NAVLIGHT_POINT_INTENSITY = 2.4;
const SPIN_DURATION = 0.48;

// Vampata: i due slot del LightPool dell'aereo locale, di giorno spenti,
// fanno da lampo sulle ali per 60 ms. Nessuna luce nuova: conteggio invariato.
const MUZZLE_LIGHT_TIME = 0.06;
const MUZZLE_LIGHT_DISTANCE = 5;
const MUZZLE_LIGHT_INTENSITY = 3;

// Elica: giri al secondo del disco (lento di proposito: a 5-10 giri/s tre
// scie a 60 fps tornerebbero stroboscopiche).
const PROP_REV_BASE = 2.2;
const PROP_REV_BOOST = 2.4;

const SHIELD_POP_TIME = 0.25;
/** Dopo una rottura lo scudo resta nascosto anche se un game-state vecchio dice ancora "scudo". */
const SHIELD_BREAK_HOLD_MS = 600;

/** Scratch condivisi: `update()` gira per ogni aereo a ogni frame. */
const _rightW = new THREE.Vector3();
const _upW = new THREE.Vector3();
const _navWorld = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1);
const _muzzleWarm = new THREE.Color(1.6, 1.25, 0.72);

function smooth01(x) {
  return THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(x, 0, 1), 0, 1);
}

/** Doppio lampo anticollisione: 0..1. */
function strobe(t) {
  const p = t % NAV_STROBE_PERIOD;
  return (p < 0.05 || (p > 0.16 && p < 0.21)) ? 1 : 0;
}

function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function buildFallbackAirplaneMesh(color, look, ownMaterials) {
  const group = new THREE.Group();
  const mat = (c) => {
    const m = dressPlaneMaterial(new THREE.MeshLambertMaterial({ color: c, flatShading: true }), look, 0.2);
    ownMaterials.push(m);
    return m;
  };
  const bodyColor = new THREE.Color(color);
  const darkColor = bodyColor.clone().multiplyScalar(0.65);
  const lightColor = bodyColor.clone().lerp(new THREE.Color(0xffffff), 0.35);

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.28, 0.28), mat(bodyColor));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 5), mat(lightColor));
  const wings = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 2.2), mat(darkColor));
  const tailV = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.38, 0.22), mat(darkColor));
  const tailH = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.8), mat(darkColor));

  nose.rotation.z = -Math.PI / 2;
  nose.position.set(0.95, 0, 0);
  wings.position.set(-0.1, 0, 0);
  tailV.position.set(-0.6, 0.2, 0);
  tailH.position.set(-0.6, 0.05, 0);

  group.add(body, nose, wings, tailV, tailH);
  return group;
}

function getModelTemplate(modelName) {
  const safeModelName = MODEL_PATHS[modelName] ? modelName : 'spitfire';
  if (_modelTemplateCache.has(safeModelName)) {
    return _modelTemplateCache.get(safeModelName);
  }

  const templatePromise = new Promise((resolve) => {
    _modelLoader.load(
      MODEL_PATHS[safeModelName],
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
      undefined,
      () => resolve(null),
    );
  });
  _modelTemplateCache.set(safeModelName, templatePromise);
  return templatePromise;
}

/**
 * Veste il modello per questo aereo: OGNI materiale viene clonato (le uniform
 * del rim sono per aereo, vedi airplaneLook.js), quelli elencati prendono il
 * colore del giocatore.
 * @param {string[]|null} tintMaterials  nomi dei materiali da tingere; null = tutti
 */
function dressModel(instance, color, tintMaterials, look, ownMaterials) {
  const tintColor = new THREE.Color(color);
  const shouldTint = (mat) => !tintMaterials || tintMaterials.includes(mat.name);
  const dress = (mat) => {
    const cloned = mat.clone();
    if (shouldTint(mat) && cloned.color) cloned.color.copy(tintColor);
    dressPlaneMaterial(cloned, look, glossFor(mat.name));
    ownMaterials.push(cloned);
    return cloned;
  };
  instance.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    obj.material = Array.isArray(obj.material) ? obj.material.map(dress) : dress(obj.material);
  });
}

function fitModelToSize(instance, modelName) {
  const config = MODEL_VISUAL_CONFIG[modelName] ?? MODEL_VISUAL_CONFIG.spitfire;
  const box = new THREE.Box3().setFromObject(instance);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  const scale = config.size / maxDimension;
  instance.scale.setScalar(scale);
  instance.position.sub(center.multiplyScalar(scale));
  instance.rotation.y = config.yaw;
}

/**
 * Sostituisce le pale dell'elica con un disco sfocato (vedi airplaneLook.js).
 * Restituisce il disco, o null se il modello non ha il nodo atteso: in quel
 * caso il chiamante tiene l'animazione delle pale.
 */
function installPropDisc(model, cfg) {
  if (!cfg.propHub) return null;
  let hub = null;
  for (const name of cfg.propHub) {
    hub = model.getObjectByName(name);
    if (hub) break;
  }
  if (!hub) return null;
  // Le pale stanno nel piano XY del nodo, sottili in Z: il raggio è la
  // massima estensione in X/Y delle loro geometrie.
  let radius = 0;
  const blades = [];
  hub.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    radius = Math.max(radius, -b.min.x, b.max.x, -b.min.y, b.max.y);
    blades.push(o);
  });
  if (!blades.length || radius <= 0) return null;
  // Tolte dalla gerarchia, non solo nascoste: ~11.7k vertici in meno per aereo.
  for (const o of blades) o.removeFromParent();
  const disc = new THREE.Mesh(propDiscGeometry, propDiscMaterial);
  disc.scale.setScalar(radius * 1.02);
  disc.renderOrder = 2;
  hub.add(disc);
  return disc;
}

/**
 * Scarica e mette in cache i modelli degli aerei prima dell'ingresso in
 * partita. Altrimenti il primo `new Airplane(...)` — che avviene mentre si
 * entra, insieme a tutto il resto — deve fare fetch e parsing del glTF.
 */
export function preloadAirplaneModels() {
  return Promise.all(Object.keys(MODEL_PATHS).map(getModelTemplate));
}

function buildAirplaneMesh(color, modelName, look) {
  const group = new THREE.Group();
  const ownMaterials = [];
  group.userData.ownMaterials = ownMaterials;
  const fallbackMesh = buildFallbackAirplaneMesh(color, look, ownMaterials);
  group.add(fallbackMesh);

  // Geometria e materiale condivisi da tutti gli aerei: prima ognuno aveva
  // la propria SphereGeometry e il proprio MeshBasicMaterial.
  const shieldMesh = new THREE.Mesh(shieldGeometry, shieldMaterial);
  shieldMesh.visible = false;
  shieldMesh.name = 'shield';
  shieldMesh.renderOrder = 4;
  group.add(shieldMesh);

  group.userData.shield = shieldMesh;
  group.userData.fallbackMesh = fallbackMesh;
  // Posizioni punte ali di default (fallback mesh: BoxGeometry wings a (-0.1, 0, ±1.1))
  group.userData.leftTipLocal = new THREE.Vector3(-0.1, 0, -1.1);
  group.userData.rightTipLocal = new THREE.Vector3(-0.1, 0, 1.1);
  group.userData.guns = makeGuns(0.25, 0, -1.1, 1.1);

  getModelTemplate(modelName).then((template) => {
    if (!template || group.userData.disposed) return;

    const model = template.scene.clone(true);
    const cfg = MODEL_VISUAL_CONFIG[modelName] ?? MODEL_VISUAL_CONFIG.spitfire;
    dressModel(model, color, cfg.tintMaterials ?? null, look, ownMaterials);
    fitModelToSize(model, modelName);
    const disc = installPropDisc(model, cfg);

    // Calcola le punte ali PRIMA di aggiungere il modello al gruppo,
    // così setFromObject usa solo la matrice locale del modello (scale/rot/pos da fitModelToSize)
    // e non include la posizione world del gruppo (aereo già posizionato sulla sfera).
    model.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(model);
    const midX = (bbox.min.x + bbox.max.x) / 2;
    const midY = (bbox.min.y + bbox.max.y) / 2;
    group.userData.leftTipLocal = new THREE.Vector3(midX, midY, bbox.min.z);
    group.userData.rightTipLocal = new THREE.Vector3(midX, midY, bbox.max.z);
    // Armi sul bordo d'attacco delle ali, un po' davanti al centro del modello.
    group.userData.guns = makeGuns(midX + 0.17 * (bbox.max.x - bbox.min.x), midY - 0.03, bbox.min.z, bbox.max.z);
    group.userData.onModelReady?.();

    if (group.userData.fallbackMesh) {
      const fb = group.userData.fallbackMesh;
      group.remove(fb);
      fb.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        o.material.dispose();
        const i = ownMaterials.indexOf(o.material);
        if (i >= 0) ownMaterials.splice(i, 1);
      });
      group.userData.fallbackMesh = null;
    }
    group.add(model);
    group.userData.visualModel = model;
    group.userData.propDisc = disc;

    // Senza disco (nodo non trovato): pale vere animate dalla clip del modello.
    if (!disc && template.animations && template.animations.length > 0) {
      const mixer = new THREE.AnimationMixer(model);
      group.userData.mixer = mixer;

      const propClip =
        THREE.AnimationClip.findByName(template.animations, 'helice') ??
        template.animations[0];
      if (propClip) {
        const action = mixer.clipAction(propClip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
        group.userData.propellerAction = action;
        group.userData.propSpeed = cfg.propSpeed ?? 6.0;
      }
    }
  });

  return group;
}

/** Bocche da fuoco: al 35% e al 55% della semiapertura alare, per lato. */
function makeGuns(x, y, zMin, zMax) {
  const zc = (zMin + zMax) / 2;
  const half = (zMax - zMin) / 2;
  return [0.35, 0.55].flatMap((f) => [
    new THREE.Vector3(x, y, zc - half * f),
    new THREE.Vector3(x, y, zc + half * f),
  ]);
}

function createBoostParticleSystem(playerColor = '#ff4444') {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(BOOST_PARTICLE_COUNT * 3);
  const life = new Float32Array(BOOST_PARTICLE_COUNT);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aLife', new THREE.BufferAttribute(life, 1));

  const c = new THREE.Color(playerColor);
  if (!Number.isFinite(c.r + c.g + c.b)) c.set('#888888');
  const playerTint = c.clone();
  playerTint.lerp(new THREE.Color(0xffffff), 0.08);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0xffa31a) },
      uPlayerTint: { value: playerTint },
    },
    vertexShader: `
      attribute float aLife;
      varying float vLife;
      void main() {
        vLife = aLife;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPos;
        // Più piccole in generale; leggermente più strette quando la vita è alta (appena nate)
        float t = pow(clamp(aLife, 0.0, 1.0), 0.85);
        float size = mix(2.0, 7.2, t);
        // Tetto: con la camera avvicinata (rotella) una particella in coda
        // arrivava a 200 px e il boost copriva l'aereo intero.
        gl_PointSize = min(size * (175.0 / max(1.0, -mvPos.z)), 80.0);
      }
    `,
    // Con tone mapping e conversione sRGB: in qualità bassa (senza composer
    // il render va dritto a schermo) uno ShaderMaterial senza questi chunk
    // usciva con colori diversi dal resto della scena.
    fragmentShader: `
      varying float vLife;
      uniform vec3 uColor;
      uniform vec3 uPlayerTint;
      void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float d = length(p);
        float core = smoothstep(0.38, 0.0, d);
        // L'alone si spegne entro il cerchio inscritto (d = 0.5): prima
        // arrivava fino a 0.72, cioè oltre i lati del quad, e decine di
        // particelle sovrapposte disegnavano un quadrato luminoso.
        float glow = smoothstep(0.5, 0.1, d);
        float alpha = (core * 0.72 + glow * 0.22) * vLife;
        if (alpha < 0.01) discard;
        // Centro: bianco caldo; verso il bordo della sprite + in coda alla vita: colore giocatore ben visibile.
        float edge = smoothstep(0.1, 0.46, d);
        float tailPlayer = pow(1.0 - clamp(vLife, 0.0, 1.0), 0.75);
        float playerW = clamp(0.6 + 0.38 * edge + 0.3 * tailPlayer, 0.0, 1.0);
        vec3 innerHot = vec3(1.0, 0.94, 0.78);
        vec3 outerTone = mix(uColor, uPlayerTint, 0.9);
        vec3 rgb = mix(innerHot, outerTone, playerW);
        gl_FragColor = vec4(rgb, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 4;
  // Nessuna particella viva all'inizio: nessuna draw call finché non si usa il boost.
  points.visible = false;

  return { points, geometry, material, positions, life };
}

/**
 * Un aereo invisibile con gli stessi materiali di quelli veri, da mettere in
 * scena prima di `warmupShaders()`: così i programmi GLSL del modello (rim,
 * scudo, disco dell'elica, particelle turbo) si compilano in lobby e non al
 * primo aereo che entra in partita.
 */
export function createAirplaneWarmupMesh(modelName = 'spitfire') {
  const look = makePlaneLookUniforms('#ffffff');
  const group = buildAirplaneMesh('#ffffff', modelName, look);
  group.add(createBoostParticleSystem('#ffffff').points);
  group.visible = false;
  return group;
}

export class Airplane {
  constructor(scene, THREE_ref, color = '#ff4444', modelName = 'airplane', isLocal = false) {
    this._scene = scene;
    this.THREE = THREE_ref;
    this.color = color;
    this._look = makePlaneLookUniforms(color);
    this.mesh = buildAirplaneMesh(color, modelName, this._look);
    this.mesh.userData.isAirplane = true;
    // Per i test visivi (tests/, __lwDebug): dalla mesh in scena all'oggetto.
    // Non enumerabile, così un eventuale JSON.stringify di userData non cicla.
    Object.defineProperty(this.mesh.userData, 'airplane', { value: this, enumerable: false });
    scene.add(this.mesh);
    this.isLocal = isLocal;

    this.theta = Math.PI / 2;
    this.phi = 0;
    this.heading = 0;
    this._bankRoll = 0;
    this._lastHeading = undefined;
    this.sphereQuaternion = new THREE.Quaternion();
    this.flightQuaternion = new THREE.Quaternion();
    /** Velocità stimata (unità/s, world): serve a rottami e schegge. */
    this.velocity = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._hasPrevPos = false;

    /** Ultimo stato di rete (aerei remoti) e scarto ancora da assorbire. */
    this._net = null;
    this._errPos = new THREE.Vector3();
    this._errHeading = 0;
    this._netWeaponLevel = 0;
    this._netHasShield = false;
    /** Boost visivo remoto 0..1 (da game-state server). */
    this._netBoostAmount = 0;
    this._remoteNetReady = false;
    this._fxVisible = true;
    /** Nascosto (morto) dall'ultimo reset: il prossimo `resetRemote` è un respawn. */
    this._hiddenSinceReset = false;
    this._spinDirection = 0;
    this._spinProgress = 0;
    this._spinRoll = 0;

    /** Invulnerabilità post-respawn (performance.now): resa con il rim pulsante. */
    this._invUntil = 0;
    this._shieldShown = false;
    this._shieldPop = SHIELD_POP_TIME;
    this._shieldHoldUntil = 0;
    this._propAngle = Math.random() * Math.PI * 2;

    // Colore della vampata: bianco caldo con una punta del colore del giocatore.
    this._muzzleColor = new THREE.Color(color);
    if (!Number.isFinite(this._muzzleColor.r + this._muzzleColor.g + this._muzzleColor.b)) this._muzzleColor.set('#ffffff');
    this._muzzleColor.lerp(_white, 0.3).multiplyScalar(1.4).lerp(_muzzleWarm, 0.7);
    this._muzzleLightT = 0;
    this._lightMode = 'nav';

    // Luci di navigazione: i puntini sono nel lotto condiviso di AircraftFx.
    this._nightFactor = 0;
    this._navTime = Math.random() * 10; // desincronizza leggermente tra player

    // Le PointLight alari arrivano dal pool a numero fisso e solo per l'aereo
    // locale: aggiungerle e toglierle dalla scena a ogni morte/respawn faceva
    // cambiare il conteggio luci e ricompilare tutti gli shader (vedi
    // scene/LightPool.js). Sugli aerei remoti resta il puntino additivo, che è
    // ciò che si vede davvero a distanza.
    this._navLeftLight = isLocal ? lightPool.acquire(NAVLIGHT_POINT_DISTANCE, NAVLIGHT_POINT_DECAY) : null;
    this._navRightLight = isLocal ? lightPool.acquire(NAVLIGHT_POINT_DISTANCE, NAVLIGHT_POINT_DECAY) : null;

    // Coda particellare turbo (world space): locale e remoti.
    const ps = createBoostParticleSystem(color);
    this._boostPoints = ps.points;
    this._boostGeometry = ps.geometry;
    this._boostMaterial = ps.material;
    this._boostPositions = ps.positions;
    this._boostLife = ps.life;
    this._boostVel = new Float32Array(BOOST_PARTICLE_COUNT * 3);
    this._boostSpawnAcc = 0;
    this._boostHead = 0;
    this._boostAlive = 0;
    this._prevTail = new THREE.Vector3();
    this._hasPrevTail = false;
    scene.add(this._boostPoints);

    // Scie alari: due nastri nella mesh condivisa di TrailRibbons.
    this._trailL = wingTrails.acquire(color);
    this._trailR = wingTrails.acquire(color);
    // Quando arriva il modello vero le punte delle ali si spostano: la scia
    // ricomincia invece di tracciare un gradino.
    this.mesh.userData.onModelReady = () => this._cutTrails();
  }

  /**
   * Forza teletrasporto immediato alla posizione indicata (usato al respawn).
   */
  resetRemote(theta, phi, heading, now = performance.now()) {
    const respawned = this._hiddenSinceReset;
    this._hiddenSinceReset = false;
    this._net = { theta, phi, heading, speed: 0, turnRate: 0, at: now };
    this._errPos.set(0, 0, 0);
    this._errHeading = 0;
    this._remoteNetReady = true;
    this._lastHeading = undefined;
    this.resetFx();
    this.update(theta, phi, heading, this._netWeaponLevel, this._netHasShield, 1 / 60, this._netBoostAmount);
    if (respawned) {
      // Anche chi guarda sa che è inutile sparargli: il rim pulsa come per il nostro.
      this.setInvincibleFor(RESPAWN_INVINCIBILITY);
      aircraftFx.spawnRing(this, this.color);
    }
  }

  /** Posizione (unitaria) e heading stimati all'istante `now` + `leadMs`. */
  _predict(net, now, leadMs, outPos) {
    const dt = Math.min(REMOTE_MAX_EXTRAPOLATION, Math.max(0, (now - net.at + leadMs) / 1000));
    const turnDt = Math.min(dt, REMOTE_MAX_TURN_EXTRAPOLATION);
    let m = advanceOnSphere(net.theta, net.phi, net.heading, net.speed, net.turnRate, turnDt);
    if (dt > turnDt) m = advanceOnSphere(m.theta, m.phi, m.heading, net.speed, 0, dt - turnDt);
    const c = sphericalToCartesian(m.theta, m.phi, 1);
    outPos.set(c.x, c.y, c.z);
    return m.heading;
  }

  /**
   * Nuovo stato dal server.
   * @param {object} p       stato del giocatore (theta, phi, heading, speed, turnRate, …)
   * @param {number} now     performance.now() alla ricezione
   * @param {number} leadMs  latenza di sola andata stimata
   */
  setNetworkState(p, now, leadMs, boostAmount = 0) {
    if (this.isLocal) return;
    this._netWeaponLevel = p.weaponLevel ?? 0;
    this._netHasShield = !!p.hasShield;
    this._netBoostAmount = THREE.MathUtils.clamp(boostAmount, 0, 1);

    const next = {
      theta: p.theta,
      phi: p.phi,
      heading: p.heading,
      speed: Number.isFinite(p.speed) ? p.speed : 0,
      turnRate: Number.isFinite(p.turnRate) ? p.turnRate : 0,
      at: now,
    };

    if (!this._remoteNetReady || !this._net) {
      this.resetRemote(p.theta, p.phi, p.heading, now);
      this._net = next;
      return;
    }

    // Dove lo stavamo mostrando e dove dice ora il server, allo stesso istante.
    const oldH = this._predict(this._net, now, leadMs, _predA);
    const newH = this._predict(next, now, leadMs, _predB);
    this._net = next;
    this._errPos.add(_predA.sub(_predB));
    this._errHeading = wrapAngle(this._errHeading + wrapAngle(oldH - newH));
    if (this._errPos.length() * FLY_ALTITUDE > REMOTE_SNAP_DISTANCE) {
      this._errPos.set(0, 0, 0);
      this._errHeading = 0;
      this._lastHeading = undefined;
      // Teletrasporto: la scia non deve tracciare una corda fino al punto nuovo.
      this.resetFx();
    }
  }

  tickRemote(delta, now, leadMs) {
    if (this.isLocal || !this._remoteNetReady || !this._net) return;
    const decay = Math.exp(-delta / REMOTE_ERROR_TAU);
    this._errPos.multiplyScalar(decay);
    this._errHeading *= decay;

    const h = this._predict(this._net, now, leadMs, _predA);
    _predA.add(this._errPos).normalize();
    const sph = cartesianToSpherical(_predA.x, _predA.y, _predA.z);
    this.update(
      sph.theta,
      sph.phi,
      h + this._errHeading,
      this._netWeaponLevel,
      this._netHasShield,
      delta,
      this._netBoostAmount,
    );
  }

  /** Nasconde le particelle turbo e le scie alari (oggetti separati dalla mesh; es. giocatore morto). */
  setBoostParticlesVisible(visible) {
    if (!visible) this._hiddenSinceReset = true;
    if (!this._boostPoints) return;
    if (this._fxVisible === visible) return;
    this._fxVisible = visible;
    if (!visible) {
      for (let i = 0; i < BOOST_PARTICLE_COUNT; i++) this._boostLife[i] = 0;
      this._boostSpawnAcc = 0;
      this._boostAlive = 0;
      this._hasPrevTail = false;
      this._boostPoints.visible = false;
      this._cutTrails();
    }
  }

  /** Abbattuto: l'aereo sparisce dentro la propria esplosione, con scie e luci. */
  hideForDeath() {
    this.mesh.visible = false;
    this.setBoostParticlesVisible(false);
    this._invUntil = 0;
    this._muzzleLightT = 0;
    // Le luci del pool si spengono, non si nascondono: vedi LightPool.js.
    this._navLeftLight?.off();
    this._navRightLight?.off();
  }

  /** Respawn dell'aereo locale: di nuovo visibile, niente residui della vita precedente. */
  revive(invincibleMs = RESPAWN_INVINCIBILITY) {
    this.mesh.visible = true;
    this._hiddenSinceReset = false;
    this.setBoostParticlesVisible(true);
    this.resetFx();
    this._lastHeading = undefined;
    this._bankRoll = 0;
    this._spinDirection = 0;
    this._spinProgress = 0;
    this._spinRoll = 0;
    this.setInvincibleFor(invincibleMs);
    aircraftFx.spawnRing(this, this.color);
  }

  /** Azzera gli effetti che dipendono dalla storia recente (scie, velocità). */
  resetFx() {
    this._cutTrails();
    this._hasPrevPos = false;
    this._hasPrevTail = false;
    this.velocity.set(0, 0, 0);
  }

  setInvincibleFor(ms) {
    this._invUntil = performance.now() + Math.max(0, ms);
  }

  /** Lo scudo ha assorbito un colpo: schegge, e niente scudo finché il server non ne dà un altro. */
  breakShield() {
    this._shieldHoldUntil = performance.now() + SHIELD_BREAK_HOLD_MS;
    const shield = this.mesh.userData.shield;
    if (shield) shield.visible = false;
    this._shieldShown = false;
    if (this.mesh.visible) aircraftFx.shieldBurst(this);
  }

  /**
   * Vampata alle bocche da fuoco (e, sull'aereo locale, un lampo di luce sulle ali).
   * @param {number} bullets  colpi della raffica: più colpi, vampata più grande
   */
  flashMuzzle(bullets = 1) {
    if (!this.mesh.visible) return;
    const guns = this.mesh.userData.guns;
    if (!guns) return;
    const n = bullets >= 3 ? 4 : 2;
    const size = 0.5 * (1 + 0.15 * Math.min(bullets, 7));
    for (let i = 0; i < n; i++) {
      const g = guns[i];
      aircraftFx.muzzle(this.mesh, g.x, g.y, g.z, size, this._muzzleColor);
    }
    if (this._navLeftLight || this._navRightLight) this._muzzleLightT = MUZZLE_LIGHT_TIME;
  }

  _cutTrails() {
    wingTrails.cut(this._trailL);
    wingTrails.cut(this._trailR);
  }

  setNightFactor(nightFactor) {
    this._nightFactor = THREE.MathUtils.clamp(nightFactor ?? 0, 0, 1);
  }

  triggerSpin(direction = 1) {
    const dir = direction >= 0 ? 1 : -1;
    this._spinDirection = dir;
    this._spinProgress = 0;
    this._spinRoll = 0;
  }

  _updateSpin(delta) {
    if (this._spinDirection === 0) return;
    this._spinProgress = Math.min(1, this._spinProgress + delta / SPIN_DURATION);
    // Ease-out: inizio rapido, chiusura morbida.
    const t = 1 - Math.pow(1 - this._spinProgress, 3);
    this._spinRoll = this._spinDirection * t * Math.PI * 2;
    if (this._spinProgress >= 1) {
      this._spinDirection = 0;
      this._spinProgress = 0;
      this._spinRoll = 0;
    }
  }

  isSpinning() {
    return this._spinDirection !== 0;
  }

  getSpinDirection() {
    return this._spinDirection;
  }

  update(theta, phi, heading, weaponLevel, hasShield, delta = 1 / 60, boostAmount = 0) {
    this.theta = theta;
    this.phi = phi;
    this.heading = heading;
    const now = performance.now();

    const pos = sphericalToCartesian(theta, phi, FLY_ALTITUDE);
    this.mesh.position.set(pos.x, pos.y, pos.z);

    // Velocità dal moto disegnato: vale per il locale e per i remoti.
    if (this._hasPrevPos && delta > 1e-4) {
      _vel.subVectors(this.mesh.position, this._prevPos).divideScalar(delta);
      if (_vel.lengthSq() > 120 * 120) this.velocity.set(0, 0, 0);
      else this.velocity.lerp(_vel, Math.min(1, delta * 10));
    }
    this._prevPos.copy(this.mesh.position);
    this._hasPrevPos = true;

    const q = sphereOrientation(THREE, theta, phi, heading, _orientQuat);

    let dh = 0;
    if (this._lastHeading !== undefined) {
      dh = wrapAngle(heading - this._lastHeading);
    }
    this._lastHeading = heading;

    const dhUse = THREE.MathUtils.clamp(dh, -BANK_MAX_DH_FRAME, BANK_MAX_DH_FRAME);
    const turnRate = delta > 1e-6 ? dhUse / delta : 0;
    const bankTarget = THREE.MathUtils.clamp(
      turnRate * BANK_GAIN,
      -MAX_BANK_ANGLE,
      MAX_BANK_ANGLE,
    );
    const k = 1 - Math.exp(-BANK_SMOOTH * delta);
    this._bankRoll += (bankTarget - this._bankRoll) * k;
    this._updateSpin(delta);

    this.sphereQuaternion.copy(q);
    _bankOnlyQuat.setFromAxisAngle(_axisX, this._bankRoll);
    this.flightQuaternion.copy(q).multiply(_bankOnlyQuat);

    _rollQuat.setFromAxisAngle(_axisX, this._bankRoll + this._spinRoll);
    this.mesh.quaternion.copy(q).multiply(_rollQuat);

    this._updateShield(hasShield, delta, now);
    this._updateLook(now);

    const disc = this.mesh.userData.propDisc;
    if (disc) {
      this._propAngle = (this._propAngle + (PROP_REV_BASE + PROP_REV_BOOST * boostAmount) * Math.PI * 2 * delta) % (Math.PI * 2);
      disc.rotation.z = this._propAngle;
    } else if (this.mesh.userData.mixer) {
      // Modello senza nodo dell'elica riconosciuto: pale vere animate.
      this.mesh.userData.mixer.update(delta);
      if (this.mesh.userData.propellerAction) {
        const base = this.mesh.userData.propSpeed ?? 6.0;
        this.mesh.userData.propellerAction.timeScale = base + boostAmount * base;
      }
    }

    // Una sola volta per frame: le particelle turbo, le scie alari e le luci
    // del pool lavorano tutte in coordinate world e prima ognuna forzava il
    // proprio updateMatrixWorld ricorsivo sull'intera gerarchia del modello.
    this.mesh.updateMatrixWorld(true);

    this._updateBoostParticles(delta, boostAmount);
    this._updateWingtipTrails(now, boostAmount);
    this._updateNavLights(delta);
  }

  _updateShield(hasShield, delta, now) {
    const shield = this.mesh.userData.shield;
    if (!shield) return;
    const want = hasShield && now >= this._shieldHoldUntil;
    if (want && !this._shieldShown) this._shieldPop = 0; // appena raccolto: "pop"
    this._shieldShown = want;
    shield.visible = want;
    if (!want) return;
    if (this._shieldPop < SHIELD_POP_TIME) {
      this._shieldPop = Math.min(SHIELD_POP_TIME, this._shieldPop + delta);
      const t = this._shieldPop / SHIELD_POP_TIME;
      const s = t < 0.6 ? 1.15 * (t / 0.6) : 1.15 - 0.15 * ((t - 0.6) / 0.4);
      shield.scale.setScalar(Math.max(0.01, s));
    } else if (shield.scale.x !== 1) {
      shield.scale.setScalar(1);
    }
  }

  /** Rim, luce propria e verticale per il riflesso (uniform di questo aereo). */
  _updateLook(now) {
    const night = this._nightFactor;
    let rim = 0.35 + 0.55 * night;
    // Gli aerei altrui si staccano un po' di più dal terreno: sono i bersagli.
    if (!this.isLocal) rim = Math.max(rim, 0.5);
    let selfLit = 0.08 * night;
    if (now < this._invUntil) {
      // Invulnerabilità: il bordo pulsa forte invece del lampeggio della
      // mesh, che spegneva a scatti anche luci ed elica.
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.014);
      rim = 0.4 + 1.6 * pulse;
      selfLit += 0.22 * pulse;
    }
    this._look.uRimStrength.value = rim;
    this._look.uSelfLit.value = selfLit;
    this._look.uUpWorld.value.copy(this.mesh.position).normalize();
  }

  _updateNavLights(delta) {
    this._navTime += Math.max(0, delta);
    if (this._muzzleLightT > 0) this._muzzleLightT = Math.max(0, this._muzzleLightT - delta);
    if (!this.mesh.visible) return;

    const left = this.mesh.userData.leftTipLocal ?? _leftTipLocal;
    const right = this.mesh.userData.rightTipLocal ?? _rightTipLocal;
    // Più luminose man mano che scende la sera; di giorno solo un puntino.
    const nightVis = smooth01((this._nightFactor - 0.3) / 0.4);
    const I = NAV_DAY + (NAV_NIGHT - NAV_DAY) * nightVis;
    const flash = nightVis > 0.05 ? strobe(this._navTime) * nightVis : 0;
    const nav = aircraftFx.nav;
    if (nav) {
      _navWorld.set(left.x, left.y + NAV_Y_OFFSET, left.z).applyMatrix4(this.mesh.matrixWorld);
      nav.add(_navWorld, NAV_SIZE, I + 2.5 * flash, 0.12 * I + 2.5 * flash, 0.1 * I + 2.5 * flash);
      _navWorld.set(right.x, right.y + NAV_Y_OFFSET, right.z).applyMatrix4(this.mesh.matrixWorld);
      nav.add(_navWorld, NAV_SIZE, 0.1 * I + 2.5 * flash, I + 2.5 * flash, 0.3 * I + 2.5 * flash);
    }

    if (!this._navLeftLight && !this._navRightLight) return;
    // Le luci del pool vivono nella scena: servono coordinate world.
    if (this._muzzleLightT > 0) {
      if (this._lightMode !== 'muzzle') {
        this._navLeftLight?.configure(MUZZLE_LIGHT_DISTANCE, 2);
        this._navRightLight?.configure(MUZZLE_LIGHT_DISTANCE, 2);
        this._lightMode = 'muzzle';
      }
      const lit = MUZZLE_LIGHT_INTENSITY * (this._muzzleLightT / MUZZLE_LIGHT_TIME);
      const guns = this.mesh.userData.guns;
      if (this._navLeftLight && guns) {
        _navWorld.copy(guns[0]).applyMatrix4(this.mesh.matrixWorld);
        this._navLeftLight.set(_navWorld, 0xffc27a, lit);
      }
      if (this._navRightLight && guns) {
        _navWorld.copy(guns[1]).applyMatrix4(this.mesh.matrixWorld);
        this._navRightLight.set(_navWorld, 0xffc27a, lit);
      }
      return;
    }
    if (this._lightMode !== 'nav') {
      this._navLeftLight?.configure(NAVLIGHT_POINT_DISTANCE, NAVLIGHT_POINT_DECAY);
      this._navRightLight?.configure(NAVLIGHT_POINT_DISTANCE, NAVLIGHT_POINT_DECAY);
      this._lightMode = 'nav';
    }
    // Di giorno le luci del pool restano spente (intensità 0, mai nascoste).
    const lit = nightVis * NAVLIGHT_POINT_INTENSITY;
    if (this._navLeftLight) {
      _navWorld.set(left.x, left.y + NAV_Y_OFFSET, left.z).applyMatrix4(this.mesh.matrixWorld);
      this._navLeftLight.set(_navWorld, 0xff3344, lit);
    }
    if (this._navRightLight) {
      _navWorld.set(right.x, right.y + NAV_Y_OFFSET, right.z).applyMatrix4(this.mesh.matrixWorld);
      this._navRightLight.set(_navWorld, 0x33ff66, lit);
    }
  }

  _updateBoostParticles(delta, boostAmount) {
    if (!this._boostPoints || !this._boostGeometry || !this._boostLife || !this._boostVel) return;

    const amount = THREE.MathUtils.clamp(boostAmount, 0, 1);
    // Né particelle vive né boost: niente da fare, e nessuna draw call (prima
    // i Points di ogni aereo si disegnavano sempre, con 84 punti scartati).
    if (this._boostAlive === 0 && amount <= 0) {
      if (this._boostPoints.visible) this._boostPoints.visible = false;
      this._hasPrevTail = false;
      return;
    }
    const posAttr = this._boostGeometry.getAttribute('position');
    const lifeAttr = this._boostGeometry.getAttribute('aLife');

    // Aggiorna particelle vive (fade + movimento)
    let alive = 0;
    for (let i = 0; i < BOOST_PARTICLE_COUNT; i++) {
      if (this._boostLife[i] <= 0) continue;
      this._boostLife[i] = Math.max(0, this._boostLife[i] - delta * 2.2);
      const j = i * 3;
      this._boostPositions[j] += this._boostVel[j] * delta;
      this._boostPositions[j + 1] += this._boostVel[j + 1] * delta;
      this._boostPositions[j + 2] += this._boostVel[j + 2] * delta;
      this._boostVel[j] *= 0.94;
      this._boostVel[j + 1] *= 0.94;
      this._boostVel[j + 2] *= 0.94;
      if (this._boostLife[i] > 0) alive++;
    }

    // Emetti nuove particelle solo con boost attivo.
    this._boostSpawnAcc += amount * BOOST_PARTICLE_SPAWN_RATE * delta;
    const toSpawn = Math.floor(this._boostSpawnAcc);
    this._boostSpawnAcc -= toSpawn;

    _tailWorld.copy(_tailLocal).applyMatrix4(this.mesh.matrixWorld);
    // Coda del frame precedente: le particelle di un frame lungo si
    // distribuiscono lungo il tratto percorso invece di nascere tutte nello
    // stesso punto (a 20 fps erano un grumo bianco dietro l'aereo).
    const spread = this._hasPrevTail && this._prevTail.distanceToSquared(_tailWorld) < 100;
    if (toSpawn > 0) {
      _backward.copy(_forward).applyQuaternion(this.mesh.quaternion).multiplyScalar(-1);
      const rightW = _rightW.copy(_right).applyQuaternion(this.mesh.quaternion);
      const upW = _upW.copy(_up).applyQuaternion(this.mesh.quaternion);

      for (let s = 0; s < toSpawn; s++) {
        const i = this._boostHead;
        this._boostHead = (this._boostHead + 1) % BOOST_PARTICLE_COUNT;
        const j = i * 3;
        if (this._boostLife[i] <= 0) alive++;

        // 0 = nata a inizio frame, 1 = adesso.
        const f = spread ? (s + 1) / toSpawn : 1;
        const age = (1 - f) * delta;
        const speed = 9 + amount * 13 + Math.random() * 4;
        const jitterR = (Math.random() - 0.5) * 0.16;
        const jitterU = (Math.random() - 0.5) * 0.16;
        const bx = spread ? this._prevTail.x + (_tailWorld.x - this._prevTail.x) * f : _tailWorld.x;
        const by = spread ? this._prevTail.y + (_tailWorld.y - this._prevTail.y) * f : _tailWorld.y;
        const bz = spread ? this._prevTail.z + (_tailWorld.z - this._prevTail.z) * f : _tailWorld.z;
        this._boostPositions[j] = bx + rightW.x * jitterR + upW.x * jitterU + _backward.x * speed * age;
        this._boostPositions[j + 1] = by + rightW.y * jitterR + upW.y * jitterU + _backward.y * speed * age;
        this._boostPositions[j + 2] = bz + rightW.z * jitterR + upW.z * jitterU + _backward.z * speed * age;

        this._boostVel[j] = _backward.x * speed + (Math.random() - 0.5) * 1.8;
        this._boostVel[j + 1] = _backward.y * speed + (Math.random() - 0.5) * 1.8;
        this._boostVel[j + 2] = _backward.z * speed + (Math.random() - 0.5) * 1.8;
        this._boostLife[i] = Math.max(0.02, 0.45 + amount * 0.55 - age * 2.2);
      }
    }
    this._prevTail.copy(_tailWorld);
    this._hasPrevTail = true;

    this._boostAlive = alive;
    this._boostPoints.visible = this._fxVisible && alive > 0;
    posAttr.needsUpdate = true;
    lifeAttr.needsUpdate = true;
  }

  _updateWingtipTrails(now, boostAmount) {
    if (this._trailL < 0 && this._trailR < 0) return;
    // Le scie si accendono davvero in virata stretta e in boost, come i
    // vortici veri; in volo dritto restano un filo.
    const bank = Math.abs(this._bankRoll) / MAX_BANK_ANGLE;
    const intensity = Math.min(1.2, 0.15 + 0.85 * bank + 0.5 * boostAmount);
    // In boost durano di più, ma mai oltre TRAIL_MAX_LENGTH unità: in extreme
    // boost (~55 unità/s) mezzo secondo di scia sarebbe di nuovo una riga
    // lunga metà schermo.
    const lifeK = Math.min(1 + 0.6 * boostAmount, TRAIL_MAX_LENGTH / Math.max(1, this.velocity.length() * (wingTrails.life ?? 0.5)));
    const l = this.mesh.userData.leftTipLocal ?? _leftTipLocal;
    const r = this.mesh.userData.rightTipLocal ?? _rightTipLocal;
    _tipTemp.copy(l).applyMatrix4(this.mesh.matrixWorld);
    wingTrails.push(this._trailL, _tipTemp.x, _tipTemp.y, _tipTemp.z, now, intensity, lifeK);
    _tipTemp.copy(r).applyMatrix4(this.mesh.matrixWorld);
    wingTrails.push(this._trailR, _tipTemp.x, _tipTemp.y, _tipTemp.z, now, intensity, lifeK);
  }

  dispose(scene) {
    this.mesh.userData.disposed = true;
    if (this.mesh.userData.mixer) this.mesh.userData.mixer.stopAllAction();
    if (this._boostPoints) this._scene.remove(this._boostPoints);
    if (this._boostGeometry) this._boostGeometry.dispose();
    if (this._boostMaterial) this._boostMaterial.dispose();
    this._trailL = wingTrails.release(this._trailL);
    this._trailR = wingTrails.release(this._trailR);
    // Restituisce gli slot luce al pool: le PointLight restano nella scena
    // (spente), quindi il conteggio luci non cambia mai.
    if (this._lightMode !== 'nav') {
      this._navLeftLight?.configure(NAVLIGHT_POINT_DISTANCE, NAVLIGHT_POINT_DECAY);
      this._navRightLight?.configure(NAVLIGHT_POINT_DISTANCE, NAVLIGHT_POINT_DECAY);
    }
    this._navLeftLight = lightPool.release(this._navLeftLight);
    this._navRightLight = lightPool.release(this._navRightLight);
    // Materiali clonati per questo aereo (quelli condivisi restano).
    for (const m of this.mesh.userData.ownMaterials ?? []) m.dispose();
    scene.remove(this.mesh);
  }
}
