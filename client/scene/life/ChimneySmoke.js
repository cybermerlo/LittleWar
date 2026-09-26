import * as THREE from 'three';
import { withLifeUniforms } from './lifeShared.js';

/**
 * Fumo dai comignoli: sbuffi low-poly che salgono e si piegano col vento.
 *
 * Tutto nel vertex shader: ogni sbuffo è un'istanza con origine, verticale e
 * seme; età, quota, deriva, dimensione e trasparenza escono da `uTime`. Una
 * draw call per tutto il pianeta, nessun lavoro di CPU per frame.
 *
 * Il comignolo sta in un punto preciso del modello `building-house.glb`, non
 * al centro del tetto. Per trovarlo sulla casa piazzata serve la sua
 * rotazione completa (`quaternion` in `terrainGroup.userData.buildings`):
 * senza, il fumo parte dal colmo, al centro della casa.
 */

/**
 * Centro della bocca del comignolo nel frame del template normalizzato
 * (base a y = 0, centrato in pianta, lato maggiore 3.2 unità): misurato sul
 * modello. Se il modello cambia e lì non c'è più un vertice, il fumo si spegne
 * invece di uscire dal nulla (vedi `findChimney`).
 */
const CHIMNEY_TOP = new THREE.Vector3(0.63, 1.249, -0.475);
/** Altezza del colmo nello stesso frame, per il ripiego senza rotazione. */
const RIDGE_TOP = 1.29;

const PUFFS_PER_CHIMNEY = 6;
/** Una casa su N fuma (scelta deterministica per indice). */
const SMOKING_SHARE = 0.5;

const SMOKE_VERT = /* glsl */`
  attribute vec3 aOrigin;
  attribute vec3 aUp;
  attribute vec4 aSeed;     // x fase, y cadenza (1/s), z dimensione massima, w grigio
  uniform float uTime;
  uniform vec3 uWind;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  varying vec3 vColor;
  varying float vAlpha;
  #include <fog_pars_vertex>

  void main() {
    float age = fract(uTime * aSeed.y + aSeed.x);
    vec3 up = aUp;
    vec3 w = uWind - up * dot(uWind, up);
    w = w / max(length(w), 1e-4);
    float gust = 1.0 + 0.35 * sin(uTime * 0.31 + aSeed.x * 6.0);
    vec3 center = aOrigin + up * (age * 1.7) + w * (age * age * 1.2 * gust);
    float size = mix(0.05, aSeed.z, sqrt(age));
    vec3 world = center + position * size;

    vAlpha = smoothstep(0.0, 0.08, age) * pow(1.0 - age, 1.3);
    float ndl = max(dot(normal, uSunDir), 0.0);
    vColor = vec3(aSeed.w) * (uAmbient + uSunColor * (0.3 + 0.7 * ndl));

    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const SMOKE_FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(vColor, vAlpha * 0.55);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** Raggio d'impronta come lo stima Terrain.js (serve a ricavare la scala di ogni casa). */
function footprintOf(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const hw = Math.max((box.max.x - box.min.x) * 0.5, 0.01);
  const hd = Math.max((box.max.z - box.min.z) * 0.5, 0.01);
  return (Math.max(hw, hd) + Math.sqrt(hw * hw + hd * hd)) * 0.5;
}

/** true se il template ha davvero un vertice sulla bocca del comignolo. */
function findChimney(template) {
  template.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let found = false;
  template.traverse((o) => {
    if (found || !o.isMesh) return;
    const p = o.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      if (Math.abs(v.y - CHIMNEY_TOP.y) < 0.02 && Math.hypot(v.x - CHIMNEY_TOP.x, v.z - CHIMNEY_TOP.z) < 0.15) {
        found = true;
        return;
      }
    }
  });
  return found;
}

export class ChimneySmoke {
  /**
   * @param {THREE.Scene} scene
   * @param {{buildings?: Array<{position:THREE.Vector3, up:THREE.Vector3, size:number, kind:string, quaternion?:THREE.Quaternion, scale?:number}>,
   *          houseTemplate?: THREE.Object3D}} [options]
   */
  constructor(scene, { buildings = [], houseTemplate = null } = {}) {
    this.enabled = true;
    // Senza il modello GLB (qualità bassa o caricamento fallito) le case sono
    // scatole procedurali senza comignolo: niente fumo.
    const usable = houseTemplate && findChimney(houseTemplate);
    const tplFootprint = usable ? footprintOf(houseTemplate) : 1;

    const emitters = [];
    const origin = new THREE.Vector3();
    buildings.forEach((b, i) => {
      if (!usable || b.kind !== 'house') return;
      // Hash dell'indice: sempre le stesse case, ben mescolate.
      const h = Math.abs(Math.sin(i * 12.9898 + 4.1) * 43758.5453) % 1;
      if (h > SMOKING_SHARE) return;
      const s = b.scale ?? b.size / tplFootprint;
      if (b.quaternion) {
        origin.copy(CHIMNEY_TOP).multiplyScalar(s).applyQuaternion(b.quaternion).add(b.position);
      } else {
        origin.copy(b.position).addScaledVector(b.up, RIDGE_TOP * s);
      }
      emitters.push({ origin: origin.clone(), up: b.up.clone().normalize(), s, h });
    });

    const total = emitters.length * PUFFS_PER_CHIMNEY;
    this.count = total;
    const aOrigin = new Float32Array(total * 3);
    const aUp = new Float32Array(total * 3);
    const aSeed = new Float32Array(total * 4);
    let k = 0;
    for (const e of emitters) {
      const rate = 0.22 + e.h * 0.12;
      for (let p = 0; p < PUFFS_PER_CHIMNEY; p++, k++) {
        aOrigin.set([e.origin.x, e.origin.y, e.origin.z], k * 3);
        aUp.set([e.up.x, e.up.y, e.up.z], k * 3);
        aSeed.set([
          p / PUFFS_PER_CHIMNEY + e.h * 0.37,
          rate,
          (0.2 + ((p * 7 + 3) % 5) * 0.022) * Math.min(1.2, e.s),
          0.78 + ((p * 5 + 1) % 4) * 0.05,
        ], k * 4);
      }
    }

    const puff = new THREE.IcosahedronGeometry(1, 0); // normali di faccia: sbuffi sfaccettati
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', puff.getAttribute('position'));
    geo.setAttribute('normal', puff.getAttribute('normal'));
    geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(aOrigin, 3));
    geo.setAttribute('aUp', new THREE.InstancedBufferAttribute(aUp, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 4));
    geo.instanceCount = total;

    this.uniforms = withLifeUniforms({
      uWind: { value: new THREE.Vector3(0.62, 0.18, 0.76).normalize() },
    });
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'chimney-smoke';
    this.mesh.visible = total > 0;
    scene.add(this.mesh);
  }

  setEnabled(on) {
    this.enabled = on;
    this.mesh.visible = on && this.count > 0;
  }
}
