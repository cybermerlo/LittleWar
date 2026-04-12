import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sphericalToCartesian, cartesianToSpherical, sphereOrientation } from '../utils/SphereUtils.js';
import {
  FLY_ALTITUDE,
  MAX_BANK_ANGLE,
  BANK_GAIN,
  BANK_SMOOTH,
  BANK_MAX_DH_FRAME,
} from '../../shared/constants.js';

const _rollQuat = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
/** Smussatura posizione aerei remoti (1/s, verso lo stato rete). */
const REMOTE_NET_SMOOTH = 14;
const _modelLoader = new GLTFLoader();
const _modelTemplateCache = new Map();

const MODEL_PATHS = {
  airplane: '/models/Airplane.glb',
  spaceship: '/models/Spaceship.glb',
};

const MODEL_VISUAL_CONFIG = {
  airplane: { yaw: 0, size: 2.2 },
  spaceship: { yaw: Math.PI / 2, size: 2.2 },
};

function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function buildFallbackAirplaneMesh(color) {
  const group = new THREE.Group();
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
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
  const safeModelName = MODEL_PATHS[modelName] ? modelName : 'airplane';
  if (_modelTemplateCache.has(safeModelName)) {
    return _modelTemplateCache.get(safeModelName);
  }

  const templatePromise = new Promise((resolve) => {
    _modelLoader.load(
      MODEL_PATHS[safeModelName],
      (gltf) => resolve(gltf.scene),
      undefined,
      () => resolve(null),
    );
  });
  _modelTemplateCache.set(safeModelName, templatePromise);
  return templatePromise;
}

function tintModel(instance, color) {
  const tintColor = new THREE.Color(color);
  instance.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map((material) => {
        const cloned = material.clone();
        if (cloned.color) cloned.color.copy(tintColor);
        return cloned;
      });
    } else {
      const cloned = obj.material.clone();
      if (cloned.color) cloned.color.copy(tintColor);
      obj.material = cloned;
    }
  });
}

function fitModelToSize(instance, modelName) {
  const config = MODEL_VISUAL_CONFIG[modelName] ?? MODEL_VISUAL_CONFIG.airplane;
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

function buildAirplaneMesh(color, modelName) {
  const group = new THREE.Group();
  const fallbackMesh = buildFallbackAirplaneMesh(color);
  group.add(fallbackMesh);

  const shieldGeo = new THREE.SphereGeometry(1.6, 10, 10);
  const shieldMat = new THREE.MeshBasicMaterial({
    color: 0x44aaff,
    transparent: true,
    opacity: 0.25,
    side: THREE.FrontSide,
    depthWrite: false,
  });
  const shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
  shieldMesh.visible = false;
  shieldMesh.name = 'shield';
  group.add(shieldMesh);

  group.userData.shield = shieldMesh;
  group.userData.fallbackMesh = fallbackMesh;

  getModelTemplate(modelName).then((template) => {
    if (!template || group.userData.disposed) return;

    const model = template.clone(true);
    tintModel(model, color);
    fitModelToSize(model, modelName);

    if (group.userData.fallbackMesh) {
      group.remove(group.userData.fallbackMesh);
      group.userData.fallbackMesh = null;
    }
    group.add(model);
    group.userData.visualModel = model;
  });

  return group;
}

export class Airplane {
  constructor(scene, THREE_ref, color = '#ff4444', modelName = 'airplane', isLocal = false) {
    this.THREE = THREE_ref;
    this.mesh = buildAirplaneMesh(color, modelName);
    this.mesh.userData.isAirplane = true;
    scene.add(this.mesh);
    this.isLocal = isLocal;

    this.theta = Math.PI / 2;
    this.phi = 0;
    this.heading = 0;
    this._bankRoll = 0;
    this._lastHeading = undefined;
    this.sphereQuaternion = new THREE.Quaternion();

    this._targetPos = new THREE.Vector3(0, 1, 0);
    this._displayPos = new THREE.Vector3(0, 1, 0);
    this._targetHeading = 0;
    this._displayHeading = 0;
    this._netWeaponLevel = 0;
    this._netHasShield = false;
    this._remoteNetReady = false;
  }

  /**
   * Forza teletrasporto immediato alla posizione indicata (usato al respawn).
   */
  resetRemote(theta, phi, heading) {
    const c = sphericalToCartesian(theta, phi, 1);
    this._targetPos.set(c.x, c.y, c.z).normalize();
    this._displayPos.copy(this._targetPos);
    this._targetHeading = heading;
    this._displayHeading = heading;
    this._remoteNetReady = true;
    this._lastHeading = undefined;
    const sph = cartesianToSpherical(this._displayPos.x, this._displayPos.y, this._displayPos.z);
    this.update(sph.theta, sph.phi, heading, this._netWeaponLevel, this._netHasShield, 1 / 60);
  }

  setNetworkTarget(theta, phi, heading, weaponLevel, hasShield) {
    if (this.isLocal) return;
    const c = sphericalToCartesian(theta, phi, 1);
    this._targetPos.set(c.x, c.y, c.z).normalize();
    this._targetHeading = heading;
    this._netWeaponLevel = weaponLevel ?? 0;
    this._netHasShield = !!hasShield;
    if (!this._remoteNetReady || this._displayPos.distanceTo(this._targetPos) > 0.35) {
      this._displayPos.copy(this._targetPos);
      this._displayHeading = heading;
      this._remoteNetReady = true;
      this._lastHeading = undefined;
      const sph = cartesianToSpherical(this._displayPos.x, this._displayPos.y, this._displayPos.z);
      this.update(sph.theta, sph.phi, this._displayHeading, this._netWeaponLevel, this._netHasShield, 1 / 60);
    }
  }

  tickRemote(delta) {
    if (this.isLocal || !this._remoteNetReady) return;
    const k = 1 - Math.exp(-REMOTE_NET_SMOOTH * delta);
    this._displayPos.lerp(this._targetPos, k).normalize();
    const sph = cartesianToSpherical(this._displayPos.x, this._displayPos.y, this._displayPos.z);
    let dh = wrapAngle(this._targetHeading - this._displayHeading);
    this._displayHeading += dh * k;
    this.update(sph.theta, sph.phi, this._displayHeading, this._netWeaponLevel, this._netHasShield, delta);
  }

  update(theta, phi, heading, weaponLevel, hasShield, delta = 1 / 60) {
    this.theta = theta;
    this.phi = phi;
    this.heading = heading;

    const pos = sphericalToCartesian(theta, phi, FLY_ALTITUDE);
    this.mesh.position.set(pos.x, pos.y, pos.z);

    const q = sphereOrientation(this.THREE, theta, phi, heading);

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

    this.sphereQuaternion.copy(q);

    _rollQuat.setFromAxisAngle(_axisX, this._bankRoll);
    this.mesh.quaternion.copy(q).multiply(_rollQuat);

    if (this.mesh.userData.shield) {
      this.mesh.userData.shield.visible = hasShield;
    }
  }

  dispose(scene) {
    this.mesh.userData.disposed = true;
    scene.remove(this.mesh);
  }
}
