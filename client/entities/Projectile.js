import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { FLY_ALTITUDE } from '../../shared/constants.js';

// ── Geometria e materiale (condivisi) ─────────────────────────────────────────

const bulletGeo = new THREE.CapsuleGeometry(0.07, 0.28, 4, 8);
const bulletMat = new THREE.MeshStandardMaterial({
  color: 0xffef9a,
  emissive: 0xffb53f,
  emissiveIntensity: 0.9,
  roughness: 0.45,
  metalness: 0.05,
});
const trailMat = new THREE.LineBasicMaterial({
  color: 0xffd36b,
  transparent: true,
  opacity: 0.42,
  depthWrite: false,
});

// ── Pool instanced ─────────────────────────────────────────────────────────────
// Tutti i proiettili attivi sono renderizzati con un singolo InstancedMesh (1 draw call)
// e tutti i trail con un singolo LineSegments (1 draw call), indipendentemente da quanti
// proiettili ci sono in scena.

const MAX_INSTANCES = 200;

const _iMesh = new THREE.InstancedMesh(bulletGeo, bulletMat, MAX_INSTANCES);
_iMesh.frustumCulled = false;
_iMesh.renderOrder = 3;
_iMesh.count = 0;

// Inizializza tutte le istanze invisibili (scale 0)
const _dummy = new THREE.Object3D();
_dummy.scale.setScalar(0);
_dummy.updateMatrix();
for (let i = 0; i < MAX_INSTANCES; i++) _iMesh.setMatrixAt(i, _dummy.matrix);
_iMesh.instanceMatrix.needsUpdate = true;

// Trail condiviso: slot i → vertici [i*2, i*2+1] → bytes [i*6 .. i*6+5]
const _trailBuf = new Float32Array(MAX_INSTANCES * 6);
const _trailAttr = new THREE.BufferAttribute(_trailBuf, 3);
_trailAttr.usage = THREE.DynamicDrawUsage;
const _trailGeo = new THREE.BufferGeometry();
_trailGeo.setAttribute('position', _trailAttr);
const _trailLines = new THREE.LineSegments(_trailGeo, trailMat);
_trailLines.frustumCulled = false;
_trailLines.renderOrder = 2;

// Slot manager: stack LIFO con slot bassi in cima (→ count rimane compatto)
const _freeSlots = [];
for (let i = MAX_INSTANCES - 1; i >= 0; i--) _freeSlots.push(i);
const _usedSlots = new Set();

let _scene = null;
function _ensureInScene(scene) {
  if (!_scene) {
    _scene = scene;
    scene.add(_iMesh, _trailLines);
  }
}

function _updateCount() {
  let maxSlot = -1;
  for (const s of _usedSlots) if (s > maxSlot) maxSlot = s;
  _iMesh.count = maxSlot + 1;
  _trailGeo.setDrawRange(0, (maxSlot + 1) * 2);
}

// Reused every frame — safe perché JS è single-threaded
const _dir = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();

// ── Classe ────────────────────────────────────────────────────────────────────

export class ProjectileEntity {
  constructor(scene, id, theta, phi, altitude = FLY_ALTITUDE + 0.1) {
    this.id = id;
    this._altitude = altitude;
    this._slot = _freeSlots.pop() ?? -1;
    this._prevPos = new THREE.Vector3();
    this._currPos = new THREE.Vector3();
    this._initialized = false;

    _ensureInScene(scene);
    if (this._slot >= 0) {
      _usedSlots.add(this._slot);
      _updateCount();
    }
    this.update(theta, phi);
  }

  update(theta, phi) {
    if (this._slot < 0) return;

    this._prevPos.copy(this._currPos);
    const pos = sphericalToCartesian(theta, phi, this._altitude);
    this._currPos.set(pos.x, pos.y, pos.z);
    if (!this._initialized) {
      this._prevPos.copy(this._currPos);
      this._initialized = true;
    }

    // Matrice istanza
    _dummy.position.copy(this._currPos);
    _dummy.scale.set(1, 1, 1.5);
    _dir.subVectors(this._currPos, this._prevPos);
    if (_dir.lengthSq() > 1e-6) {
      _dir.normalize();
      _lookTarget.copy(_dir).multiplyScalar(0.22).add(this._currPos);
      _dummy.lookAt(_lookTarget);
      _dummy.rotateX(Math.PI / 2);
    } else {
      _dummy.quaternion.identity();
    }
    _dummy.updateMatrix();
    _iMesh.setMatrixAt(this._slot, _dummy.matrix);
    _iMesh.instanceMatrix.needsUpdate = true;

    // Trail nel buffer condiviso
    const base = this._slot * 6;
    _trailBuf[base]     = this._currPos.x;
    _trailBuf[base + 1] = this._currPos.y;
    _trailBuf[base + 2] = this._currPos.z;
    _lookTarget.copy(this._currPos).sub(_dir.setLength(0.6));
    _trailBuf[base + 3] = _lookTarget.x;
    _trailBuf[base + 4] = _lookTarget.y;
    _trailBuf[base + 5] = _lookTarget.z;
    _trailAttr.needsUpdate = true;
  }

  // Il parametro scene non serve più (le mesh sono nel pool globale) ma lo
  // manteniamo per compatibilità con le chiamate esistenti in main.js.
  dispose(_scene) {
    if (this._slot < 0) return;

    _dummy.scale.setScalar(0);
    _dummy.updateMatrix();
    _iMesh.setMatrixAt(this._slot, _dummy.matrix);
    _iMesh.instanceMatrix.needsUpdate = true;

    _trailBuf.fill(0, this._slot * 6, this._slot * 6 + 6);
    _trailAttr.needsUpdate = true;

    _usedSlots.delete(this._slot);
    _freeSlots.push(this._slot);
    _updateCount();
  }
}
