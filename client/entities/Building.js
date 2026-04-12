import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { PLANET_RADIUS, FLY_ALTITUDE, BUILDING_CONQUEST_RADIUS } from '../../shared/constants.js';

const NEUTRAL_COLOR = 0xc0c0c0;
const TURRET_COLOR = 0x555555;

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

    // ── Gruppo principale orientato sulla sfera ──
    this.group = new THREE.Group();

    // Posizione sulla superficie del pianeta
    const pos = sphericalToCartesian(theta, phi, PLANET_RADIUS);
    this.group.position.set(pos.x, pos.y, pos.z);

    // Orientamento: "su" = radiale verso l'esterno
    const up = new THREE.Vector3(pos.x, pos.y, pos.z).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    this.group.quaternion.copy(q);

    // ── Edificio base ──
    this.bodyMat = new THREE.MeshLambertMaterial({ color: NEUTRAL_COLOR, flatShading: true });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.8, 1.2), this.bodyMat);
    body.position.y = 0.9;
    this.group.add(body);

    // Tetto
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x886644, flatShading: true });
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.0, 0.6, 4), roofMat);
    roof.position.y = 2.1;
    this.roofMesh = roof;
    this.group.add(roof);

    // ── Torretta (visibile solo quando conquistato) ──
    this.turretGroup = new THREE.Group();
    this.turretGroup.position.y = 2.5;
    this.turretGroup.visible = false;

    // Base torretta
    const turretBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, 0.4, 6),
      new THREE.MeshLambertMaterial({ color: TURRET_COLOR, flatShading: true }),
    );
    this.turretGroup.add(turretBase);

    // Canna
    this.turretBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 1.0, 5),
      new THREE.MeshLambertMaterial({ color: 0x333333, flatShading: true }),
    );
    this.turretBarrel.position.set(0.5, 0.15, 0);
    this.turretBarrel.rotation.z = -Math.PI / 2;
    this.turretGroup.add(this.turretBarrel);

    this.group.add(this.turretGroup);

    // ── Barra di progresso conquista (3D, sopra l'edificio) ──
    this.progressGroup = new THREE.Group();
    this.progressGroup.position.y = 3.5;
    this.progressGroup.visible = false;

    // Sfondo barra
    const barBg = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 0.3),
      new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }),
    );
    this.progressGroup.add(barBg);

    // Riempimento barra
    this.progressFillMat = new THREE.MeshBasicMaterial({ color: 0x44ff44, side: THREE.DoubleSide });
    this.progressFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 0.22),
      this.progressFillMat,
    );
    this.progressFill.position.z = 0.01;
    this.progressGroup.add(this.progressFill);

    this.group.add(this.progressGroup);

    // ── Cerchio zona conquista (indicatore a terra) ──
    // Raggio locale ≈ raggio conquista proiettato sulla superficie
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

    // Cache per la posizione world della torretta (per rotazione verso target)
    this._worldUp = up.clone();
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

    // Colore edificio
    if (isConquered && state.ownerColor) {
      this.bodyMat.color.set(state.ownerColor);
      this.ringMat.color.set(state.ownerColor);
      this.ringMat.opacity = 0.25;
    } else {
      this.bodyMat.color.set(NEUTRAL_COLOR);
      this.ringMat.color.set(0xffffff);
      this.ringMat.opacity = 0.15;
    }

    // Tetto nascosto quando c'è la torretta
    this.roofMesh.visible = !isConquered;
    this.turretGroup.visible = isConquered;

    // Barra di progresso
    this.progressGroup.visible = isBeingConquered;
    if (isBeingConquered) {
      const p = Math.max(0, Math.min(1, state.conquestProgress));
      this.progressFill.scale.x = p;
      this.progressFill.position.x = -(1 - p) * 0.95;

      // Colore barra: dal giallo al verde
      const r = 1 - p * 0.5;
      const g = 0.5 + p * 0.5;
      this.progressFillMat.color.setRGB(r, g, 0.2);

      // Barra guarda sempre la camera
      if (camera) {
        this.progressGroup.lookAt(camera.position);
      }
    }

    // Rotazione torretta verso il bersaglio
    if (isConquered && this.turretTargetId && allPlayerStates) {
      const target = allPlayerStates.find(p => p.id === this.turretTargetId);
      if (target) {
        this._aimTurretAt(target.theta, target.phi);
      }
    }
  }

  /**
   * Ruota la torretta verso un punto sferico (nel frame locale del building).
   */
  _aimTurretAt(targetTheta, targetPhi) {
    const tPos = sphericalToCartesian(targetTheta, targetPhi, FLY_ALTITUDE);
    const targetWorld = new THREE.Vector3(tPos.x, tPos.y, tPos.z);

    // Converti in coordinate locali del gruppo
    const localTarget = this.group.worldToLocal(targetWorld.clone());

    // Angolo nel piano XZ locale (orizzontale sulla superficie)
    const angle = Math.atan2(localTarget.x, localTarget.z);
    this.turretGroup.rotation.y = angle;
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

    // Velocità radiale verso fuori + casuale
    const angle = (i / shardCount) * Math.PI * 2 + Math.random() * 0.3;
    const speed = 1.5 + Math.random() * 2;
    const vx = Math.cos(angle) * speed;
    const vz = Math.sin(angle) * speed;
    const vy = 2 + Math.random() * 3;

    shards.push({ mesh, vx, vy, vz });
    group.add(mesh);
  }

  // Flash arancione
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

    // Particelle
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

    // Flash
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
