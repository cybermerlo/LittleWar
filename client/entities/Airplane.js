import * as THREE from 'three';
import { createGLTFLoader } from '../utils/createGLTFLoader.js';
import { sphericalToCartesian, cartesianToSpherical, sphereOrientation } from '../utils/SphereUtils.js';
import {
  FLY_ALTITUDE,
  MAX_BANK_ANGLE,
  BANK_GAIN,
  BANK_SMOOTH,
  BANK_MAX_DH_FRAME,
} from '../../shared/constants.js';

const _rollQuat = new THREE.Quaternion();
const _bankOnlyQuat = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
/** Smussatura posizione aerei remoti (1/s, verso lo stato rete). */
const REMOTE_NET_SMOOTH = 14;
const _modelLoader = createGLTFLoader();
const _modelTemplateCache = new Map();

const MODEL_PATHS = {
  spitfire: '/models/spitfire.glb',
};

const MODEL_VISUAL_CONFIG = {
  // spitfire: naso verso -Z → yaw = -π/2; colore giocatore solo su "blue"
  spitfire: { yaw: -Math.PI / 2, size: 2.2, tintMaterials: ['blue'], propSpeed: 4.5 },
};
const BOOST_PARTICLE_COUNT = 84;
const BOOST_PARTICLE_SPAWN_RATE = 180; // particelle/s a boost pieno

const _tailLocal = new THREE.Vector3(-1.1, 0, 0);
const _tailWorld = new THREE.Vector3();
const _forward = new THREE.Vector3(1, 0, 0);
const _backward = new THREE.Vector3();
const _right = new THREE.Vector3(0, 0, 1);
const _up = new THREE.Vector3(0, 1, 0);

// Wingtip vortex trails
const WINGTIP_TRAIL_LENGTH = 32;
const _leftTipLocal = new THREE.Vector3(0, 0, -1.1);
const _rightTipLocal = new THREE.Vector3(0, 0, 1.1);
const _tipTemp = new THREE.Vector3();

const NAVLIGHT_SPHERE_R = 0.045;
const NAVLIGHT_Y_OFFSET = 0.03;
const NAVLIGHT_POINT_DISTANCE = 0.55;
const NAVLIGHT_POINT_DECAY = 2.0;
const NAVLIGHT_POINT_INTENSITY = 2.4;
const NAVLIGHT_BLINK_HZ = 0.55; // lampeggio lento
const SPIN_DURATION = 0.48;

function smooth01(x) {
  return THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(x, 0, 1), 0, 1);
}

function blinkGate(t) {
  // onda quadra smussata: 0..1
  const phase = (t * NAVLIGHT_BLINK_HZ) % 1;
  // smussa i bordi per evitare "pop" duro con bloom/tonemapping
  const edge = 0.08;
  if (phase >= 0.5) return 0;
  const up = THREE.MathUtils.smoothstep(phase, 0, edge);
  const down = 1 - THREE.MathUtils.smoothstep(phase, 0.5 - edge, 0.5);
  return up * down;
}

function createWingtipTrail() {
  const N = WINGTIP_TRAIL_LENGTH;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  line.renderOrder = 3;
  return { line, geo, mat, positions, colors, initialized: false };
}

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
 * Applica il colore giocatore ai materiali del modello.
 * @param {THREE.Object3D} instance
 * @param {string} color  - colore giocatore (#rrggbb)
 * @param {string[]|null} tintMaterials - lista di nomi materiale da tingere; null = tutti
 */
function tintModel(instance, color, tintMaterials) {
  const tintColor = new THREE.Color(color);
  const shouldTint = (mat) => !tintMaterials || tintMaterials.includes(mat.name);
  instance.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map((mat) => {
        if (!shouldTint(mat)) return mat;
        const cloned = mat.clone();
        if (cloned.color) cloned.color.copy(tintColor);
        return cloned;
      });
    } else {
      if (!shouldTint(obj.material)) return;
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
  // Posizioni punte ali di default (fallback mesh: BoxGeometry wings a (-0.1, 0, ±1.1))
  group.userData.leftTipLocal = new THREE.Vector3(-0.1, 0, -1.1);
  group.userData.rightTipLocal = new THREE.Vector3(-0.1, 0, 1.1);

  getModelTemplate(modelName).then((template) => {
    if (!template || group.userData.disposed) return;

    const model = template.scene.clone(true);
    const cfg = MODEL_VISUAL_CONFIG[modelName] ?? MODEL_VISUAL_CONFIG.airplane;
    tintModel(model, color, cfg.tintMaterials ?? null);
    fitModelToSize(model, modelName);

    // Calcola le punte ali PRIMA di aggiungere il modello al gruppo,
    // così setFromObject usa solo la matrice locale del modello (scale/rot/pos da fitModelToSize)
    // e non include la posizione world del gruppo (aereo già posizionato sulla sfera).
    model.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(model);
    const midX = (bbox.min.x + bbox.max.x) / 2;
    const midY = (bbox.min.y + bbox.max.y) / 2;
    group.userData.leftTipLocal = new THREE.Vector3(midX, midY, bbox.min.z);
    group.userData.rightTipLocal = new THREE.Vector3(midX, midY, bbox.max.z);
    if (group.userData.leftTrailRef) group.userData.leftTrailRef.initialized = false;
    if (group.userData.rightTrailRef) group.userData.rightTrailRef.initialized = false;

    if (group.userData.fallbackMesh) {
      group.remove(group.userData.fallbackMesh);
      group.userData.fallbackMesh = null;
    }
    group.add(model);
    group.userData.visualModel = model;

    // Configura AnimationMixer per le animazioni del modello (es. elica spitfire)
    if (template.animations && template.animations.length > 0) {
      const mixer = new THREE.AnimationMixer(model);
      group.userData.mixer = mixer;

      const propClip =
        THREE.AnimationClip.findByName(template.animations, 'PropellerAction') ??
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
        gl_PointSize = size * (175.0 / max(1.0, -mvPos.z));
      }
    `,
    fragmentShader: `
      varying float vLife;
      uniform vec3 uColor;
      uniform vec3 uPlayerTint;
      void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float d = length(p);
        float core = smoothstep(0.38, 0.0, d);
        float glow = smoothstep(0.72, 0.12, d);
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
    this.flightQuaternion = new THREE.Quaternion();

    this._targetPos = new THREE.Vector3(0, 1, 0);
    this._displayPos = new THREE.Vector3(0, 1, 0);
    this._targetHeading = 0;
    this._displayHeading = 0;
    this._netWeaponLevel = 0;
    this._netHasShield = false;
    /** Boost visivo remoto 0..1 (da game-state server). */
    this._netBoostAmount = 0;
    this._remoteNetReady = false;
    this._fxVisible = true;
    this._spinDirection = 0;
    this._spinProgress = 0;
    this._spinRoll = 0;

    // Luci alari (solo notte)
    this._nightFactor = 0;
    this._navTime = Math.random() * 10; // desincronizza leggermente tra player
    this._navGeo = new THREE.SphereGeometry(NAVLIGHT_SPHERE_R, 10, 10);
    this._navLeftMat = new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0 });
    this._navRightMat = new THREE.MeshBasicMaterial({ color: 0x33ff66, transparent: true, opacity: 0 });
    this._navGroup = new THREE.Group();
    this._navGroup.name = 'navLights';

    this._navLeftMesh = new THREE.Mesh(this._navGeo, this._navLeftMat);
    this._navRightMesh = new THREE.Mesh(this._navGeo, this._navRightMat);
    this._navLeftMesh.renderOrder = 5;
    this._navRightMesh.renderOrder = 5;
    this._navLeftMesh.frustumCulled = false;
    this._navRightMesh.frustumCulled = false;

    this._navLeftLight = new THREE.PointLight(0xff3344, 0, NAVLIGHT_POINT_DISTANCE, NAVLIGHT_POINT_DECAY);
    this._navRightLight = new THREE.PointLight(0x33ff66, 0, NAVLIGHT_POINT_DISTANCE, NAVLIGHT_POINT_DECAY);
    this._navGroup.add(this._navLeftMesh, this._navRightMesh, this._navLeftLight, this._navRightLight);
    this.mesh.add(this._navGroup);

    // Coda particellare turbo (world space): locale e remoti.
    this._boostPoints = null;
    this._boostGeometry = null;
    this._boostMaterial = null;
    this._boostPositions = null;
    this._boostLife = null;
    this._boostVel = null;
    this._boostSpawnAcc = 0;
    this._boostHead = 0;
    const ps = createBoostParticleSystem(color);
    this._boostPoints = ps.points;
    this._boostGeometry = ps.geometry;
    this._boostMaterial = ps.material;
    this._boostPositions = ps.positions;
    this._boostLife = ps.life;
    this._boostVel = new Float32Array(BOOST_PARTICLE_COUNT * 3);
    scene.add(this._boostPoints);

    // Wingtip vortex trails
    this._leftTrail = createWingtipTrail();
    this._rightTrail = createWingtipTrail();
    scene.add(this._leftTrail.line);
    scene.add(this._rightTrail.line);
    // Espone i trail al callback asincrono del loader per resettarli al caricamento del modello
    this.mesh.userData.leftTrailRef = this._leftTrail;
    this.mesh.userData.rightTrailRef = this._rightTrail;
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

  /** Nasconde le particelle turbo e le wingtip trails (oggetti separati dalla mesh; es. giocatore morto). */
  setBoostParticlesVisible(visible) {
    if (!this._boostPoints) return;
    if (this._fxVisible === visible) return;
    this._fxVisible = visible;
    this._boostPoints.visible = visible;
    if (!visible && this._boostLife) {
      for (let i = 0; i < BOOST_PARTICLE_COUNT; i++) this._boostLife[i] = 0;
      this._boostSpawnAcc = 0;
    }
    if (this._leftTrail) {
      this._leftTrail.line.visible = visible;
      if (!visible) this._leftTrail.initialized = false;
    }
    if (this._rightTrail) {
      this._rightTrail.line.visible = visible;
      if (!visible) this._rightTrail.initialized = false;
    }
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
    this._updateSpin(delta);

    this.sphereQuaternion.copy(q);
    _bankOnlyQuat.setFromAxisAngle(_axisX, this._bankRoll);
    this.flightQuaternion.copy(q).multiply(_bankOnlyQuat);

    _rollQuat.setFromAxisAngle(_axisX, this._bankRoll + this._spinRoll);
    this.mesh.quaternion.copy(q).multiply(_rollQuat);

    if (this.mesh.userData.shield) {
      this.mesh.userData.shield.visible = hasShield;
    }

    // Aggiorna AnimationMixer (elica spitfire e altri modelli animati)
    if (this.mesh.userData.mixer) {
      this.mesh.userData.mixer.update(delta);
      if (this.mesh.userData.propellerAction) {
        const base = this.mesh.userData.propSpeed ?? 6.0;
        this.mesh.userData.propellerAction.timeScale = base + boostAmount * base;
      }
    }

    this._updateBoostParticles(delta, boostAmount);
    this._updateWingtipTrails();
    this._updateNavLights(delta);
  }

  _updateNavLights(delta) {
    if (!this._navGroup) return;

    this._navTime += Math.max(0, delta);

    // Fade-in durante crepuscolo; di giorno resta a 0.
    const nightVis = smooth01((this._nightFactor - 0.55) / 0.25);
    if (nightVis <= 0.001) {
      this._navGroup.visible = false;
      this._navLeftMat.opacity = 0;
      this._navRightMat.opacity = 0;
      this._navLeftLight.intensity = 0;
      this._navRightLight.intensity = 0;
      return;
    }
    this._navGroup.visible = true;

    // Posiziona alle punte ali (coordinate locali già calcolate per fallback/GLB)
    const left = this.mesh.userData.leftTipLocal ?? _leftTipLocal;
    const right = this.mesh.userData.rightTipLocal ?? _rightTipLocal;
    this._navLeftMesh.position.set(left.x, left.y + NAVLIGHT_Y_OFFSET, left.z);
    this._navRightMesh.position.set(right.x, right.y + NAVLIGHT_Y_OFFSET, right.z);
    this._navLeftLight.position.copy(this._navLeftMesh.position);
    this._navRightLight.position.copy(this._navRightMesh.position);

    const blink = blinkGate(this._navTime);
    const intensity = nightVis * blink;

    this._navLeftMat.opacity = intensity;
    this._navRightMat.opacity = intensity;
    this._navLeftLight.intensity = intensity * NAVLIGHT_POINT_INTENSITY;
    this._navRightLight.intensity = intensity * NAVLIGHT_POINT_INTENSITY;
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

  _updateWingtipTrails() {
    this.mesh.updateMatrixWorld(true);
    this._updateSingleTrail(this._leftTrail, this.mesh.userData.leftTipLocal);
    this._updateSingleTrail(this._rightTrail, this.mesh.userData.rightTipLocal);
  }

  _updateSingleTrail(trail, localPos) {
    const N = WINGTIP_TRAIL_LENGTH;
    const { positions, colors, geo } = trail;

    _tipTemp.copy(localPos).applyMatrix4(this.mesh.matrixWorld);

    if (!trail.initialized) {
      for (let i = 0; i < N; i++) {
        positions[i * 3] = _tipTemp.x;
        positions[i * 3 + 1] = _tipTemp.y;
        positions[i * 3 + 2] = _tipTemp.z;
      }
      trail.initialized = true;
    } else {
      for (let i = N - 1; i > 0; i--) {
        positions[i * 3] = positions[(i - 1) * 3];
        positions[i * 3 + 1] = positions[(i - 1) * 3 + 1];
        positions[i * 3 + 2] = positions[(i - 1) * 3 + 2];
      }
      positions[0] = _tipTemp.x;
      positions[1] = _tipTemp.y;
      positions[2] = _tipTemp.z;
    }

    // Quadratic fade: bianco vicino all'ala, invisibile in coda
    for (let i = 0; i < N; i++) {
      const t = 1 - i / (N - 1);
      const b = t * t * 0.55;
      colors[i * 3] = b;
      colors[i * 3 + 1] = b;
      colors[i * 3 + 2] = b;
    }

    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('color').needsUpdate = true;
  }

  dispose(scene) {
    this.mesh.userData.disposed = true;
    if (this.mesh.userData.mixer) this.mesh.userData.mixer.stopAllAction();
    if (this._boostPoints) this._scene.remove(this._boostPoints);
    if (this._boostGeometry) this._boostGeometry.dispose();
    if (this._boostMaterial) this._boostMaterial.dispose();
    if (this._leftTrail) { this._scene.remove(this._leftTrail.line); this._leftTrail.geo.dispose(); this._leftTrail.mat.dispose(); }
    if (this._rightTrail) { this._scene.remove(this._rightTrail.line); this._rightTrail.geo.dispose(); this._rightTrail.mat.dispose(); }
    if (this._navGroup) {
      this.mesh.remove(this._navGroup);
      this._navGroup = null;
    }
    if (this._navGeo) this._navGeo.dispose();
    if (this._navLeftMat) this._navLeftMat.dispose();
    if (this._navRightMat) this._navRightMat.dispose();
    scene.remove(this.mesh);
  }
}
