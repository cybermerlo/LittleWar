import * as THREE from 'three';

/**
 * Puntini luminosi a dimensione minima sullo schermo.
 *
 * Un oggetto piccolo in unità mondo (una luce di navigazione, un proiettile)
 * a trenta unità di distanza copre meno di un pixel: con il bloom sfarfalla
 * entrando e uscendo dai pixel del target ridotto, senza bloom (qualità bassa)
 * semplicemente sparisce. Qui ogni istanza è un quad rivolto alla camera la
 * cui dimensione è `max(dimensione mondo, uMinPx pixel)`: da vicino si
 * comporta come un oggetto vero, da lontano resta un puntino netto.
 *
 * La dimensione mondo è la scala X della matrice d'istanza, il colore è
 * `instanceColor` (moltiplicato per l'intensità: il blending è additivo).
 * Chi usa il materiale deve chiamare `setColorAt(0, …)` alla creazione, così
 * lo shader nasce già con il colore per istanza e non si ricompila al primo uso.
 */

/** Altezza della finestra in pixel CSS, condivisa da tutti i materiali. */
const _viewportH = { value: typeof window !== 'undefined' ? window.innerHeight : 720 };

/**
 * Da chiamare quando cambia la finestra (costa un'assegnazione: lo si può
 * fare anche a ogni frame). In pixel CSS e non del drawing buffer: così la
 * dimensione minima resta la stessa anche quando la risoluzione adattiva
 * abbassa il DPR.
 */
export function setGlowViewportHeight(h) {
  if (h > 0) _viewportH.value = h;
}

const VERTEX = /* glsl */ `
  uniform float uViewportH;
  uniform float uMinPx;
  uniform float uTowardCam;
  uniform float uFarDim;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = position.xy * 2.0;
    vColor = instanceColor;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // Avvicinato alla camera: una luce sulla punta dell'ala non deve finire
    // tagliata a metà dal depth test contro l'ala stessa.
    mv.xyz += normalize(-mv.xyz) * uTowardCam;
    float worldSize = length(instanceMatrix[0].xyz);
    float pxWorld = -mv.z * 2.0 / (projectionMatrix[1][1] * uViewportH);
    float minSize = uMinPx * pxWorld;
    // Sotto la dimensione minima il puntino smette di rimpicciolirsi e
    // perde un po' di intensità: resta visibile senza sembrare un faro.
    vColor *= mix(1.0 - uFarDim, 1.0, clamp(worldSize / max(minSize, 1e-6), 0.0, 1.0));
    mv.xy += position.xy * max(worldSize, minSize);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uCore;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float r2 = dot(vUv, vUv);
    if (r2 >= 1.0) discard;
    // Nucleo pieno più alone morbido: il nucleo tiene il puntino netto anche
    // quando è grande pochi pixel, l'alone lo fa sembrare una luce.
    float a = smoothstep(uCore, 0.0, r2) * 0.75 + (1.0 - r2) * (1.0 - r2) * 0.45;
    gl_FragColor = vec4(vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * @param {object} [o]
 * @param {number} [o.minPx]      diametro minimo in pixel CSS
 * @param {number} [o.towardCam]  spostamento verso la camera (unità mondo)
 * @param {number} [o.farDim]     attenuazione massima quando è alla dimensione minima (0..1)
 * @param {number} [o.core]       raggio² del nucleo pieno (0..1)
 */
export function makeGlowSpriteMaterial({ minPx = 3, towardCam = 0, farDim = 0, core = 0.18 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uViewportH: _viewportH,
      uMinPx: { value: minPx },
      uTowardCam: { value: towardCam },
      uFarDim: { value: farDim },
      uCore: { value: core },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Quad unitario centrato: il vertex shader lo gira verso la camera. */
export const glowQuadGeometry = new THREE.PlaneGeometry(1, 1);

/**
 * Lotto di puntini riempito a ogni frame da chi li vuole (luci di
 * navigazione di tutti gli aerei): una sola draw call per tutti.
 * `add()` durante il frame, `flush()` una volta prima del render.
 */
export class GlowSpriteBatch {
  constructor(scene, capacity, materialOptions) {
    this.material = makeGlowSpriteMaterial(materialOptions);
    this.mesh = new THREE.InstancedMesh(glowQuadGeometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this._n = 0;
    this._cap = capacity;
  }

  /** Un puntino in `pos` (world), diametro mondo `size`, colore già moltiplicato per l'intensità. */
  add(pos, size, r, g, b) {
    if (this._n >= this._cap) return;
    const i = this._n++;
    const m = this.mesh.instanceMatrix.array;
    const o = i * 16;
    m[o] = size; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = size; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = size; m[o + 11] = 0;
    m[o + 12] = pos.x; m[o + 13] = pos.y; m[o + 14] = pos.z; m[o + 15] = 1;
    const c = this.mesh.instanceColor.array;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
  }

  flush() {
    this.mesh.count = this._n;
    // Nessuna draw call quando non c'è niente da disegnare (di giorno, in lobby).
    this.mesh.visible = this._n > 0;
    if (this._n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
    this._n = 0;
  }
}
