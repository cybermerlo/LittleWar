import * as THREE from 'three';
import { sampleGroundSpherical, makeSurfaceHit } from '../scene/planetSurface.js';
import { worldUniforms } from '../scene/worldShaders.js';
import {
  OBJECTIVE_TIME,
  createConformingBandGeometry,
  spawnObjectiveBurst,
  DECAL_VERT,
  DECAL_FRAG_END,
} from './ObjectiveFx.js';

/**
 * Bersaglio del bombardamento: tiro a segno a cerchi, onda "radar" e colonna
 * di fumo segnaletico.
 *
 * Prima erano due anelli opachi con depthWrite:false, disegnati nel passo
 * opaco: il mare (trasparente, renderOrder 1) passava poi il test di
 * profondità contro il fondale e li ricopriva, quindi sulla costa — cioè
 * spesso — le parti in acqua sbiadivano fin quasi a sparire. Ora sono
 * trasparenti con renderOrder dopo il mare. E da quota erano un filo rosso
 * di 5 unità: la colonna di fumo arancio sale fino alla quota di volo e si
 * vede già dall'orizzonte.
 *
 * Le mesh stanno nella scena dall'avvio (initTargetFx), così i loro shader
 * vengono compilati con gli altri; il bersaglio ne sostituisce solo le
 * geometrie.
 */

/** Raggio del tiro a segno: circa il raggio utile della bomba (BOMB_HIT_RADIUS = 3). */
const DISC_RADIUS = 3.2;
const PING_OUTER = 9.5;
const PING_PERIOD = 1.5;
const SMOKE_PUFFS = 12;
const SMOKE_PERIOD = 3.4;
const SMOKE_HEIGHT = 12.5;
const APPEAR_S = 0.55;

const DISC_FRAG = /* glsl */`
  #include <fog_pars_fragment>
  uniform float uAppear;
  uniform float uRadius;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float r = vUv.y;                        // 0 centro, 1 bordo
    if (r > uAppear) discard;
    float rr = r * uRadius;                 // unità mondo
    float aa = max(fwidth(rr), 1e-4) * 1.2;
    // Cerchi alternati rosso/bianco larghi 0.55, centro giallo.
    float s = (rr - 0.5) / 0.55;
    float k = 3.14159 * max(fwidth(s), 1e-4);
    float parity = smoothstep(-k, k, sin(3.14159 * s));
    vec3 red = vec3(0.9, 0.1, 0.07);
    vec3 white = vec3(0.98, 0.95, 0.9);
    vec3 col = mix(white, red, parity);
    float centre = 1.0 - smoothstep(0.5 - aa, 0.5, rr);
    col = mix(col, vec3(1.0, 0.8, 0.12), centre);
    // Contorni scuri: centro e bordo esterno, leggibili su sabbia e prato.
    float edge = 1.0 - smoothstep(0.05, 0.05 + aa, abs(rr - 0.5));
    edge = max(edge, smoothstep(uRadius - 0.12 - aa, uRadius - 0.12, rr));
    col = mix(col, vec3(0.12, 0.05, 0.04), edge * 0.85);
    // Il centro pulsa piano.
    col += centre * 0.18 * (0.5 + 0.5 * sin(uTime * 4.0));
    // Lampo di comparsa lungo il fronte che si srotola.
    col = mix(col, vec3(1.0), (1.0 - smoothstep(0.0, 0.12, uAppear - r)) * step(uAppear, 0.999) * 0.8);
    gl_FragColor = vec4(col, 0.95);
    ${DECAL_FRAG_END}
  }
`;

const PING_FRAG = /* glsl */`
  #include <fog_pars_fragment>
  uniform float uTime;
  uniform float uAppear;
  varying vec2 vUv;
  void main() {
    // Un'onda ogni ${PING_PERIOD.toFixed(1)} s si allarga dal bordo del bersaglio.
    float ph = fract(uTime / ${PING_PERIOD.toFixed(2)});
    float v = vUv.y;
    float aa = max(fwidth(v), 1e-4) * 1.5;
    float w = 0.035;
    float ring = 1.0 - smoothstep(w, w + aa, abs(v - ph));
    float trail = smoothstep(ph - 0.25, ph, v) * step(v, ph) * 0.25;
    float a = (ring * 0.85 + trail) * (1.0 - ph) * step(0.999, uAppear);
    gl_FragColor = vec4(vec3(1.0, 0.42, 0.3), a);
    ${DECAL_FRAG_END}
  }
`;

function decalMaterial(frag, extraUniforms) {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, extraUniforms]),
    vertexShader: DECAL_VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    extensions: { derivatives: true },
  });
  mat.uniforms.uTime = OBJECTIVE_TIME;
  return mat;
}

/**
 * Luce propria del fumo, come frazione del colore di ogni sbuffo.
 *
 * Prima il fumo era solo Lambert con un emissive fisso quasi nero: di notte
 * il sole è a 0.45 e azzurro, cioè non ha rosso da restituire a un arancio, e
 * la colonna diventava una pila di sassi bordeaux. Con metà del colore come
 * luce propria resta un segnale arancio anche al buio, e di notte (`uLit`,
 * la stessa soglia delle finestre) sale ancora un po': il grading notturno
 * tira al blu e desatura, e senza spinta l'arancio usciva color terracotta.
 * La luce propria cala verso il basso di ogni sbuffo (`uSmokeUp`, la
 * verticale del bersaglio in coordinate vista): senza, gli sbuffi erano
 * dischi piatti.
 */
const SMOKE_GLOW = 0.5;
const SMOKE_GLOW_NIGHT = 0.4;
/**
 * Sopra questa opacità uno sbuffo scrive la profondità (vedi initTargetFx).
 * A metà l'errore è lo stesso nei due sensi: un bagliore additivo dietro uno
 * sbuffo di opacità a manca per (1 − a) se lo sbuffo scrive la profondità,
 * avanza per a se non la scrive.
 */
const SMOKE_SOLID = 0.5;

const SMOKE_ALPHA_VERT = 'attribute float aAlpha;\nvarying float vAlpha;';

/**
 * Lambert + luce propria dal colore d'istanza + opacità per istanza
 * (`aAlpha`): gli sbuffi in cima si allargano e si dissolvono invece di
 * rimpicciolire fino a sembrare sassi.
 */
function patchSmokeMaterial(mat, upView) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSmokeUp = upView;
    shader.uniforms.uLit = worldUniforms.uLit;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SMOKE_ALPHA_VERT}`)
      .replace('#include <color_vertex>', '#include <color_vertex>\n  vAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSmokeUp;\nuniform float uLit;\nvarying float vAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vAlpha;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += vColor * ((${SMOKE_GLOW.toFixed(2)} + ${SMOKE_GLOW_NIGHT.toFixed(2)} * uLit)
    * (0.72 + 0.28 * dot(normal, uSmokeUp)));`);
  };
  mat.customProgramCacheKey = () => 'lw-target-smoke';
  return mat;
}

/** Solo profondità, e solo dove lo sbuffo è ancora denso. */
function smokeDepthMaterial() {
  const mat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    // Un filo più in là del passo a colori, che deve passare il test (LessEqual).
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SMOKE_ALPHA_VERT}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n  if (vAlpha < ${SMOKE_SOLID.toFixed(2)}) discard;`);
  };
  mat.customProgramCacheKey = () => 'lw-target-smoke-depth';
  return mat;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
// Arancio saturo: con la luce propria e ACES un rosso-arancio più chiaro
// (come il vecchio 1.7/0.62/0.16) usciva color pesca. In cima schiarisce
// verso il crema, mentre si dissolve.
const _smokeHot = new THREE.Color(1.25, 0.2, 0.02);
const _smokeCool = new THREE.Color(1.15, 0.62, 0.32);

// Stato per sbuffo, riusato a ogni frame (niente allocazioni).
const _puffPos = Array.from({ length: SMOKE_PUFFS }, () => new THREE.Vector3());
const _puffSize = new Float32Array(SMOKE_PUFFS);
const _puffAge = new Float32Array(SMOKE_PUFFS);
const _puffDist = new Float32Array(SMOKE_PUFFS);
const _order = new Uint8Array(SMOKE_PUFFS);
/** Camera del frame precedente (onBeforeRender): serve a ordinare gli sbuffi. */
const _camPos = new THREE.Vector3();
/** Verticale del bersaglio corrente, in coordinate mondo. */
const _smokeUp = new THREE.Vector3(0, 1, 0);

let _fx = null;

/** Crea le mesh del bersaglio (nascoste) e le aggiunge alla scena. Una volta, all'avvio. */
export function initTargetFx(scene) {
  if (_fx) return;
  const empty = new THREE.BufferGeometry();
  empty.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  empty.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));

  const discMat = decalMaterial(DISC_FRAG, {
    uAppear: { value: 1 },
    uRadius: { value: DISC_RADIUS },
    uTime: { value: 0 },
  });
  const pingMat = decalMaterial(PING_FRAG, { uTime: { value: 0 }, uAppear: { value: 1 } });
  pingMat.uniforms.uAppear = discMat.uniforms.uAppear;

  const disc = new THREE.Mesh(empty, discMat);
  const ping = new THREE.Mesh(empty, pingMat);
  for (const m of [disc, ping]) {
    // Dopo il mare (renderOrder 1): è ciò che lo faceva sparire sulla costa.
    m.renderOrder = 1.2;
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    m.visible = false;
    scene.add(m);
  }

  // Fumo segnaletico: sbuffi densi alla base che salgono, si allargano, si
  // piegano col vento e in cima si dissolvono. Arancio acceso e salita
  // continua: non si confonde col fumo grigio delle esplosioni. Anche in
  // qualità bassa restano tutti: con pochi la colonna si sgranava in sassi
  // volanti, e dodici sbuffi costano la stessa, unica draw call.
  // Icosaedri suddivisi una volta, come le nuvole: quelli a 20 facce, pieni e
  // sfaccettati, sembravano pietre.
  const puffs = SMOKE_PUFFS;
  const puffGeo = new THREE.IcosahedronGeometry(1, 1);
  const alpha = new THREE.InstancedBufferAttribute(new Float32Array(puffs), 1);
  alpha.setUsage(THREE.DynamicDrawUsage);
  puffGeo.setAttribute('aAlpha', alpha);
  const upView = { value: new THREE.Vector3(0, 1, 0) };
  const smoke = new THREE.InstancedMesh(
    puffGeo,
    patchSmokeMaterial(new THREE.MeshLambertMaterial({
      color: 0xffffff, flatShading: true, transparent: true, depthWrite: false,
    }), upView),
    puffs,
  );
  smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  smoke.setColorAt(0, _smokeHot);
  smoke.frustumCulled = false;
  smoke.visible = false;
  // Trasparente, dopo il mare (1) e i segni a terra (1.2–1.3). Fra loro gli
  // sbuffi li ordina tick(), dal più lontano, con la camera presa qui.
  smoke.renderOrder = 1.9;
  smoke.onBeforeRender = (renderer, scn, camera) => {
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    upView.value.copy(_smokeUp).transformDirection(camera.matrixWorldInverse);
  };
  scene.add(smoke);

  // La parte densa scrive anche la profondità, con una seconda draw call nel
  // passo opaco (stesse istanze, niente colore). Senza, tutto ciò che è
  // trasparente e viene disegnato dopo — aurora, fasci dei fari, bagliori —
  // gli finiva sopra anche da dietro; e scrivere la profondità anche della
  // cima che si dissolve avrebbe bucato quelle stesse cose con la sagoma di
  // uno sbuffo quasi invisibile.
  const smokeDepth = new THREE.InstancedMesh(puffGeo, smokeDepthMaterial(), puffs);
  smokeDepth.instanceMatrix = smoke.instanceMatrix;
  smokeDepth.frustumCulled = false;
  smokeDepth.visible = false;
  scene.add(smokeDepth);

  _fx = { disc, ping, smoke, smokeDepth, alpha, discMat, pingMat, empty, puffs };
}

/**
 * Bersaglio corrente. L'interfaccia è quella di prima (costruttore, tick,
 * dispose): main.js ne crea uno nuovo a ogni `new-target`.
 */
export class TargetEntity {
  constructor(scene, theta, phi) {
    this.theta = theta;
    this.phi = phi;
    this._scene = scene;
    this._t = 0;
    this._last = performance.now();
    if (!_fx) initTargetFx(scene);

    const hit = sampleGroundSpherical(theta, phi, makeSurfaceHit());
    this._dir = hit.point.clone().normalize();
    this._ground = hit.point.clone();
    this._side = new THREE.Vector3(Math.abs(this._dir.y) < 0.9 ? 0 : 1, Math.abs(this._dir.y) < 0.9 ? 1 : 0, 0)
      .cross(this._dir).normalize();
    this._wind = Math.random() * Math.PI * 2;
    _smokeUp.copy(this._dir);

    this._discGeo = createConformingBandGeometry(this._dir, 0, DISC_RADIUS, { segments: 48, rings: 6, lift: 0.16 });
    this._pingGeo = createConformingBandGeometry(this._dir, DISC_RADIUS, PING_OUTER, { segments: 64, rings: 6, lift: 0.15 });
    _fx.disc.geometry = this._discGeo;
    _fx.ping.geometry = this._pingGeo;
    _fx.disc.visible = true;
    _fx.ping.visible = true;
    _fx.smoke.visible = true;
    _fx.smokeDepth.visible = true;
    _fx.discMat.uniforms.uAppear.value = 0;
    this._alive = true;
  }

  /** Chiamato a ogni frame da main.js (senza delta: il tempo lo misura da sé). */
  tick() {
    if (!this._alive) return;
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    this._t += dt;

    // Si srotola dal centro.
    const k = Math.min(1, this._t / APPEAR_S);
    _fx.discMat.uniforms.uAppear.value = k >= 1 ? 1 : 1 - Math.pow(1 - k, 3);

    const smoke = _fx.smoke;
    const n = _fx.puffs;
    const grow = Math.min(1, this._t / 1.2);
    const smoothstep = THREE.MathUtils.smoothstep;
    for (let i = 0; i < n; i++) {
      const age = (this._t / SMOKE_PERIOD + i / n) % 1;
      // Sale svelto e rallenta in cima, dove il vento lo piega di lato.
      const h = 0.4 + age * (1.25 - 0.25 * age) * SMOKE_HEIGHT * grow;
      const sway = Math.sin(age * 4 + i * 1.7 + this._wind) * 0.35 * age;
      _puffPos[i].copy(this._ground).addScaledVector(this._dir, h)
        .addScaledVector(this._side, sway + age * age * 2.4);
      _puffSize[i] = (0.9 + age * 1.65) * smoothstep(age, 0, 0.05) * grow;
      _puffAge[i] = age;
      _puffDist[i] = _puffPos[i].distanceToSquared(_camPos);
      // Inserimento: dal più lontano al più vicino (sono dodici).
      let j = i;
      while (j > 0 && _puffDist[_order[j - 1]] < _puffDist[i]) {
        _order[j] = _order[j - 1];
        j--;
      }
      _order[j] = i;
    }
    // Nell'ordine di disegno: senza scrittura di profondità uno sbuffo
    // lontano disegnato dopo coprirebbe quello davanti.
    for (let j = 0; j < n; j++) {
      const i = _order[j];
      const age = _puffAge[i];
      _s.setScalar(Math.max(0.001, _puffSize[i]));
      _q.setFromAxisAngle(this._dir, i * 1.3 + this._t * 0.6);
      _m.compose(_puffPos[i], _q, _s);
      smoke.setMatrixAt(j, _m);
      smoke.setColorAt(j, _c.copy(_smokeHot).lerp(_smokeCool, smoothstep(age, 0.15, 0.9)));
      // Denso fino a metà salita, poi si dissolve mentre si allarga.
      _fx.alpha.setX(j, 1 - smoothstep(age, 0.42, 0.97));
    }
    smoke.instanceMatrix.needsUpdate = true;
    smoke.instanceColor.needsUpdate = true;
    _fx.alpha.needsUpdate = true;
  }

  /** Coriandoli bianchi e rossi quando una bomba lo centra. */
  burst() {
    _p.copy(this._ground).addScaledVector(this._dir, 0.8);
    spawnObjectiveBurst(_p, ['#ffffff', '#e8261c', '#ffd23f', '#ffffff'], {
      count: 28, speed: 8, ringSize: 10, ringColor: _c.setRGB(1, 0.45, 0.3),
    });
  }

  dispose() {
    this._alive = false;
    if (_fx && _fx.disc.geometry === this._discGeo) {
      _fx.disc.geometry = _fx.empty;
      _fx.ping.geometry = _fx.empty;
      _fx.disc.visible = false;
      _fx.ping.visible = false;
      _fx.smoke.visible = false;
      _fx.smokeDepth.visible = false;
    }
    this._discGeo.dispose();
    this._pingGeo.dispose();
  }
}
