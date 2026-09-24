import * as THREE from 'three';
import { sampleGround, makeSurfaceHit, SEA_SURFACE_RADIUS } from '../scene/planetSurface.js';
import { MAX_PLAYERS } from '../../shared/constants.js';

/**
 * Ombra morbida sotto ogni aereo, proiettata sul terreno (o sull'acqua).
 *
 * Gli aerei volano radenti: senza un'ombra l'occhio non capisce a che quota
 * sono rispetto a colline e bersagli, e da dietro sembrano sospesi nel vuoto.
 * Una macchia scura che si stringe e si scurisce quando l'aereo scende basta a
 * "piantarli" nella scena. Tutte le ombre sono istanze di una sola mesh.
 */

const SIZE = 2.1;          // diametro a contatto col suolo
const LIFT = 0.07;         // sollevamento sopra la faccia, contro lo z-fighting

function makeShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const _hit = makeSurfaceHit();
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _zAxis = new THREE.Vector3(0, 0, 1);

export class PlaneShadows {
  constructor(scene) {
    const geo = new THREE.CircleGeometry(SIZE / 2, 20);
    this.material = new THREE.MeshBasicMaterial({
      color: 0x0b1020,
      alphaMap: makeShadowTexture(),
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, MAX_PLAYERS + 2);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this._n = 0;
  }

  /** Inizio frame: di notte le ombre quasi spariscono. */
  begin(nightFactor = 0) {
    this._n = 0;
    this.material.opacity = 0.34 * (1 - 0.75 * nightFactor);
  }

  /** Ombra sotto un aereo in posizione world `planePos`. */
  add(planePos) {
    if (this._n >= this.mesh.instanceMatrix.count) return;
    _dir.copy(planePos).normalize();
    sampleGround(_dir, _hit);
    let groundR = _hit.radius;
    _normal.copy(_hit.normal);
    // Sul mare l'ombra cade sull'acqua, non sul fondale.
    if (groundR < SEA_SURFACE_RADIUS) {
      groundR = SEA_SURFACE_RADIUS;
      _normal.copy(_dir);
    }
    const height = Math.max(0, planePos.length() - groundR);
    // Più in alto = più larga e più tenue (qui simulato solo con la scala).
    const spread = 1 + height * 0.09;
    _pos.copy(_dir).multiplyScalar(groundR).addScaledVector(_normal, LIFT);
    _q.setFromUnitVectors(_zAxis, _normal);
    _s.set(spread, spread, 1);
    _m.compose(_pos, _q, _s);
    this.mesh.setMatrixAt(this._n++, _m);
  }

  end() {
    this.mesh.count = this._n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
