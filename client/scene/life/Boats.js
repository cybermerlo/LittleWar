import * as THREE from 'three';
import { sampleGround, makeSurfaceHit, SEA_SURFACE_RADIUS } from '../planetSurface.js';
import { seaIceAt } from '../Planet.js';
import { mulberry32, withLifeUniforms, nightRamp, tangentBasis, offsetDir } from './lifeShared.js';

/**
 * Barche a vela sul mare.
 *
 * Il mare è metà del pianeta ed era vuoto. Ogni barca percorre un giro chiuso
 * e irregolare al largo (una baia, il periplo di un isolotto), calcolato una
 * volta sola al caricamento sulla superficie *renderizzata*: la rotta viene
 * scartata se un solo punto ha meno di `MIN_DEPTH` d'acqua sotto o cade nella
 * banchisa polare disegnata sull'acqua (con qualche unità di margine per la
 * scia), quindi le barche non toccano mai terra, spiaggia né ghiaccio.
 *
 * Rendering: quattro InstancedMesh (scafi, vele, scie, lanterne) che
 * condividono lo STESSO `instanceMatrix`: una sola matrice per barca, caricata
 * una volta per frame. La scia e la lanterna si calcolano nel vertex shader a
 * partire da quella matrice, senza lavoro di CPU in più.
 *
 * Il tempo è locale: le barche non sono sincronizzate fra client, è solo
 * scenografia.
 */

const COUNT_HIGH = 12;
const COUNT_LOW = 6;
/** Fondale minimo sotto ogni punto della rotta (unità mondo). */
const MIN_DEPTH = 0.55;
/** Margine dal bordo della banchisa (in |y| unitario, ~3 unità a 62°). */
const ICE_MARGIN = 0.03;
/** Punti della rotta dopo il campionamento a passo costante. */
const ROUTE_POINTS = 160;
/** Distanza angolare minima fra i centri di due rotte. */
const MIN_ROUTE_SEPARATION = 0.34;
const SPEED_MIN = 0.55, SPEED_MAX = 0.9;   // unità/s

const SAIL_COLORS = [0xff5a4e, 0xffd23f, 0xfdf6e3, 0x5ac8fa, 0xff9f43, 0xff7eb6, 0xfdf6e3, 0x7bed9f];

// ── Geometria ────────────────────────────────────────────────────────────────
// Frame locale della barca: x = prua, y = su, z = dritta (x × y). La linea di
// galleggiamento è y = 0.

/** Aggiunge un quadrilatero (a, b, c, d in senso antiorario visto da fuori). */
function pushQuad(pos, col, a, b, c, d, color) {
  for (const p of [a, b, c, a, c, d]) {
    pos.push(p[0], p[1], p[2]);
    col.push(color.r, color.g, color.b);
  }
}
function pushTri(pos, col, a, b, c, color) {
  for (const p of [a, b, c]) {
    pos.push(p[0], p[1], p[2]);
    col.push(color.r, color.g, color.b);
  }
}

/** Box allineato agli assi, facce esterne (niente fondo). */
function pushBox(pos, col, x0, x1, y0, y1, z0, z1, color, top = color) {
  pushQuad(pos, col, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], top);   // sopra
  pushQuad(pos, col, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], color); // +x
  pushQuad(pos, col, [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], color); // -x
  pushQuad(pos, col, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color); // +z
  pushQuad(pos, col, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], color); // -z
}

function buildHullGeometry() {
  const pos = [], col = [];
  const white = new THREE.Color(0xf7f4ec);
  const keel = new THREE.Color(0xc0392b);
  const deck = new THREE.Color(0xc89a62);
  const wood = new THREE.Color(0x6b4a2b);

  // Contorno del ponte (xz), antiorario visto dall'alto: prua a punta,
  // specchio di poppa piatto.
  const outline = [[0.8, 0], [0.3, -0.27], [-0.6, -0.22], [-0.6, 0.22], [0.3, 0.27]];
  const Y_DECK = 0.2, Y_BAND = 0.05, Y_BOTTOM = -0.12;
  const at = (i, y, shrinkX, shrinkZ) => {
    const [x, z] = outline[i];
    return [x * shrinkX - (shrinkX < 1 ? 0.03 : 0), y, z * shrinkZ];
  };
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // Fascia alta bianca e opera viva rossa, più stretta verso la chiglia.
    pushQuad(pos, col, at(j, Y_DECK, 1, 1), at(i, Y_DECK, 1, 1), at(i, Y_BAND, 0.95, 0.85), at(j, Y_BAND, 0.95, 0.85), white);
    pushQuad(pos, col, at(j, Y_BAND, 0.95, 0.85), at(i, Y_BAND, 0.95, 0.85), at(i, Y_BOTTOM, 0.8, 0.4), at(j, Y_BOTTOM, 0.8, 0.4), keel);
  }
  // Ponte: ventaglio dal centro.
  const c = [-0.05, Y_DECK, 0];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    pushTri(pos, col, c, at(i, Y_DECK, 1, 1), at(j, Y_DECK, 1, 1), deck);
  }
  // Tuga, albero e boma.
  pushBox(pos, col, -0.46, -0.08, Y_DECK, 0.34, -0.14, 0.14, white, deck);
  pushBox(pos, col, 0.1, 0.15, Y_DECK, 1.62, -0.025, 0.025, wood);
  pushBox(pos, col, -0.5, 0.12, 0.36, 0.4, -0.02, 0.02, wood);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildSailGeometry() {
  const pos = [], col = [];
  const main = new THREE.Color(1, 1, 1);
  const jib = new THREE.Color(0.93, 0.93, 0.93);
  // Randa dietro l'albero e fiocco davanti, con un filo di pancia sottovento
  // (a dritta, +z: la barca sbanda da quella parte, vedi update).
  pushTri(pos, col, [0.1, 0.42, 0], [0.1, 1.55, 0], [-0.25, 0.9, 0.06], main);
  pushTri(pos, col, [0.1, 0.42, 0], [-0.25, 0.9, 0.06], [-0.48, 0.42, 0.02], main);
  pushTri(pos, col, [0.13, 1.42, 0], [0.13, 0.32, 0], [0.74, 0.26, 0.03], jib);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

// ── Scia ─────────────────────────────────────────────────────────────────────

const WAKE_LEN = 4.2;      // dalla prua verso poppa
const WAKE_WIDTH = 3.2;
const WAKE_BOW_X = 0.85;

const WAKE_VERT = /* glsl */`
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 local = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
    #endif
    vec4 mvPosition = modelViewMatrix * local;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const WAKE_FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  void main() {
    // x: distanza dalla prua; y: distanza laterale dalla chiglia.
    float x = (1.0 - vUv.x) * ${WAKE_LEN.toFixed(2)};
    float y = abs(vUv.y - 0.5) * ${WAKE_WIDTH.toFixed(2)};
    // Onda di Kelvin: due bracci a ~20° che partono dalla prua.
    float armDist = abs(y - 0.36 * x - 0.06);
    float arms = 1.0 - smoothstep(0.0, 0.04 + 0.035 * x, armDist);
    float ripple = 0.78 + 0.22 * sin(x * 6.0 - uTime * 4.0 + y * 2.0);
    // Schiuma rimescolata dietro la poppa.
    float behind = smoothstep(1.25, 1.6, x);
    float churn = (1.0 - smoothstep(0.1, 0.32 + 0.08 * x, y)) * behind;
    churn *= 0.8 + 0.2 * sin(x * 7.0 - uTime * 6.0 + y * 9.0);
    float fade = pow(max(1.0 - x / ${WAKE_LEN.toFixed(2)}, 0.0), 1.3);
    float a = max(arms * ripple, churn * 0.75) * fade * 0.55;
    vec3 col = vec3(0.93, 0.97, 1.0) * (uAmbient + uSunColor * 0.75);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function buildWakeGeometry() {
  const geo = new THREE.PlaneGeometry(WAKE_LEN, WAKE_WIDTH, 1, 1);
  geo.rotateX(-Math.PI / 2);                        // giace nel piano xz, faccia in su
  geo.translate(WAKE_BOW_X - WAKE_LEN / 2, 0.035, 0); // uv.x = 1 alla prua
  return geo;
}

// ── Lanterna (billboard additivo in cima all'albero) ─────────────────────────

const LANTERN_VERT = /* glsl */`
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 anchor = vec4(0.12, 1.66, 0.0, 1.0);
    #ifdef USE_INSTANCING
      anchor = instanceMatrix * anchor;
    #endif
    vec4 mv = modelViewMatrix * anchor;
    mv.xy += position.xy * uSize;
    gl_Position = projectionMatrix * mv;
  }
`;

const LANTERN_FRAG = /* glsl */`
  uniform float uOn;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float core = 1.0 - smoothstep(0.0, 0.22, d);
    float halo = pow(max(0.0, 1.0 - d), 2.4);
    float a = (core * 0.9 + halo * 0.55) * uOn;
    vec3 col = mix(vec3(1.0, 0.62, 0.25), vec3(1.0, 0.93, 0.75), core) * 1.6;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ── Rotte ────────────────────────────────────────────────────────────────────

const _hit = makeSurfaceHit();

function depthAt(dir) {
  return SEA_SURFACE_RADIUS - sampleGround(dir, _hit).radius;
}

function inIce(dir) {
  return seaIceAt(dir.x, dir.y, dir.z, ICE_MARGIN) > 0;
}

/**
 * Cerca un giro chiuso al largo: 7 punti attorno a un centro in acqua
 * profonda, raccordati da una Catmull-Rom chiusa e ricampionati a passo
 * costante. Se anche un solo punto della curva finale ha troppo poca acqua
 * sotto, la rotta viene scartata.
 */
function tryRoute(rand, centers) {
  const center = new THREE.Vector3();
  const u = new THREE.Vector3(), v = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (let attempt = 0; attempt < 200; attempt++) {
    // Seme fisso invece di randomDirection (Math.random): rotte uguali a ogni
    // caricamento, comodo per confrontare gli screenshot.
    center.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    if (center.lengthSq() < 1e-4 || center.lengthSq() > 1) continue;
    center.normalize();
    if (depthAt(center) < 1.0 || inIce(center)) continue;
    if (centers.some((c) => c.angleTo(center) < MIN_ROUTE_SEPARATION)) continue;

    tangentBasis(center, u, v);
    const K = 7;
    const base = 0.07 + rand() * 0.07;       // raggio angolare medio (3.5–7 unità)
    const knots = [];
    const a0 = rand() * Math.PI * 2;
    for (let k = 0; k < K; k++) {
      const a = a0 + (k / K) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      let ok = false;
      for (const shrink of [1, 0.8, 0.62, 0.45]) {
        const rho = base * (0.75 + rand() * 0.5) * shrink;
        offsetDir(center, u, v, a, rho, tmp);
        if (depthAt(tmp) > MIN_DEPTH + 0.2) { ok = true; break; }
      }
      if (!ok) break;
      knots.push(tmp.clone().multiplyScalar(SEA_SURFACE_RADIUS));
    }
    if (knots.length < K) continue;

    const curve = new THREE.CatmullRomCurve3(knots, true, 'centripetal');
    const pts = curve.getSpacedPoints(ROUTE_POINTS);
    pts.pop(); // l'ultimo coincide col primo
    let valid = true;
    for (const p of pts) {
      p.normalize();
      if (depthAt(p) < MIN_DEPTH || inIce(p)) { valid = false; break; }
    }
    if (!valid) continue;
    centers.push(center.clone());
    return pts;
  }
  return null;
}

/** Rotta pronta per il frame: punti unitari in un Float32Array + lunghezze cumulate. */
function packRoute(pts, reverse) {
  if (reverse) pts.reverse();
  const n = pts.length;
  const p = new Float32Array(n * 3);
  const cum = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    p[i * 3] = pts[i].x; p[i * 3 + 1] = pts[i].y; p[i * 3 + 2] = pts[i].z;
    if (i > 0) cum[i] = cum[i - 1] + pts[i].angleTo(pts[i - 1]) * SEA_SURFACE_RADIUS;
  }
  cum[n] = cum[n - 1] + pts[n - 1].angleTo(pts[0]) * SEA_SURFACE_RADIUS;
  return { p, cum, n, length: cum[n] };
}

// ── Sistema ──────────────────────────────────────────────────────────────────

const _pos = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _side = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qLocal = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();

function readPoint(route, i, out) {
  const k = (i % route.n) * 3;
  return out.set(route.p[k], route.p[k + 1], route.p[k + 2]);
}

export class Boats {
  /**
   * @param {THREE.Scene} scene
   * @param {{lowQuality?: boolean}} [options]
   */
  constructor(scene, { lowQuality = false } = {}) {
    this.lowQuality = lowQuality;
    this.enabled = true;
    const rand = mulberry32(90210);
    const wanted = lowQuality ? COUNT_LOW : COUNT_HIGH;

    this.boats = [];
    const centers = [];
    for (let i = 0; i < wanted; i++) {
      const pts = tryRoute(rand, centers);
      if (!pts) break;
      const route = packRoute(pts, rand() < 0.5);
      this.boats.push({
        route,
        s: rand() * route.length,
        seg: 0,
        speed: SPEED_MIN + rand() * (SPEED_MAX - SPEED_MIN),
        phase: rand() * Math.PI * 2,
        scale: 0.95 + rand() * 0.3,
      });
    }
    const count = Math.max(1, this.boats.length);

    this.group = new THREE.Group();
    this.group.name = 'boats';

    const hullMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.hulls = new THREE.InstancedMesh(buildHullGeometry(), hullMat, count);
    const sailMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    this.sails = new THREE.InstancedMesh(buildSailGeometry(), sailMat, count);
    // Una sola matrice per barca: vele, scie e lanterne leggono quella degli scafi.
    this.sails.instanceMatrix = this.hulls.instanceMatrix;
    this.hulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) this.sails.setColorAt(i, col.set(SAIL_COLORS[i % SAIL_COLORS.length]));
    const meshes = [this.hulls, this.sails];

    this.wakes = null;
    this.lanterns = null;
    this.lanternUniforms = null;
    if (!lowQuality) {
      const wakeMat = new THREE.ShaderMaterial({
        uniforms: withLifeUniforms(),
        vertexShader: WAKE_VERT,
        fragmentShader: WAKE_FRAG,
        transparent: true,
        depthWrite: false,
        fog: true,
      });
      this.wakes = new THREE.InstancedMesh(buildWakeGeometry(), wakeMat, count);
      this.wakes.instanceMatrix = this.hulls.instanceMatrix;
      // Dopo l'acqua (renderOrder 1), che non scrive profondità.
      this.wakes.renderOrder = 2;

      this.lanternUniforms = { uOn: { value: 0 }, uSize: { value: 0.75 } };
      const lanternMat = new THREE.ShaderMaterial({
        uniforms: this.lanternUniforms,
        vertexShader: LANTERN_VERT,
        fragmentShader: LANTERN_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.lanterns = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), lanternMat, count);
      this.lanterns.instanceMatrix = this.hulls.instanceMatrix;
      this.lanterns.renderOrder = 3;
      this.lanterns.visible = false;
      meshes.push(this.wakes, this.lanterns);
    }

    for (const m of meshes) {
      // Le istanze sono sparse su tutto il pianeta e si muovono: la bounding
      // sphere calcolata una volta sarebbe sbagliata subito dopo.
      m.frustumCulled = false;
      m.count = this.boats.length;
      this.group.add(m);
    }
    scene.add(this.group);
    this.update(0, 0, 0);
  }

  /**
   * @param {number} dt
   * @param {number} time        secondi (orologio condiviso della vita del mondo)
   * @param {number} nightFactor sky.getNightFactor()
   */
  update(dt, time, nightFactor) {
    if (!this.enabled || this.boats.length === 0) return;

    for (let i = 0; i < this.boats.length; i++) {
      const b = this.boats[i];
      const r = b.route;
      b.s = (b.s + b.speed * dt) % r.length;
      // La posizione avanza sempre in avanti: basta scorrere il segmento, con
      // una ripartenza quando il giro si chiude.
      if (r.cum[b.seg] > b.s) b.seg = 0;
      while (b.seg < r.n - 1 && r.cum[b.seg + 1] <= b.s) b.seg++;
      const f = (b.s - r.cum[b.seg]) / Math.max(1e-6, r.cum[b.seg + 1] - r.cum[b.seg]);

      readPoint(r, b.seg, _a);
      readPoint(r, b.seg + 1, _b);
      readPoint(r, b.seg + 2, _c);
      _pos.lerpVectors(_a, _b, f).normalize();
      // Rotta interpolata fra i due segmenti vicini: niente scatti di prua.
      _fwd.subVectors(_b, _a);
      _t2.subVectors(_c, _b);
      _fwd.lerp(_t2, f);
      _fwd.addScaledVector(_pos, -_fwd.dot(_pos)).normalize();
      _side.crossVectors(_fwd, _pos);
      // Terna destrorsa (prua, su, prua × su): una mancina sarebbe una
      // riflessione e il quaternione non avrebbe senso.
      _basis.makeBasis(_fwd, _pos, _side);
      _q.setFromRotationMatrix(_basis);

      const t = time + b.phase;
      const heave = 0.03 * Math.sin(t * 1.6);
      // Beccheggio, rollio e un filo di sbandamento sottovento.
      _euler.set(0.1 + 0.06 * Math.sin(t * 0.9), 0, 0.045 * Math.sin(t * 1.3 + 1.1));
      _qLocal.setFromEuler(_euler);
      _q.multiply(_qLocal);

      _pos.multiplyScalar(SEA_SURFACE_RADIUS + heave);
      _scale.setScalar(b.scale);
      _m.compose(_pos, _q, _scale);
      this.hulls.setMatrixAt(i, _m);
    }
    this.hulls.instanceMatrix.needsUpdate = true;

    if (this.lanterns) {
      const on = nightRamp(nightFactor, 0.45, 0.8);
      this.lanternUniforms.uOn.value = on;
      this.lanterns.visible = on > 0.01;
    }
  }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
  }
}
