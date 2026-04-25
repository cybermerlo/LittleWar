import * as THREE from 'three';
import { createGLTFLoader } from '../utils/createGLTFLoader.js';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { PLANET_RADIUS, FLY_ALTITUDE, BUILDING_CONQUEST_RADIUS } from '../../shared/constants.js';

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
 * fornito dal designer.
 */
const BEACON_MODEL_POINT_SCENE = new THREE.Vector3(-0.3617, 20.0666, -0.8266);

/**
 * Stesso punto nel frame locale di `Turret_Pivot` (così il beacon segue
 * yaw/pitch del blocco cannone). scene − posizione pivot del nodo.
 */
const BEACON_TURRET_PIVOT_LOCAL = new THREE.Vector3(
  BEACON_MODEL_POINT_SCENE.x - TURRET_PIVOT_LOCAL.x,
  BEACON_MODEL_POINT_SCENE.y - TURRET_PIVOT_LOCAL.y,
  BEACON_MODEL_POINT_SCENE.z - TURRET_PIVOT_LOCAL.z,
);

// ── Parametri beacon ──────────────────────────────────────────────────────────

// Stesse dimensioni / caduta della luce delle luci alari (Airplane.js: NAVLIGHT_*).
const BEACON_BLINK_HZ = 0.55;
const BEACON_SPHERE_R = 0.045;
const BEACON_LIGHT_DISTANCE = 0.55;
const BEACON_LIGHT_DECAY = 2.0;
const BEACON_LIGHT_INTENSITY = 2.4;

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

// ── Pre-caricamento singolo di entrambi i modelli ─────────────────────────────

const _loader = createGLTFLoader();
let _cesareGltf = null;
let _preGltf = null;
const _cesarePromise = _loader
  .loadAsync('/models/torretta_cesare.glb')
  .then((gltf) => { _cesareGltf = gltf; })
  .catch((err) => { console.warn('[Building] fallito caricamento torretta_cesare.glb', err); });
const _prePromise = _loader
  .loadAsync('/models/pre_torretta.glb')
  .then((gltf) => { _preGltf = gltf; })
  .catch((err) => { console.warn('[Building] fallito caricamento pre_torretta.glb', err); });

/**
 * Risolve quando i glTF delle torrette (neutra + conquistata) sono in memoria.
 * Da includere nel preload iniziale insieme ad alberi/edifici così il parsing
 * di rete/decodifica non avviene allo spawn in partita.
 */
export function preloadTurretBuildingModels() {
  return Promise.all([_cesarePromise, _prePromise]);
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Centra in XZ e solleva il modello perché il punto più basso della bbox
 * poggi su Y = 0. Usata per pre_torretta (che ha origine decentrata).
 */
function centerModelOnGround(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  // Trasliamo il root: XZ al centro, Y tale che min.y = 0
  root.position.x -= center.x;
  root.position.y -= box.min.y;
  root.position.z -= center.z;
}

/** Clona ricorsivamente tutte le istanze di material incontrate (senza deepClone di texture). */
function deepCloneMaterials(root, out = []) {
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map((m) => {
        const c = m.clone();
        out.push({ original: m, clone: c });
        return c;
      });
    } else {
      const c = obj.material.clone();
      out.push({ original: obj.material, clone: c });
      obj.material = c;
    }
  });
  return out;
}

// ── BuildingEntity ────────────────────────────────────────────────────────────

/**
 * Entità visiva per un edificio conquistabile / torretta difensiva.
 *
 * - Neutrale / post-distruzione → modello `pre_torretta`
 * - Conquistato → modello `torretta_cesare` con cannone puntabile,
 *   materiali tintati col colore del proprietario, beacon notturno.
 */
export class BuildingEntity {
  constructor(scene, id, theta, phi) {
    this.id = id;
    this.theta = theta;
    this.phi = phi;
    this.ownerId = null;
    this.ownerColor = null;
    this.conquestProgress = 0;
    this.turretTargetId = null;

    // ── Gruppo orientato sulla sfera ──
    this.group = new THREE.Group();
    const pos = sphericalToCartesian(theta, phi, PLANET_RADIUS);
    this.group.position.set(pos.x, pos.y, pos.z);

    const up = new THREE.Vector3(pos.x, pos.y, pos.z).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    this.group.quaternion.copy(q);

    /** Posizione world della base (per trovare il bersaglio più vicino). */
    this._buildingWorldPos = new THREE.Vector3(pos.x, pos.y, pos.z);

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
    /** Materiali clonati per-istanza del modello cesare (da tintare). */
    this._cesareMats = [];

    /** Riferimento al root scalato della pre-torretta. */
    this.preRoot = null;

    // Fallback procedurale, sostituito quando il glTF neutro è pronto
    this._fallback = this._buildFallback();
    this.neutralWrapper.add(this._fallback);

    // ── Beacon notturno (PRIMA di _attachCesareModel: se il GLTF è già in cache
    // _attachCesareModel gira subito e deve trovare _beaconGroup già creato,
    // altrimenti il riparenting salta e la luce resta a (0,0,0) sul wrapper.)
    // Il beacon viene agganciato a `Turret_Pivot` così segue la rotazione del modello.
    this._nightFactor = 0;
    this._beaconTime = Math.random() * 10; // desync tra torrette
    this._beaconColor = new THREE.Color(0xffffff);

    this._beaconGroup = new THREE.Group();
    // Compensa lo scale di cesareRoot: raggio sfera / distanza luce in unità world.
    this._beaconGroup.scale.setScalar(1 / CESARE_SCALE);
    this._beaconGroup.visible = false;

    // Un solo puntino additivo + PointLight (niente alone a disco grande).
    this._beaconCoreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._beaconSphere = new THREE.Mesh(
      new THREE.SphereGeometry(BEACON_SPHERE_R, 10, 10), // come _navGeo sugli aerei
      this._beaconCoreMat,
    );
    this._beaconSphere.renderOrder = 5;
    this._beaconSphere.frustumCulled = false;

    this._beaconLight = new THREE.PointLight(
      0xffffff,
      0,
      BEACON_LIGHT_DISTANCE,
      BEACON_LIGHT_DECAY,
    );
    this._beaconGroup.add(this._beaconSphere, this._beaconLight);
    this.conqueredWrapper.add(this._beaconGroup);

    // Attach async (dopo beacon: così _attachCesareModel può riparentare subito)
    if (_preGltf) this._attachPreModel();
    else _prePromise.then(() => this._attachPreModel());

    if (_cesareGltf) this._attachCesareModel();
    else _cesarePromise.then(() => this._attachCesareModel());

    // ── Barra di progresso conquista ──
    this.progressGroup = new THREE.Group();
    this.progressGroup.position.y = 4.2;
    this.progressGroup.visible = false;

    const barBg = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 0.3),
      new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }),
    );
    this.progressGroup.add(barBg);

    this.progressFillMat = new THREE.MeshBasicMaterial({ color: 0x44ff44, side: THREE.DoubleSide });
    this.progressFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 0.22),
      this.progressFillMat,
    );
    this.progressFill.position.z = 0.01;
    this.progressGroup.add(this.progressFill);

    this.progressGroup.up.copy(up);
    this.group.add(this.progressGroup);

    // ── Cerchio zona conquista ──
    const localRadius = BUILDING_CONQUEST_RADIUS * PLANET_RADIUS / FLY_ALTITUDE;
    const ringGeo = new THREE.RingGeometry(localRadius - 0.15, localRadius, 32);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.30,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    this.ring = ring;
    this.group.add(ring);

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
    if (!_preGltf || !this.group) return;
    if (this._fallback) {
      this.neutralWrapper.remove(this._fallback);
      this._fallback = null;
    }
    this.preRoot = _preGltf.scene.clone(true);
    this.preRoot.scale.setScalar(PRE_SCALE);
    // Il modello ha origine decentrata: centriamo XZ e poggiamo la base su Y=0
    centerModelOnGround(this.preRoot);
    this.neutralWrapper.add(this.preRoot);
  }

  _attachCesareModel() {
    if (!_cesareGltf || !this.group) return;
    this.cesareRoot = _cesareGltf.scene.clone(true);
    this.cesareRoot.scale.setScalar(CESARE_SCALE);

    // Turret_Pivot + Cannone sono già pronti nel glTF: ruotando il nodo
    // ruotiamo attorno al pivot (il transform locale del nodo incarna il pivot).
    this.turretPivot = this.cesareRoot.getObjectByName('Turret_Pivot') || null;
    if (this.turretPivot) {
      // yaw (Y) applicato prima della pitch (X): così l'alzo è coerente
      // con la direzione puntata orizzontalmente.
      this.turretPivot.rotation.order = 'YXZ';
    }

    // Cloniamo i materiali per questa istanza (così la tintatura con il
    // colore del proprietario non si propaga alle altre torrette). Le
    // proprietà PBR (roughness, metalness, mappe…) vengono preservate
    // dal clone — modifichiamo solo .color (≡ baseColorFactor glTF).
    this._cesareMats = deepCloneMaterials(this.cesareRoot);

    this.conqueredWrapper.add(this.cesareRoot);

    // Riparenta il beacon a Turret_Pivot nel punto scene richiesto (convertito
    // in locale pivot), così segue il puntamento del cannone.
    if (this.turretPivot && this._beaconGroup) {
      this._beaconGroup.position.copy(BEACON_TURRET_PIVOT_LOCAL);
      this.turretPivot.add(this._beaconGroup);
    } else if (this.cesareRoot && this._beaconGroup) {
      this._beaconGroup.position.copy(BEACON_MODEL_POINT_SCENE);
      this.cesareRoot.add(this._beaconGroup);
    }
  }

  /**
   * Tinta solo i materiali `Gesso (5)` e `Gesso (7)` col colore del
   * proprietario. Gli altri materiali (Gesso, Gesso (1), mat20, …) rimangono
   * con il baseColorFactor originale del glTF.
   */
  _applyOwnerTint(colorInput) {
    if (!colorInput || this._cesareMats.length === 0) return;
    const color = new THREE.Color(colorInput);
    for (const entry of this._cesareMats) {
      const name = entry.original && entry.original.name;
      if (name !== 'Gesso (5)' && name !== 'Gesso (7)') continue;
      if (entry.clone.color) entry.clone.color.copy(color);
    }
  }

  /**
   * Aggiorna lo stato visivo dell'edificio dal game-state server.
   * `nightFactor` è opzionale per retro-compatibilità.
   * L'orientamento della barra di progresso verso la camera è gestito
   * dal loop animate() in main.js (per-frame, con threshold su movimento).
   */
  update(state, allPlayerStates, _camera, nightFactor = 0) {
    this.ownerId = state.ownerId;
    this.ownerColor = state.ownerColor;
    this.conquestProgress = state.conquestProgress;
    this.turretTargetId = state.turretTargetId;
    this._nightFactor = nightFactor;

    const isConquered = !!state.ownerId;
    const isBeingConquered = !isConquered && state.conquestProgress > 0;

    // Switch modello: neutrale = pre_torretta; conquistato = torretta_cesare
    this.neutralWrapper.visible = !isConquered;
    this.conqueredWrapper.visible = isConquered;

    // Colore cerchio (mostra il proprietario)
    if (isConquered && state.ownerColor) {
      this.ringMat.color.set(state.ownerColor);
      this.ringMat.opacity = 0.50;
    } else {
      this.ringMat.color.set(0xffffff);
      this.ringMat.opacity = 0.30;
    }

    // Tint del modello conquistato + colore beacon
    if (isConquered && state.ownerColor) {
      this._applyOwnerTint(state.ownerColor);
      this._beaconColor.set(state.ownerColor);
    }

    // Barra di progresso conquista
    const justBecameVisible = isBeingConquered && !this.progressGroup.visible;
    this.progressGroup.visible = isBeingConquered;
    if (isBeingConquered) {
      const p = Math.max(0, Math.min(1, state.conquestProgress));
      this.progressFill.scale.x = p;
      this.progressFill.position.x = -(1 - p) * 0.95;
      const r = 1 - p * 0.5;
      const g = 0.5 + p * 0.5;
      this.progressFillMat.color.setRGB(r, g, 0.2);
      // Segnala al loop animate() che serve un lookAt immediato al prossimo frame
      if (justBecameVisible) this._progressOriented = false;
    } else {
      this._progressOriented = false;
    }

    // Puntamento continuo (solo quando la torretta conquistata è visibile)
    if (isConquered && this.turretPivot && allPlayerStates && allPlayerStates.length > 0) {
      const target = this._findNearestAlive(allPlayerStates);
      if (target) this._aimTurretAt(target.theta, target.phi);
    }
  }

  /** Chiamato ogni frame dall'animate loop per animare il beacon. */
  tick(delta, nightFactor) {
    if (typeof nightFactor === 'number') this._nightFactor = nightFactor;
    this._updateBeacon(delta || 0);
  }

  _updateBeacon(delta) {
    this._beaconTime += Math.max(0, delta);
    const isConquered = !!this.ownerId;
    const nightVis = smooth01((this._nightFactor - 0.55) / 0.25);
    if (!isConquered || nightVis <= 0.001) {
      this._beaconGroup.visible = false;
      this._beaconCoreMat.opacity = 0;
      this._beaconLight.intensity = 0;
      return;
    }
    this._beaconGroup.visible = true;
    const intensity = nightVis * blinkGate(this._beaconTime);
    this._beaconCoreMat.color.copy(this._beaconColor);
    this._beaconCoreMat.opacity = intensity; // come opacity luci alari
    this._beaconLight.color.copy(this._beaconColor);
    this._beaconLight.intensity = intensity * BEACON_LIGHT_INTENSITY;
  }

  /** Giocatore vivo più vicino (distanza cartesiana a FLY_ALTITUDE). */
  _findNearestAlive(allPlayerStates) {
    let best = null;
    let bestD = Infinity;
    for (const p of allPlayerStates) {
      if (!p || !p.alive) continue;
      if (typeof p.theta !== 'number' || typeof p.phi !== 'number') continue;
      const tp = sphericalToCartesian(p.theta, p.phi, FLY_ALTITUDE);
      const dx = tp.x - this._buildingWorldPos.x;
      const dy = tp.y - this._buildingWorldPos.y;
      const dz = tp.z - this._buildingWorldPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) { bestD = d2; best = p; }
    }
    return best;
  }

  _aimTurretAt(targetTheta, targetPhi) {
    if (!this.turretPivot || !this.cesareRoot) return;

    const tp = sphericalToCartesian(targetTheta, targetPhi, FLY_ALTITUDE);
    const targetWorld = new THREE.Vector3(tp.x, tp.y, tp.z);

    // Coord del bersaglio nel frame locale del cesareRoot (pre-scale).
    const targetLocal = this.cesareRoot.worldToLocal(targetWorld.clone());

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
    if (!this.conqueredWrapper.visible) return;
    const tip = this.getCannonTipWorld();
    if (!tip) return;

    const color = new THREE.Color(this.ownerColor || '#ffdd88');
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8), mat);
    mesh.position.copy(tip);
    mesh.renderOrder = 4;
    this._scene.add(mesh);

    const light = new THREE.PointLight(color, 2.6, 6, 2);
    light.position.copy(tip);
    this._scene.add(light);

    const start = performance.now();
    const duration = 140;
    const tick = () => {
      const t = (performance.now() - start) / duration;
      if (t >= 1) {
        this._scene.remove(mesh);
        this._scene.remove(light);
        mat.dispose();
        mesh.geometry.dispose();
        return;
      }
      const s = 1 + t * 2.2;
      mesh.scale.setScalar(s);
      mat.opacity = 0.95 * (1 - t);
      light.intensity = 2.6 * (1 - t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  dispose(scene) {
    scene.remove(this.group);
    if (this._beaconCoreMat) this._beaconCoreMat.dispose();
    if (this._beaconSphere && this._beaconSphere.geometry) this._beaconSphere.geometry.dispose();
    for (const entry of this._cesareMats) {
      if (entry.clone && entry.clone.dispose) entry.clone.dispose();
    }
    this._cesareMats = [];
  }
}

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

/**
 * Effetto particellare di distruzione torre.
 */
export function spawnTurretDestruction(scene, theta, phi) {
  const pos = sphericalToCartesian(theta, phi, PLANET_RADIUS + 1.5);

  const group = _destrPool[_destrPoolIdx % DESTR_POOL_SIZE];
  _destrPoolIdx++;
  group._cancelled = true; // ferma eventuale animazione precedente su questo slot

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

  let elapsed = 0;
  const duration = 1200;
  const gravity = -8;
  group._cancelled = false;

  const animate = () => {
    if (group._cancelled) return;
    const dt = 16 / 1000;
    elapsed += 16;
    const t = elapsed / duration;
    const op = Math.max(0, 1 - t);

    for (const s of shards) {
      s.vy += gravity * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += dt * 5;
      s.mesh.rotation.z += dt * 3;
      s.mesh.material.opacity = op;
    }

    flash.scale.setScalar(1 + t * 3);
    flash.material.opacity = Math.max(0, 0.9 - t * 1.5);

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      group.visible = false;
    }
  };
  requestAnimationFrame(animate);
}
