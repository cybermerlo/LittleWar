import * as THREE from 'three';
import { withLifeUniforms, nightRamp } from './lifeShared.js';

/**
 * Aurora polare nelle notti piene: due sipari di luce verde che sfuma nel
 * viola, uno per polo, ondulati e percorsi da raggi che scorrono.
 *
 * Geometria minima (due anelli di 192 segmenti × 2 righe): posizione,
 * ondulazione e raggi si calcolano negli shader a partire dall'angolo attorno
 * al polo e dalla quota relativa.
 *
 * È uno spettacolo delle regioni polari, non una corona sul cielo di tutto il
 * pianeta. Tre attenuazioni, tutte nel vertex/fragment shader a partire da
 * `cameraPosition` (nessun lavoro di CPU):
 *  - distanza angolare della camera dall'anello: piena entro ~7° dall'anello
 *    o dentro la calotta, spenta sotto i ~44° di latitudine. Senza, da metà
 *    pianeta l'anello intero stava sopra l'orizzonte come un'aureola;
 *  - quota della camera: sparisce dalle inquadrature d'orbita (lobby, planata
 *    d'imbarco), dove sembrava un paralume infilato su ciascun polo;
 *  - distanza del frammento dalla camera: la camera che insegue l'aereo sta a
 *    ~62 (fino a ~72 con lo zoom, ~68 in quella di morte), cioè dentro o a
 *    ridosso del sipario (62–70). Il velo additivo si spegne nelle ultime unità
 *    invece di passare davanti all'aereo come una parete verde.
 * Quando le prime due danno zero l'anello degenera fuori dal clip space
 * e non costa neppure i frammenti.
 *
 * Una draw call, solo di notte (`visible = false` altrimenti, ma compilata al
 * warmup comunque: `renderer.compile` percorre anche gli oggetti invisibili).
 * Non esiste in qualità bassa, come nebulosa e stelle.
 */

const SEGMENTS = 192;
const POLE_DISTANCE = 0.36;  // rad dal polo
const BASE_RADIUS = 62;
const TOP_RADIUS = 70;
/** Oltre l'anello (rad): piena fino a NEAR_FULL, spenta da NEAR_ZERO in là. */
const NEAR_FULL = 0.12, NEAR_ZERO = 0.45;
/** Raggio della camera (unità) oltre cui l'aurora si spegne: inquadrature d'orbita. */
const ORBIT_FULL = 78, ORBIT_ZERO = 100;

const AURORA_VERT = /* glsl */`
  attribute float aAngle;
  attribute float aH;
  attribute float aPole;
  uniform float uTime;
  varying float vAngle;
  varying float vH;
  varying float vFade;
  varying vec3 vWorld;
  void main() {
    vAngle = aAngle + aPole * 1.7;
    vH = aH;
    // Quanto la camera è vicina a QUESTO anello (ogni polo per conto suo) e
    // quanto è bassa: uguale per tutti i vertici dell'anello.
    float camR = length(cameraPosition);
    float fromPole = acos(clamp(aPole * cameraPosition.y / camR, -1.0, 1.0));
    vFade = (1.0 - smoothstep(${NEAR_FULL.toFixed(2)}, ${NEAR_ZERO.toFixed(2)}, fromPole - ${POLE_DISTANCE.toFixed(3)}))
          * (1.0 - smoothstep(${ORBIT_FULL.toFixed(1)}, ${ORBIT_ZERO.toFixed(1)}, camR));
    if (vFade < 0.002) {
      // Fuori dal clip space: nessun frammento da scartare uno per uno.
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      vWorld = vec3(0.0);
      return;
    }
    // Il sipario si piega verso l'interno e l'esterno, di più in alto.
    float th = ${POLE_DISTANCE.toFixed(3)}
      + 0.05 * sin(3.0 * aAngle + uTime * 0.15 + aPole)
      + 0.025 * sin(7.0 * aAngle - uTime * 0.23)
      + 0.02 * aH * sin(5.0 * aAngle + uTime * 0.31);
    float r = mix(${BASE_RADIUS.toFixed(1)}, ${TOP_RADIUS.toFixed(1)}, aH);
    vec3 dir = vec3(sin(th) * cos(aAngle), aPole * cos(th), sin(th) * sin(aAngle));
    vWorld = dir * r;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const AURORA_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uOpacity;
  varying float vAngle;
  varying float vH;
  varying float vFade;
  varying vec3 vWorld;
  void main() {
    float h = vH;
    // Due trame di raggi a frequenze diverse che scorrono in versi opposti:
    // una sola sarebbe un pettine regolare. Basi di pow() mai negative: il
    // seno può uscire di un soffio sotto -1 e pow(<0) è NaN, cioè un
    // quadrato nero allargato dal bloom.
    float r1 = pow(max(0.5 + 0.5 * sin(vAngle * 90.0 + 4.0 * sin(vAngle * 9.0 + uTime * 0.4)), 0.0), 2.5);
    float r2 = pow(max(0.5 + 0.5 * sin(vAngle * 53.0 - uTime * 0.9 + 3.0 * sin(vAngle * 4.0 - uTime * 0.2)), 0.0), 3.0);
    float rays = 0.3 + 0.45 * r1 + 0.45 * r2 * (0.5 + 0.5 * sin(vAngle * 6.0 + uTime * 0.25));
    // Bordo inferiore netto e luminoso, sfumatura lunga verso l'alto.
    float body = smoothstep(0.0, 0.12, h) * pow(max(1.0 - h, 0.0), 1.6);
    float hem = smoothstep(0.0, 0.04, h) * (1.0 - smoothstep(0.04, 0.2, h)) * 0.35;
    float slow = 0.6 + 0.4 * sin(vAngle * 2.0 + uTime * 0.12);
    vec3 col = mix(vec3(0.15, 1.0, 0.55), vec3(0.72, 0.32, 1.0), smoothstep(0.4, 1.0, h));
    // Niente velo quando la camera ci sta dentro o quasi.
    float nearCam = smoothstep(2.0, 9.0, distance(vWorld, cameraPosition));
    float a = (body * rays * slow + hem) * uOpacity * vFade * nearCam * 0.3;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function buildAuroraGeometry() {
  const verts = (SEGMENTS + 1) * 2 * 2;
  const pos = new Float32Array(verts * 3);   // Three.js vuole una position: la riempiamo a caso
  const angle = new Float32Array(verts);
  const h = new Float32Array(verts);
  const pole = new Float32Array(verts);
  const index = [];
  let v = 0;
  for (const p of [1, -1]) {
    const start = v;
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      for (let k = 0; k < 2; k++, v++) {
        angle[v] = a;
        h[v] = k;
        pole[v] = p;
        pos[v * 3 + 1] = p * BASE_RADIUS;
      }
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const a = start + i * 2, b = a + 2;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  geo.setAttribute('aH', new THREE.BufferAttribute(h, 1));
  geo.setAttribute('aPole', new THREE.BufferAttribute(pole, 1));
  geo.setIndex(index);
  return geo;
}

export class Aurora {
  constructor(scene) {
    this.enabled = true;
    this.uniforms = withLifeUniforms({ uOpacity: { value: 0 } }, false);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: AURORA_VERT,
      fragmentShader: AURORA_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    this.mesh = new THREE.Mesh(buildAuroraGeometry(), mat);
    this.mesh.frustumCulled = false;
    // Dopo l'atmosfera (2): l'aurora sta fuori dal suo guscio.
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.name = 'aurora';
    scene.add(this.mesh);
  }

  update(nightFactor) {
    if (!this.enabled) return;
    // Solo a notte piena: nf arriva a 1 soltanto nello stato "Notte Abissale".
    const o = nightRamp(nightFactor, 0.8, 1.0);
    this.uniforms.uOpacity.value = o;
    this.mesh.visible = o > 0.01;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.mesh.visible = false;
  }
}
