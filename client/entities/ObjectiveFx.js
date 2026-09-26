import * as THREE from 'three';
import { sampleGround, makeSurfaceHit, SEA_SURFACE_RADIUS } from '../scene/planetSurface.js';

/**
 * Effetti condivisi dagli obiettivi di gioco (powerup, torrette, bersaglio,
 * bombe): tutto in poche InstancedMesh create una volta sola all'avvio.
 *
 * - aloni     billboard morbidi o anelli (powerup, beacon delle torrette, lampi
 *             delle raccolte) — 1 draw call
 * - segmenti  nastri rivolti alla camera fra due punti: colonne di luce dei
 *             powerup, laser di puntamento delle torrette, scie delle bombe
 *             — 1 draw call
 * - segni a terra  punto d'impatto delle bombe e mirino di sgancio — 1 draw call
 * - coriandoli     scoppi di raccolta e di conquista — 1 draw call
 *
 * Funzionano "a modalità immediata", come PlaneShadows: chi vuole un'istanza
 * la aggiunge a ogni frame, e `endObjectiveFx()` chiude il frame. Niente slot
 * da prenotare e liberare, quindi niente istanze orfane se un'entità sparisce
 * senza passare da dispose.
 *
 * Perché stanno qui e non dentro le entità: i materiali devono esistere nella
 * scena prima della pre-compilazione degli shader. Un materiale nato con il
 * primo powerup, o alla prima conquista, veniva compilato proprio in quel
 * momento (è lo scatto che si sentiva alla prima torretta conquistata).
 */

// ── Tempo condiviso ───────────────────────────────────────────────────────────

/** Uniform `uTime` condivisa per riferimento da tutti i materiali degli obiettivi. */
export const OBJECTIVE_TIME = { value: 0 };

/** Nessuna PointLight, nessuna texture: in qualità bassa si toglie solo il superfluo. */
let _low = false;
export function isObjectiveLowQuality() { return _low; }

// ── Colori ────────────────────────────────────────────────────────────────────

const _white = new THREE.Color(1, 1, 1);

/**
 * Colore di un effetto luminoso a partire dal colore di un giocatore. Nero e
 * marrone sono colori validi in lobby: senza schiarirli un alone o un laser
 * del giocatore nero sarebbe invisibile di notte.
 */
export function glowColorFor(color, out, boost = 1) {
  out.set(color ?? '#ffd36b');
  const lum = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  if (lum < 0.35) out.lerp(_white, 0.35 - lum + 0.15);
  return out.multiplyScalar(boost);
}

// Blending "premoltiplicato": src·1 + dst·(1 − αsrc). Con α = 0 è additivo
// puro (bagliore notturno), con α = copertura è una normale sovrapposizione
// (leggibile anche su un cielo di mezzogiorno, dove l'additivo sparisce).
// Così una sola draw call copre entrambi i casi, istanza per istanza.
function premultipliedBlend(mat) {
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.transparent = true;
  mat.depthWrite = false;
  return mat;
}

const OUTPUT_CHUNKS = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

// ── Aloni ─────────────────────────────────────────────────────────────────────

const GLOW_CAPACITY = 48;

const GLOW_VERT = /* glsl */`
  attribute vec3 aGlow;          // x: spessore anello (0 = alone), y: dimensione minima (px), z: copertura
  uniform float uPxAngle;        // angolo di un pixel (rad) alla risoluzione corrente
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vGlow;
  void main() {
    vUv = uv;
    vColor = instanceColor;
    vGlow = aGlow;
    vec4 mv = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
    float size = length(instanceMatrix[0].xyz);
    // Da lontano un alone di un'unità diventerebbe un paio di pixel: sotto
    // la soglia si tiene costante la dimensione sullo schermo.
    size = max(size, -mv.z * aGlow.y * uPxAngle);
    // Avvicinato alla camera di mezza dimensione: non si taglia contro la
    // mesh che avvolge (torretta, modello del powerup).
    mv.xyz += normalize(-mv.xyz) * min(size * 0.5, -mv.z * 0.5);
    mv.xy += position.xy * size;
    gl_Position = projectionMatrix * mv;
  }
`;

const GLOW_FRAG = /* glsl */`
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vGlow;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    float a;
    if (vGlow.x > 0.0) {
      float w = vGlow.x;
      a = smoothstep(1.0, 1.0 - w * 0.35, d) * smoothstep(1.0 - w, 1.0 - w * 0.55, d);
    } else {
      float halo = exp(-d * d * 4.5);
      float core = exp(-d * d * 42.0);
      a = (halo * 0.62 + core) * (1.0 - smoothstep(0.82, 1.0, d));
    }
    gl_FragColor = vec4(vColor * a, a * vGlow.z);
    ${OUTPUT_CHUNKS}
  }
`;

class GlowBatch {
  constructor(root) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(GLOW_CAPACITY * 3), 3);
    this.params.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGlow', this.params);
    this.material = premultipliedBlend(new THREE.ShaderMaterial({
      uniforms: { uPxAngle: { value: 0.0016 } },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
    }));
    this.mesh = new THREE.InstancedMesh(geo, this.material, GLOW_CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _white); // crea instanceColor prima della compilazione
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.count = 0;
    this.mesh.visible = false;
    root.add(this.mesh);
    this.n = 0;
    this._flush = false;
  }

  /**
   * @param {THREE.Vector3} pos
   * @param {number} size       diametro (unità mondo)
   * @param {THREE.Color} color già moltiplicato per l'intensità
   * @param {number} [ring]     0 = alone morbido, >0 = anello di quello spessore (0..1)
   * @param {number} [minPx]    diametro minimo sullo schermo
   * @param {number} [cover]    0 = additivo, 1 = copre lo sfondo
   */
  add(pos, size, color, ring = 0, minPx = 0, cover = 0) {
    if (this._flush) { this.n = 0; this._flush = false; }
    if (this.n >= GLOW_CAPACITY) return;
    const i = this.n++;
    const e = this.mesh.instanceMatrix.array;
    const o = i * 16;
    e[o] = size; e[o + 1] = 0; e[o + 2] = 0; e[o + 3] = 0;
    e[o + 4] = 0; e[o + 5] = size; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = 0; e[o + 9] = 0; e[o + 10] = size; e[o + 11] = 0;
    e[o + 12] = pos.x; e[o + 13] = pos.y; e[o + 14] = pos.z; e[o + 15] = 1;
    this.mesh.setColorAt(i, color);
    const p = this.params.array;
    p[i * 3] = ring; p[i * 3 + 1] = minPx; p[i * 3 + 2] = cover;
  }

  end(pxAngle) {
    if (this._flush) this.n = 0;
    this.material.uniforms.uPxAngle.value = pxAngle;
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      this.params.needsUpdate = true;
    }
    this._flush = true;
  }
}

// ── Segmenti: colonne di luce, laser, scie ────────────────────────────────────

const SEGMENT_CAPACITY = 48;

export const SEG_BEAM = 0;
export const SEG_LASER = 1;
export const SEG_TRAIL = 2;

// L'instanceMatrix non contiene una trasformazione ma i dati del segmento
// (Three non la interpreta: frustumCulled è spento e non si fa raycasting):
//   colonna 3 = punto di partenza, colonna 0 = vettore fino all'arrivo,
//   colonna 1 = larghezza, stile, parametro (carica del laser), copertura.
const SEG_VERT = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vLen;
  varying float vStyle;
  varying float vParam;
  varying float vCover;
  varying float vNear;
  void main() {
    vec3 A = instanceMatrix[3].xyz;
    vec3 D = instanceMatrix[0].xyz;
    float len = max(length(D), 1e-4);
    vec3 dir = D / len;
    float width = instanceMatrix[1].x;
    vec3 P = A + D * position.y;
    vec3 side = cross(dir, cameraPosition - P);
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : vec3(0.0);
    P += side * (position.x * width);
    vUv = uv;
    vColor = instanceColor;
    vLen = len;
    vStyle = instanceMatrix[1].y;
    vParam = instanceMatrix[1].z;
    vCover = instanceMatrix[1].w;
    // Distanza della camera dall'asse: una colonna attraversata in volo non
    // deve riempire lo schermo di colore.
    vNear = length(cross(cameraPosition - A, dir));
    gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
  }
`;

const SEG_FRAG = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vLen;
  varying float vStyle;
  varying float vParam;
  varying float vCover;
  varying float vNear;
  void main() {
    float x = abs(vUv.x * 2.0 - 1.0);
    float y = vUv.y;
    vec3 col = vColor;
    float a;
    if (vStyle < 0.5) {
      // Colonna di luce: nucleo chiaro, sfuma salendo, bande che scorrono verso l'alto.
      float core = pow(1.0 - x, 3.0);
      float body = 1.0 - x * x;
      float fadeUp = pow(1.0 - y, 1.15);
      float foot = smoothstep(0.0, 0.025, y);
      float bands = 0.78 + 0.22 * sin((y * vLen * 0.55 - uTime * 1.3) * 6.2832);
      a = (body * 0.34 + core * 0.66) * fadeUp * foot * bands;
      a *= smoothstep(1.2, 5.0, vNear);
      col = mix(vColor, vec3(1.0), core * 0.45);
    } else if (vStyle < 1.5) {
      // Laser di puntamento: tratteggio che scorre verso il bersaglio e si
      // chiude in una linea piena nell'ultimo quarto della carica.
      float charge = vParam;
      float core = 1.0 - smoothstep(0.1, 0.9, x);
      float dash = smoothstep(0.35, 0.45, fract(y * vLen * 0.7 - uTime * 2.6));
      float solid = smoothstep(0.72, 0.95, charge);
      a = core * mix(dash, 1.0, solid) * (0.3 + 0.7 * charge * charge);
      col = mix(vColor, vec3(1.0), core * charge * 0.55) * (1.0 + charge * 0.9);
    } else {
      // Scia: si spegne verso la coda.
      float core = 1.0 - smoothstep(0.0, 1.0, x);
      a = core * pow(1.0 - y, 1.6) * 0.7;
    }
    gl_FragColor = vec4(col * a, a * vCover);
    ${OUTPUT_CHUNKS}
  }
`;

class SegmentBatch {
  constructor(root) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    this.material = premultipliedBlend(new THREE.ShaderMaterial({
      uniforms: { uTime: OBJECTIVE_TIME },
      vertexShader: SEG_VERT,
      fragmentShader: SEG_FRAG,
      side: THREE.DoubleSide,
    }));
    this.mesh = new THREE.InstancedMesh(geo, this.material, SEGMENT_CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _white);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.count = 0;
    this.mesh.visible = false;
    root.add(this.mesh);
    this.n = 0;
    this._flush = false;
  }

  /**
   * @param {THREE.Vector3} a  partenza
   * @param {THREE.Vector3} b  arrivo
   * @param {number} width
   * @param {THREE.Color} color
   * @param {number} style     SEG_BEAM | SEG_LASER | SEG_TRAIL
   * @param {number} [param]   carica del laser (0..1)
   * @param {number} [cover]   0 = additivo, 1 = copre
   */
  add(a, b, width, color, style, param = 0, cover = 0.5) {
    if (this._flush) { this.n = 0; this._flush = false; }
    if (this.n >= SEGMENT_CAPACITY) return;
    const i = this.n++;
    const e = this.mesh.instanceMatrix.array;
    const o = i * 16;
    e[o] = b.x - a.x; e[o + 1] = b.y - a.y; e[o + 2] = b.z - a.z; e[o + 3] = 0;
    e[o + 4] = width; e[o + 5] = style; e[o + 6] = param; e[o + 7] = cover;
    e[o + 8] = 0; e[o + 9] = 0; e[o + 10] = 0; e[o + 11] = 0;
    e[o + 12] = a.x; e[o + 13] = a.y; e[o + 14] = a.z; e[o + 15] = 1;
    this.mesh.setColorAt(i, color);
  }

  end() {
    if (this._flush) this.n = 0;
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
    this._flush = true;
  }
}

// ── Segni a terra: punto d'impatto e mirino ───────────────────────────────────

const MARKER_CAPACITY = 20;
export const MARK_IMPACT = 0;
export const MARK_RETICLE = 1;

const MARK_VERT = /* glsl */`
  #include <fog_pars_vertex>
  attribute vec2 aMark;          // x: stile, y: parametro (fase / intensità dell'impulso)
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec2 vMark;
  void main() {
    vUv = uv;
    vColor = instanceColor;
    vMark = aMark;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const MARK_FRAG = /* glsl */`
  #include <fog_pars_fragment>
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec2 vMark;

  // Linea antialiasata di mezza larghezza w attorno a dist = 0.
  float line(float dist, float w, float aa) {
    return 1.0 - smoothstep(w, w + aa, abs(dist));
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    float aa = fwidth(d) * 1.5;
    float core;
    float halo;
    if (vMark.x < 0.5) {
      // Punto d'impatto: cerchio fisso più un anello che si stringe.
      float ph = fract(uTime * 1.8 + vMark.y);
      float r = 0.88 - 0.62 * ph;
      core = max(line(d - 0.86, 0.06, aa), line(d - r, 0.05, aa) * (1.0 - ph * 0.7));
      core = max(core, 1.0 - smoothstep(0.14, 0.14 + aa, d));
      halo = max(line(d - 0.86, 0.13, aa), 1.0 - smoothstep(0.22, 0.22 + aa, d)) * 0.45;
    } else {
      // Mirino: anello sul raggio utile della bomba, quattro tacche e un
      // puntino centrale. vMark.y = quanto è "agganciato" (0..1).
      float lock = vMark.y;
      float ring = line(d - 0.95, 0.028, aa);
      float ticksMask = step(0.62, d) * (1.0 - step(0.9, d));
      float ax = min(abs(p.x), abs(p.y));
      float ticks = line(ax, 0.026, fwidth(ax) * 1.5) * ticksMask;
      float dot = 1.0 - smoothstep(0.055, 0.055 + aa, d);
      core = max(max(ring, ticks), dot);
      halo = max(line(d - 0.95, 0.07, aa), line(ax, 0.07, fwidth(ax) * 1.5) * ticksMask) * 0.5;
      float pulse = 0.5 + 0.5 * sin(uTime * 12.0);
      halo += (1.0 - smoothstep(0.9, 0.95, d)) * lock * (0.1 + 0.08 * pulse);
    }
    // Contorno scuro sotto il tratto chiaro: si legge anche su sabbia e neve.
    vec3 col = mix(vec3(0.03, 0.04, 0.06), vColor, core);
    float a = max(core, halo);
    gl_FragColor = vec4(col, a * 0.95);
    ${OUTPUT_CHUNKS}
    #include <fog_fragment>
  }
`;

const _mHit = makeSurfaceHit();
const _mDir = new THREE.Vector3();
const _mPos = new THREE.Vector3();
const _mNormal = new THREE.Vector3();
const _mQuat = new THREE.Quaternion();
const _mScale = new THREE.Vector3();
const _mMat = new THREE.Matrix4();
const _zAxis = new THREE.Vector3(0, 0, 1);

class MarkerBatch {
  constructor(root) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(MARKER_CAPACITY * 2), 2);
    this.params.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aMark', this.params);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: MARK_VERT,
      fragmentShader: MARK_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      extensions: { derivatives: true },
    });
    this.material.uniforms.uTime = OBJECTIVE_TIME;
    this.mesh = new THREE.InstancedMesh(geo, this.material, MARKER_CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _white);
    this.mesh.frustumCulled = false;
    // Dopo il mare (1), che altrimenti lo coprirebbe dove il segno cade in acqua.
    this.mesh.renderOrder = 1.3;
    this.mesh.count = 0;
    this.mesh.visible = false;
    root.add(this.mesh);
    this.n = 0;
    this._flush = false;
  }

  /**
   * Segno appoggiato sulla superficie visibile lungo la direzione `dir`:
   * terra emersa (faccia vera, via sampleGround) oppure pelo dell'acqua.
   */
  add(dir, size, color, style, param = 0) {
    if (this._flush) { this.n = 0; this._flush = false; }
    if (this.n >= MARKER_CAPACITY) return;
    _mDir.copy(dir).normalize();
    sampleGround(_mDir, _mHit);
    let r = _mHit.radius;
    _mNormal.copy(_mHit.normal);
    if (r < SEA_SURFACE_RADIUS) { r = SEA_SURFACE_RADIUS; _mNormal.copy(_mDir); }
    // Il mirino è largo 6 unità: sulle facce inclinate lo si alza un po' di
    // più, così non si pianta nel pendio accanto.
    const lift = 0.1 + (1 - _mNormal.dot(_mDir)) * size * 0.5;
    _mPos.copy(_mDir).multiplyScalar(r).addScaledVector(_mNormal, lift);
    _mQuat.setFromUnitVectors(_zAxis, _mNormal);
    _mScale.set(size, size, 1);
    _mMat.compose(_mPos, _mQuat, _mScale);
    const i = this.n++;
    this.mesh.setMatrixAt(i, _mMat);
    this.mesh.setColorAt(i, color);
    this.params.array[i * 2] = style;
    this.params.array[i * 2 + 1] = param;
  }

  end() {
    if (this._flush) this.n = 0;
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      this.params.needsUpdate = true;
    }
    this._flush = true;
  }
}

// ── Scoppi: anello di luce e coriandoli ───────────────────────────────────────

const BURST_SLOTS = 5;
const BURST_MAX_PARTICLES = 28;
const BURST_DURATION = 1.25;
const BURST_GRAVITY = 9;

const _bColor = new THREE.Color();
const _bPos = new THREE.Vector3();
const _bQuat = new THREE.Quaternion();
const _bScale = new THREE.Vector3();
const _bMat = new THREE.Matrix4();
const _bAxis = new THREE.Vector3();

class BurstPool {
  constructor(root) {
    // Coriandolo: un rettangolino piatto a due facce, opaco (niente
    // ordinamento dei trasparenti), che si rimpicciolisce invece di sfumare.
    const geo = new THREE.PlaneGeometry(0.26, 0.16);
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.capacity = BURST_SLOTS * BURST_MAX_PARTICLES;
    this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _white);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    root.add(this.mesh);

    this.slots = Array.from({ length: BURST_SLOTS }, () => ({
      t: BURST_DURATION,
      pos: new THREE.Vector3(),
      up: new THREE.Vector3(),
      count: 0,
      ringSize: 0,
      ringColor: new THREE.Color(),
      vel: Array.from({ length: BURST_MAX_PARTICLES }, () => new THREE.Vector3()),
      axis: Array.from({ length: BURST_MAX_PARTICLES }, () => new THREE.Vector3()),
      spin: new Float32Array(BURST_MAX_PARTICLES),
      colors: Array.from({ length: BURST_MAX_PARTICLES }, () => new THREE.Color()),
    }));
    this.next = 0;
  }

  /**
   * @param {THREE.Vector3} pos
   * @param {Array<THREE.Color|string|number>} palette  colori dei coriandoli
   * @param {object} [o]
   * @param {number} [o.count]     coriandoli (≤ 28)
   * @param {number} [o.speed]     velocità iniziale (unità/s)
   * @param {number} [o.ringSize]  diametro finale dell'anello di luce (0 = niente)
   * @param {THREE.Color} [o.ringColor]
   */
  spawn(pos, palette, o = {}) {
    const s = this.slots[this.next % BURST_SLOTS];
    this.next++;
    s.t = 0;
    s.pos.copy(pos);
    s.up.copy(pos).normalize();
    const want = o.count ?? 16;
    s.count = Math.min(BURST_MAX_PARTICLES, _low ? Math.ceil(want * 0.5) : want);
    s.ringSize = o.ringSize ?? 0;
    if (o.ringColor) s.ringColor.copy(o.ringColor); else s.ringColor.setRGB(1, 1, 1);
    const speed = o.speed ?? 6;
    for (let i = 0; i < s.count; i++) {
      const v = s.vel[i];
      v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      v.addScaledVector(s.up, 1.1).normalize().multiplyScalar(speed * (0.55 + Math.random() * 0.6));
      s.axis[i].set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      s.spin[i] = 6 + Math.random() * 10;
      s.colors[i].set(palette[i % palette.length]);
    }
  }

  tick(dt, glows) {
    let n = 0;
    for (const s of this.slots) {
      if (s.t >= BURST_DURATION) continue;
      s.t += dt;
      const t = s.t;
      if (t >= BURST_DURATION) continue;

      if (s.ringSize > 0 && t < 0.42) {
        const k = t / 0.42;
        const e = 1 - (1 - k) * (1 - k);
        _bColor.copy(s.ringColor).multiplyScalar(1.6 * (1 - k));
        glows.add(s.pos, s.ringSize * (0.25 + 0.75 * e), _bColor, 0.22, 0, 0.35);
        if (k < 0.5) {
          _bColor.copy(s.ringColor).multiplyScalar(2 * (1 - k * 2));
          glows.add(s.pos, s.ringSize * 0.6, _bColor, 0, 0, 0);
        }
      }

      const life = t / BURST_DURATION;
      const shrink = 1 - THREE.MathUtils.smoothstep(life, 0.6, 1);
      for (let i = 0; i < s.count && n < this.capacity; i++) {
        const v = s.vel[i];
        // Moto balistico verso il centro del pianeta, con un po' di attrito:
        // i coriandoli si aprono e poi planano.
        const drag = Math.exp(-2.2 * t);
        _bPos.copy(v).multiplyScalar((1 - drag) / 2.2)
          .addScaledVector(s.up, -0.5 * BURST_GRAVITY * 0.35 * t * t)
          .add(s.pos);
        _bQuat.setFromAxisAngle(_bAxis.copy(s.axis[i]), s.spin[i] * t);
        _bScale.setScalar(Math.max(0.001, shrink));
        _bMat.compose(_bPos, _bQuat, _bScale);
        this.mesh.setMatrixAt(n, _bMat);
        this.mesh.setColorAt(n, s.colors[i]);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

// ── Geometria: fascia conformata al terreno, con coordinate UV ────────────────

/**
 * Fascia circolare (o disco, con `innerRadius = 0`) che segue la superficie
 * visibile, con uv: u lungo la circonferenza (0..1, cucitura duplicata),
 * v dal bordo interno (0) a quello esterno (1). I vertici sono in coordinate
 * world.
 *
 * Come `createConformingRingGeometry` di planetSurface.js, ma con le uv che
 * servono agli shader degli obiettivi e più anelli radiali, così una fascia
 * larga segue le facce del terreno invece di tagliarle con una corda.
 * Il raggio si misura sul piano tangente: l'angolo al centro del pianeta è
 * atan(raggio / |centro|).
 *
 * @param {THREE.Vector3} centerDir
 * @param {number} innerRadius
 * @param {number} outerRadius
 * @param {object} [o]
 * @param {number} [o.segments]
 * @param {number} [o.rings]    suddivisioni radiali
 * @param {number} [o.lift]     sollevamento lungo la normale
 */
export function createConformingBandGeometry(centerDir, innerRadius, outerRadius, o = {}) {
  const segments = o.segments ?? 72;
  const rings = Math.max(1, o.rings ?? 1);
  const lift = o.lift ?? 0.14;
  const dir = centerDir.clone().normalize();
  const ref = new THREE.Vector3(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0);
  const tu = new THREE.Vector3().crossVectors(dir, ref).normalize();
  const tv = new THREE.Vector3().crossVectors(dir, tu).normalize();
  const hit = makeSurfaceHit();
  const probe = new THREE.Vector3();
  const center = sampleGround(dir, hit).point.clone();

  const cols = segments + 1;
  const rows = rings + 1;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const indices = new Uint16Array(segments * rings * 6);

  for (let s = 0; s < cols; s++) {
    // Verso orario visto da fuori: le barre di progresso girano come un orologio.
    const a = -(s / segments) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let r = 0; r < rows; r++) {
      const k = r / rings;
      const radius = innerRadius + (outerRadius - innerRadius) * k;
      probe.copy(center).addScaledVector(tu, ca * radius).addScaledVector(tv, sa * radius).normalize();
      sampleGround(probe, hit);
      // Dove il terreno scende sotto il mare la fascia resta sul pelo dell'acqua.
      if (hit.radius < SEA_SURFACE_RADIUS) {
        hit.point.copy(probe).multiplyScalar(SEA_SURFACE_RADIUS);
        hit.normal.copy(probe);
      }
      const vi = s * rows + r;
      positions[vi * 3] = hit.point.x + hit.normal.x * lift;
      positions[vi * 3 + 1] = hit.point.y + hit.normal.y * lift;
      positions[vi * 3 + 2] = hit.point.z + hit.normal.z * lift;
      uvs[vi * 2] = s / segments;
      uvs[vi * 2 + 1] = k;
    }
  }

  let o6 = 0;
  for (let s = 0; s < segments; s++) {
    for (let r = 0; r < rings; r++) {
      const a0 = s * rows + r;
      const a1 = a0 + 1;
      const b0 = (s + 1) * rows + r;
      const b1 = b0 + 1;
      indices[o6++] = a0; indices[o6++] = b0; indices[o6++] = a1;
      indices[o6++] = a1; indices[o6++] = b0; indices[o6++] = b1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

/** Shader delle decalcomanie a terra: vertex comune con nebbia. */
export const DECAL_VERT = /* glsl */`
  #include <fog_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

/** Chiusura comune dei fragment shader degli obiettivi (tone mapping, sRGB, nebbia). */
export const DECAL_FRAG_END = /* glsl */`
  ${OUTPUT_CHUNKS}
  #include <fog_fragment>
`;

// ── Sistema ───────────────────────────────────────────────────────────────────

let _root = null;
export let glows = null;
export let segments = null;
export let markers = null;
let _bursts = null;

/**
 * Crea tutte le InstancedMesh degli effetti e le aggiunge alla scena.
 * Da chiamare all'avvio, insieme a initExplosionPool / initTurretEffects,
 * prima della pre-compilazione degli shader.
 */
export function initObjectiveFx(scene, { lowQuality = false } = {}) {
  if (_root) return _root;
  _low = lowQuality;
  _root = new THREE.Group();
  _root.name = 'objective-fx';
  glows = new GlowBatch(_root);
  segments = new SegmentBatch(_root);
  markers = new MarkerBatch(_root);
  _bursts = new BurstPool(_root);
  scene.add(_root);
  return _root;
}

/** Radice degli effetti (per la pre-compilazione mirata). */
export function objectiveFxRoot() { return _root; }

/** Scoppio di coriandoli (e anello di luce). Vedi BurstPool.spawn. */
export function spawnObjectiveBurst(pos, palette, opts) {
  _bursts?.spawn(pos, palette, opts);
}

/** Avanza il tempo condiviso degli shader. Una volta per frame, prima degli add(). */
export function tickObjectiveTime(delta) {
  OBJECTIVE_TIME.value = (OBJECTIVE_TIME.value + Math.min(delta, 0.1)) % 3600;
}

/**
 * Chiude il frame degli effetti: coriandoli, poi conteggi e upload delle
 * istanze aggiunte in questo frame.
 */
export function endObjectiveFx(delta, camera) {
  if (!_root) return;
  _bursts.tick(Math.min(delta, 0.05), glows);
  const h = typeof window !== 'undefined' ? window.innerHeight : 720;
  const pxAngle = 2 * Math.tan(THREE.MathUtils.degToRad((camera?.fov ?? 60) * 0.5)) / Math.max(1, h);
  glows.end(pxAngle);
  segments.end();
  markers.end();
}

/**
 * Compila in anticipo i programmi degli obiettivi con la stessa
 * configurazione della partita.
 *
 * `renderer.compile` usa il render target *corrente* per scegliere tone
 * mapping e spazio colore del programma: compilato a schermo, un materiale
 * disegnato poi nel render target del composer (HDR lineare) richiede un
 * programma diverso, e la compilazione avverrebbe comunque al primo uso.
 * Qui si imposta il target in cui disegna davvero la RenderPass.
 */
export function precompileObjectives(renderer, scene, camera, roots, renderTarget) {
  const prev = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(renderTarget ?? null);
    for (const r of roots) if (r) renderer.compile(r, camera, scene);
  } catch (err) {
    // È un'ottimizzazione: se fallisce, i programmi si compilano al primo uso.
    if (import.meta.env?.DEV) console.warn('[objectives] pre-compilazione fallita', err);
  } finally {
    renderer.setRenderTarget(prev);
  }
}
