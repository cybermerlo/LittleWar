import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { PLANET_RADIUS, FLY_ALTITUDE, BUILDING_CONQUEST_RADIUS } from '../../shared/constants.js';

/** Scala applicata al modello glTF per adattarlo al mondo di gioco. */
const MODEL_SCALE = 0.3;

/**
 * Posizione locale del nodo "Turret_Pivot" nel glTF (unità modello, pre-scale).
 * Deve coincidere con il transform del nodo nel file: ruotare il nodo fa
 * ruotare l'intero blocco mobile (Turret_Pivot + Cannone) attorno a questo punto.
 */
const TURRET_PIVOT_LOCAL = new THREE.Vector3(0.185, 9.326, -0.218);

// ── Pre-caricamento singolo del modello ──
const _loader = new GLTFLoader();
let _turretGltf = null;
const _turretPromise = _loader
  .loadAsync('/models/torretta_cesare.glb')
  .then((gltf) => { _turretGltf = gltf; })
  .catch((err) => { console.warn('[Building] fallito caricamento torretta_cesare.glb', err); });

/**
 * Entità visiva per un edificio conquistabile / torretta difensiva.
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

    /** Posizione world della base (usata per trovare il bersaglio più vicino). */
    this._buildingWorldPos = new THREE.Vector3(pos.x, pos.y, pos.z);

    // ── Modello glTF (torretta_cesare.glb) ──
    /** Root clonato dello scene glTF (contiene Base + Turret_Pivot). */
    this.modelRoot = null;
    /** Nodo rotabile (Turret_Pivot + Cannone come figli). Rotazione YXZ. */
    this.turretPivot = null;

    // Fallback procedurale finché il modello non è pronto
    this._fallback = this._buildFallback();
    this.group.add(this._fallback);

    if (_turretGltf) {
      this._attachModel();
    } else {
      _turretPromise.then(() => this._attachModel());
    }

    // ── Barra di progresso conquista (3D, sopra l'edificio) ──
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

    // Billboard stabile: up radiale come hint per lookAt
    this.progressGroup.up.copy(up);
    this.group.add(this.progressGroup);

    // ── Cerchio zona conquista (indicatore a terra) ──
    const localRadius = BUILDING_CONQUEST_RADIUS * PLANET_RADIUS / FLY_ALTITUDE;
    const ringGeo = new THREE.RingGeometry(localRadius - 0.15, localRadius, 32);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    this.ring = ring;
    this.group.add(ring);

    scene.add(this.group);
  }

  /**
   * Semplice segnaposto mostrato solo finché il GLB non è caricato.
   * La sua presenza evita che l'edificio "appaia" invisibile sulla sfera.
   */
  _buildFallback() {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xc0c0c0, flatShading: true });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.8, 1.5), mat);
    body.position.y = 1.4;
    g.add(body);
    return g;
  }

  /** Sostituisce il fallback col modello glTF una volta disponibile. */
  _attachModel() {
    if (!_turretGltf || !this.group) return;
    if (this._fallback) {
      this.group.remove(this._fallback);
      this._fallback = null;
    }

    // Cloniamo la scene (istanziazione multipla). I materiali PBR ("Gesso",
    // "mat20") restano condivisi: non li ricreiamo/sostituiamo, così l'aspetto
    // originale è preservato.
    this.modelRoot = _turretGltf.scene.clone(true);
    this.modelRoot.scale.setScalar(MODEL_SCALE);

    // La Base resta statica (non la tocchiamo). Il Turret_Pivot ha già nel glTF
    // il suo transform con origine posta sul pivot richiesto [0.185, 9.326, -0.218],
    // quindi ruotando il nodo otteniamo la rotazione attorno al pivot "gratis".
    this.turretPivot = this.modelRoot.getObjectByName('Turret_Pivot') || null;
    if (this.turretPivot) {
      // Yaw (Y) applicato prima della pitch (X): asse X locale ruota col yaw,
      // così l'alzo è coerente con la direzione puntata orizzontalmente.
      this.turretPivot.rotation.order = 'YXZ';
    }

    this.group.add(this.modelRoot);
  }

  /**
   * Aggiorna lo stato visivo dell'edificio dal game-state server.
   */
  update(state, allPlayerStates, camera) {
    this.ownerId = state.ownerId;
    this.ownerColor = state.ownerColor;
    this.conquestProgress = state.conquestProgress;
    this.turretTargetId = state.turretTargetId;

    const isConquered = !!state.ownerId;
    const isBeingConquered = !isConquered && state.conquestProgress > 0;

    // Colore del cerchio zona (mostra il proprietario)
    if (isConquered && state.ownerColor) {
      this.ringMat.color.set(state.ownerColor);
      this.ringMat.opacity = 0.25;
    } else {
      this.ringMat.color.set(0xffffff);
      this.ringMat.opacity = 0.15;
    }

    // Barra di progresso conquista
    this.progressGroup.visible = isBeingConquered;
    if (isBeingConquered) {
      const p = Math.max(0, Math.min(1, state.conquestProgress));
      this.progressFill.scale.x = p;
      this.progressFill.position.x = -(1 - p) * 0.95;

      const r = 1 - p * 0.5;
      const g = 0.5 + p * 0.5;
      this.progressFillMat.color.setRGB(r, g, 0.2);

      if (camera) this.progressGroup.lookAt(camera.position);
    }

    // Puntamento continuo: segue sempre il giocatore vivo più vicino,
    // indipendentemente dallo stato di conquista. Se non ci sono bersagli
    // validi, il Turret_Pivot resta all'ultima angolazione.
    if (this.turretPivot && allPlayerStates && allPlayerStates.length > 0) {
      const target = this._findNearestAlive(allPlayerStates);
      if (target) this._aimTurretAt(target.theta, target.phi);
    }
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

  /**
   * Ruota il blocco mobile (Turret_Pivot + Cannone) per puntare il bersaglio.
   * Il Turret_Pivot ruota attorno al proprio pivot locale grazie al transform
   * già presente nel glTF; Cannone è un figlio e segue rigidamente.
   */
  _aimTurretAt(targetTheta, targetPhi) {
    if (!this.turretPivot || !this.modelRoot) return;

    const tp = sphericalToCartesian(targetTheta, targetPhi, FLY_ALTITUDE);
    const targetWorld = new THREE.Vector3(tp.x, tp.y, tp.z);

    // Coord del bersaglio nel frame locale del modelRoot (pre-scale, così
    // coincide col frame in cui sono espresse le posizioni dei figli nel glTF).
    const targetLocal = this.modelRoot.worldToLocal(targetWorld.clone());

    // Vettore dal pivot al bersaglio nel frame del pivot (identità rispetto
    // al modelRoot a pivot "a riposo", quindi bastano sottrazioni).
    const dx = targetLocal.x - TURRET_PIVOT_LOCAL.x;
    const dy = targetLocal.y - TURRET_PIVOT_LOCAL.y;
    const dz = targetLocal.z - TURRET_PIVOT_LOCAL.z;

    // Forward "a riposo" del cannone = +Z locale del Turret_Pivot
    // (verificato dalla bbox del modello: Cannone estende in +Z).
    const yaw = Math.atan2(dx, dz);
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    // rotation.x positiva inclina +Z verso -Y; per alzare il tiro serve
    // una pitch negativa quando il bersaglio è sopra l'orizzontale.
    const pitch = -Math.atan2(dy, horizDist);

    this.turretPivot.rotation.y = yaw;
    this.turretPivot.rotation.x = pitch;
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}

/**
 * Effetto particellare di distruzione torre.
 */
export function spawnTurretDestruction(scene, theta, phi) {
  const pos = sphericalToCartesian(theta, phi, PLANET_RADIUS + 1.5);
  const group = new THREE.Group();
  group.position.set(pos.x, pos.y, pos.z);

  const up = new THREE.Vector3(pos.x, pos.y, pos.z).normalize();

  const shardCount = 14;
  const shards = [];

  for (let i = 0; i < shardCount; i++) {
    const size = 0.1 + Math.random() * 0.25;
    const geo = Math.random() > 0.5
      ? new THREE.BoxGeometry(size, size, size)
      : new THREE.TetrahedronGeometry(size);
    const color = Math.random() > 0.5 ? 0xaaaaaa : 0x886644;
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial({ color, flatShading: true }),
    );

    const angle = (i / shardCount) * Math.PI * 2 + Math.random() * 0.3;
    const speed = 1.5 + Math.random() * 2;
    const vx = Math.cos(angle) * speed;
    const vz = Math.sin(angle) * speed;
    const vy = 2 + Math.random() * 3;

    shards.push({ mesh, vx, vy, vz });
    group.add(mesh);
  }

  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.9 }),
  );
  group.add(flash);

  scene.add(group);

  let elapsed = 0;
  const duration = 1200;
  const gravity = -8;

  const animate = () => {
    const dt = 16 / 1000;
    elapsed += 16;
    const t = elapsed / duration;

    for (const s of shards) {
      s.vy += gravity * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += dt * 5;
      s.mesh.rotation.z += dt * 3;
      s.mesh.material.opacity = Math.max(0, 1 - t);
      s.mesh.material.transparent = true;
    }

    flash.scale.setScalar(1 + t * 3);
    flash.material.opacity = Math.max(0, 0.9 - t * 1.5);

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(group);
    }
  };
  requestAnimationFrame(animate);
}
