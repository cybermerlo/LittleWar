import * as THREE from 'three';
import { createGLTFLoader } from '../utils/createGLTFLoader.js';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { mergeMeshesByMaterial } from '../utils/mergeByMaterial.js';
import { surfaceRadiusSpherical } from '../scene/planetSurface.js';
import { glows, segments, SEG_BEAM, spawnObjectiveBurst } from './ObjectiveFx.js';
import { FLY_ALTITUDE, POWERUP_LIFETIME } from '../../shared/constants.js';

// Module-level reusables — no per-frame allocation
const _up       = new THREE.Vector3(0, 1, 0);
const _pNormal  = new THREE.Vector3();
const _spinAxis = new THREE.Vector3(0, 1, 0);
const _spinQuat = new THREE.Quaternion();
const _fxColor  = new THREE.Color();
const _beamTop  = new THREE.Vector3();

/**
 * Leggibilità da lontano. Il modello era grande un quarto di aereo e a 35
 * unità spariva; ora è mezzo aereo, fluttua e ha una colonna di luce del suo
 * colore che parte dal terreno e sale oltre la quota di volo: la si vede
 * spuntare dall'orizzonte del pianetino e si capisce di che powerup si tratta.
 */
const MODEL_SCALE = 0.9;
const BOB_AMPLITUDE = 0.25;
const BEAM_TOP = FLY_ALTITUDE + 9;
const BEAM_WIDTH = 0.9;
const BEAM_GROW_S = 0.45;
const HALO_SIZE = 2.6;
const HALO_MIN_PX = 12;
/** Negli ultimi secondi di vita lampeggia: sta per sparire. */
const EXPIRY_WARN_MS = 5000;

/** Colore per tipo: oro = arma, azzurro = scudo, rosso-arancio = boost estremo. */
const TYPE_COLORS = {
  weapon: new THREE.Color(1.0, 0.78, 0.18),
  shield: new THREE.Color(0.32, 0.72, 1.0),
  extreme_boost: new THREE.Color(1.0, 0.36, 0.1),
};
function typeColor(type) { return TYPE_COLORS[type] ?? TYPE_COLORS.weapon; }

const loader = createGLTFLoader();

/**
 * Modelli pronti da clonare: le primitive fuse per materiale (il multishot
 * passava da 7 draw call a 2 per ogni powerup in scena).
 */
const templates = { weapon: null, shield: null, extreme_boost: null };

function buildTemplate(gltf) {
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(src.matrixWorld).invert();
  const meshes = [];
  src.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const root = new THREE.Group();
  for (const m of mergeMeshesByMaterial(meshes, inv)) {
    // I materiali trasparenti (bolla dello scudo, scia del boost) vanno
    // disegnati dopo quelli opachi dello stesso modello.
    if (m.material.transparent) m.renderOrder = 2;
    root.add(m);
  }
  return root;
}

function loadPowerupTemplate(url, type) {
  return loader.loadAsync(url)
    .then((gltf) => { templates[type] = buildTemplate(gltf); return templates[type]; })
    .catch(() => null);
}

const multishotPromise = loadPowerupTemplate('/models/Powerup_Multishot.glb', 'weapon');
const shieldPromise = loadPowerupTemplate('/models/Powerup_Shield.glb', 'shield');
const speedPromise = loadPowerupTemplate('/models/Powerup_Speed.glb', 'extreme_boost');

/** Risolve quando i tre modelli sono pronti (o falliti: resta il fallback). */
export function preloadPowerupModels() {
  return Promise.all([multishotPromise, shieldPromise, speedPromise]);
}

function powerupModelPromise(type) {
  if (type === 'extreme_boost') return speedPromise;
  if (type === 'shield') return shieldPromise;
  return multishotPromise;
}

function templateForType(type) {
  return templates[type] ?? (type === 'extreme_boost' || type === 'shield' ? null : templates.weapon);
}

// Fallback geometrico (stessi colori di prima)
const FALLBACK_GEO = new THREE.BoxGeometry(0.7, 0.7, 0.7);
const FALLBACK_MATS = {
  weapon: new THREE.MeshLambertMaterial({ color: 0xffd700, flatShading: true }),
  shield: new THREE.MeshLambertMaterial({ color: 0x44aaff, flatShading: true }),
  extreme_boost: new THREE.MeshLambertMaterial({ color: 0xff3300, flatShading: true }),
};

export class PowerUpEntity {
  constructor(scene, id, type, theta, phi) {
    this.id    = id;
    this.type  = type;
    this.theta = theta;
    this.phi   = phi;
    this._scene = scene;
    /** Rotazione intorno all'asse radiale (spin del collectible). */
    this._spinAngle = Math.random() * Math.PI * 2;
    /** Fase propria: prima tutti i powerup pulsavano all'unisono. */
    this._phase = Math.random() * Math.PI * 2;
    this._age = 0;
    /** Istante di nascita sul server, se noto (evento powerup-spawned). */
    this._spawnedAt = 0;
    this._color = typeColor(type);

    this.root = new THREE.Object3D();
    scene.add(this.root);

    /** Orientamento base (Y locale = normale al pianeta) — calcolato una volta sola in _updatePosition(). */
    this._baseQuat = new THREE.Quaternion();
    this._basePos = new THREE.Vector3();
    this._radial = new THREE.Vector3();
    this._beamBase = new THREE.Vector3();
    this._updatePosition();

    if (templateForType(type)) {
      this._attachModel();
    } else {
      this._addFallback();
      powerupModelPromise(type).then(() => {
        if (!this.root.parent) return;
        this._removeFallback();
        this._attachModel();
      });
    }
  }

  _addFallback() {
    this._fallback = new THREE.Mesh(FALLBACK_GEO, FALLBACK_MATS[this.type] ?? FALLBACK_MATS.weapon);
    this.root.add(this._fallback);
  }

  _removeFallback() {
    if (this._fallback) {
      this.root.remove(this._fallback);
      this._fallback = null;
    }
  }

  _attachModel() {
    const template = templateForType(this.type);
    if (!template || this._model) return;
    this._model = template.clone(true);
    this._model.scale.setScalar(this.type === 'extreme_boost' ? MODEL_SCALE * 0.92 : MODEL_SCALE);
    this.root.add(this._model);
  }

  /**
   * Il powerup è appena nato sul server (evento `powerup-spawned`): da qui si
   * conosce la scadenza e si può avvisare negli ultimi secondi. Per quelli già
   * presenti all'ingresso in partita l'età non si conosce e non lampeggiano.
   */
  markSpawned(now = performance.now()) {
    this._spawnedAt = now;
  }

  _updatePosition() {
    const pos = sphericalToCartesian(this.theta, this.phi, FLY_ALTITUDE);
    this._basePos.set(pos.x, pos.y, pos.z);
    this.root.position.copy(this._basePos);
    // Base orientation: Y locale allineato alla normale sferica.
    // Calcolato qui (raro) e riusato ogni frame in tick().
    _pNormal.set(pos.x, pos.y, pos.z).normalize();
    this._radial.copy(_pNormal);
    this._baseQuat.setFromUnitVectors(_up, _pNormal);
    // La colonna parte dalla superficie visibile: terra emersa o pelo dell'acqua.
    this._beamBase.copy(_pNormal).multiplyScalar(surfaceRadiusSpherical(this.theta, this.phi) - 0.1);
    this._applySpin();
  }

  _applySpin() {
    _spinQuat.setFromAxisAngle(_spinAxis, this._spinAngle);
    this.root.quaternion.copy(this._baseQuat).multiply(_spinQuat);
  }

  update(theta, phi) {
    if (theta === this.theta && phi === this.phi) return;
    this.theta = theta;
    this.phi = phi;
    this._updatePosition();
  }

  tick(delta) {
    const dt = Math.min(Math.max(delta || 0, 0), 0.1);
    this._age += dt;
    this._spinAngle += dt * 1.8;
    this._applySpin(); // no setFromUnitVectors — base già calcolata in _updatePosition
    const bob = Math.sin(this._age * 2.1 + this._phase) * BOB_AMPLITUDE;
    this.root.position.copy(this._basePos).addScaledVector(this._radial, bob);

    // Scadenza vicina: onda quadra a 6 Hz su modello, alone e colonna.
    let blink = 1;
    if (this._spawnedAt > 0) {
      const left = POWERUP_LIFETIME - (performance.now() - this._spawnedAt);
      if (left < EXPIRY_WARN_MS) blink = Math.floor(this._age * 6) % 2 === 0 ? 1 : 0.25;
    }
    if (this._model) this._model.visible = blink > 0.5;

    const pulse = 0.85 + 0.15 * Math.sin(this._age * 3.1 + this._phase);
    if (glows) {
      _fxColor.copy(this._color).multiplyScalar(0.95 * pulse * blink);
      glows.add(this.root.position, HALO_SIZE, _fxColor, 0, HALO_MIN_PX, 0.3);
    }
    if (segments) {
      // La colonna cresce dal terreno quando il powerup compare.
      const grow = Math.min(1, this._age / BEAM_GROW_S);
      const e = 1 - (1 - grow) * (1 - grow);
      _beamTop.copy(this._radial).multiplyScalar(BEAM_TOP);
      _beamTop.lerp(this._beamBase, 1 - e);
      _fxColor.copy(this._color).multiplyScalar(1.15 * blink);
      segments.add(this._beamBase, _beamTop, BEAM_WIDTH, _fxColor, SEG_BEAM, 0, 0.6);
    }
  }

  /** Scoppio di raccolta: anello di luce e stelline del suo colore, visibile a tutti. */
  burst() {
    spawnObjectiveBurst(this.root.position, [this._color, '#ffffff', this._color], {
      count: 16, speed: 5.5, ringSize: 5, ringColor: this._color,
    });
  }

  dispose(scene) {
    scene.remove(this.root);
  }
}

/** Copie nascoste dei tre modelli, per la pre-compilazione degli shader. */
export function createPowerupPrototypes() {
  const g = new THREE.Group();
  g.name = 'powerup-prototypes';
  for (const t of Object.values(templates)) if (t) g.add(t.clone(true));
  return g;
}
