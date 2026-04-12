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
const BOOST_PARTICLE_COUNT = 84;
const BOOST_PARTICLE_SPAWN_RATE = 180; // particelle/s a boost pieno

const _tailLocal = new THREE.Vector3(-1.1, 0, 0);
const _tailWorld = new THREE.Vector3();
const _forward = new THREE.Vector3(1, 0, 0);
const _backward = new THREE.Vector3();
const _right = new THREE.Vector3(0, 0, 1);
const _up = new THREE.Vector3(0, 1, 0);

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

function createBoostParticleSystem() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(BOOST_PARTICLE_COUNT * 3);
  const life = new Float32Array(BOOST_PARTICLE_COUNT);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aLife', new THREE.BufferAttribute(life, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0xffa31a) },
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
        gl_PointSize = size * (175.0 / max(1.0, -mvPos.z));
      }
    `,
    fragmentShader: `
      varying float vLife;
      uniform vec3 uColor;
      void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float d = length(p);
        float core = smoothstep(0.38, 0.0, d);
        float glow = smoothstep(0.72, 0.12, d);
        float alpha = (core * 0.72 + glow * 0.22) * vLife;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 4;

  return { points, geometry, material, positions, life };
}

export class Airplane {
  constructor(scene, THREE_ref, color = '#ff4444', modelName = 'airplane', isLocal = false) {
    this._scene = scene;
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
    /** Boost visivo remoto 0..1 (da game-state server). */
    this._netBoostAmount = 0;
    this._remoteNetReady = false;

    // Coda particellare turbo (world space): locale e remoti.
    this._boostPoints = null;
    this._boostGeometry = null;
    this._boostMaterial = null;
    this._boostPositions = null;
    this._boostLife = null;
    this._boostVel = null;
    this._boostSpawnAcc = 0;
    this._boostHead = 0;
    const ps = createBoostParticleSystem();
    this._boostPoints = ps.points;
    this._boostGeometry = ps.geometry;
    this._boostMaterial = ps.material;
    this._boostPositions = ps.positions;
    this._boostLife = ps.life;
    this._boostVel = new Float32Array(BOOST_PARTICLE_COUNT * 3);
    scene.add(this._boostPoints);
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
    this.update(sph.theta, sph.phi, heading, this._netWeaponLevel, this._netHasShield, 1 / 60, this._netBoostAmount);
  }

  setNetworkTarget(theta, phi, heading, weaponLevel, hasShield, boostAmount = 0) {
    if (this.isLocal) return;
    const c = sphericalToCartesian(theta, phi, 1);
    this._targetPos.set(c.x, c.y, c.z).normalize();
    this._targetHeading = heading;
    this._netWeaponLevel = weaponLevel ?? 0;
    this._netHasShield = !!hasShield;
    this._netBoostAmount = THREE.MathUtils.clamp(boostAmount, 0, 1);
    if (!this._remoteNetReady || this._displayPos.distanceTo(this._targetPos) > 0.35) {
      this._displayPos.copy(this._targetPos);
      this._displayHeading = heading;
      this._remoteNetReady = true;
      this._lastHeading = undefined;
      const sph = cartesianToSpherical(this._displayPos.x, this._displayPos.y, this._displayPos.z);
      this.update(
        sph.theta,
        sph.phi,
        this._displayHeading,
        this._netWeaponLevel,
        this._netHasShield,
        1 / 60,
        this._netBoostAmount,
      );
    }
  }

  tickRemote(delta) {
    if (this.isLocal || !this._remoteNetReady) return;
    const k = 1 - Math.exp(-REMOTE_NET_SMOOTH * delta);
    this._displayPos.lerp(this._targetPos, k).normalize();
    const sph = cartesianToSpherical(this._displayPos.x, this._displayPos.y, this._displayPos.z);
    let dh = wrapAngle(this._targetHeading - this._displayHeading);
    this._displayHeading += dh * k;
    this.update(
      sph.theta,
      sph.phi,
      this._displayHeading,
      this._netWeaponLevel,
      this._netHasShield,
      delta,
      this._netBoostAmount,
    );
  }

  /** Nasconde le particelle turbo (oggetto separato dalla mesh; es. giocatore morto). */
  setBoostParticlesVisible(visible) {
    if (!this._boostPoints) return;
    this._boostPoints.visible = visible;
    if (!visible && this._boostLife) {
      for (let i = 0; i < BOOST_PARTICLE_COUNT; i++) this._boostLife[i] = 0;
      this._boostSpawnAcc = 0;
    }
  }

  update(theta, phi, heading, weaponLevel, hasShield, delta = 1 / 60, boostAmount = 0) {
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
    this._updateBoostParticles(delta, boostAmount);
  }

  _updateBoostParticles(delta, boostAmount) {
    if (!this._boostPoints || !this._boostGeometry || !this._boostLife || !this._boostVel) return;

    const amount = THREE.MathUtils.clamp(boostAmount, 0, 1);
    const posAttr = this._boostGeometry.getAttribute('position');
    const lifeAttr = this._boostGeometry.getAttribute('aLife');

    // Aggiorna particelle vive (fade + movimento)
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
    }

    // Emetti nuove particelle solo con boost attivo.
    this._boostSpawnAcc += amount * BOOST_PARTICLE_SPAWN_RATE * delta;
    const toSpawn = Math.floor(this._boostSpawnAcc);
    this._boostSpawnAcc -= toSpawn;

    this.mesh.updateMatrixWorld(true);
    _tailWorld.copy(_tailLocal).applyMatrix4(this.mesh.matrixWorld);
    _backward.copy(_forward).applyQuaternion(this.mesh.quaternion).multiplyScalar(-1);
    const rightW = _right.clone().applyQuaternion(this.mesh.quaternion);
    const upW = _up.clone().applyQuaternion(this.mesh.quaternion);

    for (let s = 0; s < toSpawn; s++) {
      const i = this._boostHead;
      this._boostHead = (this._boostHead + 1) % BOOST_PARTICLE_COUNT;
      const j = i * 3;

      const jitterR = (Math.random() - 0.5) * 0.16;
      const jitterU = (Math.random() - 0.5) * 0.16;
      this._boostPositions[j] = _tailWorld.x + rightW.x * jitterR + upW.x * jitterU;
      this._boostPositions[j + 1] = _tailWorld.y + rightW.y * jitterR + upW.y * jitterU;
      this._boostPositions[j + 2] = _tailWorld.z + rightW.z * jitterR + upW.z * jitterU;

      const speed = 9 + amount * 13 + Math.random() * 4;
      this._boostVel[j] = _backward.x * speed + (Math.random() - 0.5) * 1.8;
      this._boostVel[j + 1] = _backward.y * speed + (Math.random() - 0.5) * 1.8;
      this._boostVel[j + 2] = _backward.z * speed + (Math.random() - 0.5) * 1.8;
      this._boostLife[i] = 0.45 + amount * 0.55;
    }

    posAttr.needsUpdate = true;
    lifeAttr.needsUpdate = true;
  }

  dispose(scene) {
    this.mesh.userData.disposed = true;
    if (this._boostPoints) this._scene.remove(this._boostPoints);
    if (this._boostGeometry) this._boostGeometry.dispose();
    if (this._boostMaterial) this._boostMaterial.dispose();
    scene.remove(this.mesh);
  }
}
