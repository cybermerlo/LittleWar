import * as THREE from 'three';
import { PLANET_RADIUS } from '../../../shared/planetField.js';
import { sampleGround, makeSurfaceHit, SEA_SURFACE_RADIUS } from '../planetSurface.js';
import { mulberry32, withLifeUniforms, tangentBasis, offsetDir } from './lifeShared.js';

/**
 * Stormi di gabbiani (sulle coste) e rondini (sopra i paesi), animati
 * interamente nel vertex shader.
 *
 * Ogni uccello è una "M" di 4 triangoli. Gli attributi per istanza descrivono
 * solo l'orbita (centro, raggio, quota, velocità, fase): posizione, rotta,
 * rollio in virata e battito d'ali escono dal tempo nello shader, quindi la CPU
 * non fa nulla per frame oltre ad aggiornare l'uniform del tempo. Una draw call
 * per tutti gli stormi.
 *
 * Di notte gli uccelli "vanno a dormire": scendono di quota e rimpiccioliscono
 * fino a triangoli degeneri (zero pixel), poi la mesh viene nascosta.
 *
 * Quota di ogni orbita: `lift` sopra il terreno più alto sotto l'anello e
 * `clear` sopra il tetto o la chioma più alti (edifici e alberi del terreno).
 * `clear` copre scarto del singolo uccello (±0.4), ondeggio (±0.45) e mezza
 * ala inclinata in virata: prima contava solo il terreno e le rondini
 * entravano e uscivano dal tetto dell'ospedale. Un sito che non ci sta sotto
 * `MAX_ALTITUDE` (una collina alta nell'anello) viene scartato, non schiacciato.
 */

/**
 * Quota massima del centro dell'orbita: con ondeggio, scarto e ali il punto
 * più alto di uno stormo resta sotto ~55.4, cioè sotto gli aerei (56) e sotto
 * la camera che li insegue.
 */
const MAX_ALTITUDE = 54.0;

const FLOCKS = {
  gull: {
    color: [0xf4f6f8, 0xe6ebef, 0xd9dee4],
    radius: 3.4,        // unità mondo dell'orbita
    speed: 2.4,         // unità/s
    size: 1.0,
    lift: 2.2,          // sopra il terreno più alto sotto l'orbita
    clear: 1.45,        // sopra il tetto/la chioma più alti sotto l'orbita
    birds: [7, 5],      // [alta, bassa]
  },
  swallow: {
    color: [0x27324a, 0x1e2536, 0x3a4660],
    radius: 2.4,
    speed: 3.6,
    size: 0.72,
    lift: 1.6,
    clear: 1.25,
    birds: [9, 6],
  },
};

const BIRD_VERT = /* glsl */`
  attribute vec4 aCenter;   // xyz direzione del centro dell'orbita, w raggio angolare
  attribute vec4 aAxis;     // xyz asse tangente di riferimento, w quota dell'orbita
  attribute vec4 aParams;   // x fase, y velocità angolare (con segno), z scala, w fase del battito
  attribute vec3 aColor;
  attribute float aSink;    // discesa massima al tramonto (resta sopra tetti e terreno)
  attribute float aShade;   // per vertice: punte delle ali più scure
  uniform float uTime;
  uniform float uFade;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  varying vec3 vColor;
  #include <fog_pars_vertex>

  void main() {
    vec3 C = aCenter.xyz;
    vec3 U = aAxis.xyz;
    vec3 V = cross(C, U);
    float ph = aParams.x;
    float a = ph + uTime * aParams.y;
    // L'orbita respira e ondeggia: uno stormo non è un anello perfetto.
    float rho = aCenter.w * (1.0 + 0.2 * sin(uTime * 0.37 + ph * 2.3));
    vec3 radial = U * cos(a) + V * sin(a);
    vec3 up = normalize(C * cos(rho) + radial * sin(rho));
    float alt = aAxis.w + 0.45 * sin(uTime * 0.8 + ph * 5.0) - (1.0 - uFade) * aSink;
    vec3 fwd = (V * cos(a) - U * sin(a)) * sign(aParams.y);
    fwd = normalize(fwd - up * dot(fwd, up));
    vec3 right = cross(fwd, up);
    // Rollio verso il centro della virata.
    float bank = 0.38 * sign(aParams.y);
    vec3 upB = up * cos(bank) - right * sin(bank);
    vec3 rightB = cross(fwd, upB);

    // Battito alternato a planate; la punta dell'ala ritarda sul gomito.
    float flapOn = smoothstep(-0.25, 0.35, sin(uTime * 0.55 + ph * 3.1));
    float span = abs(position.z);
    float beat = sin(uTime * 10.0 + aParams.w - span * 2.4);
    float lift = mix(0.18, beat * 0.95, flapOn);
    vec3 lp = position;
    lp.y += lift * span;

    float s = aParams.z * uFade;
    vec3 world = up * alt + (fwd * lp.x + upB * lp.y + rightB * lp.z) * s;

    float ndl = abs(dot(upB, uSunDir));
    vColor = aColor * aShade * (uAmbient + uSunColor * (0.35 + 0.65 * ndl));

    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const BIRD_FRAG = /* glsl */`
  varying vec3 vColor;
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * Sagoma a "M": corpo sottile e ali lunghe e strette, gomito rialzato e punta
 * più bassa. Un'ala larga a delta sembrava un aeroplanino di carta; piatta e
 * vista di taglio sarebbe sparita in una riga. 8 triangoli.
 * x = avanti, y = su, z = apertura alare.
 */
function buildBirdShape() {
  const tris = [];
  const shade = [];
  const tri = (a, b, c, sa = 1, sb = 1, sc = 1) => { tris.push(a, b, c); shade.push(sa, sb, sc); };
  // Corpo: rombo sottile dal becco alla coda.
  const nose = [0.16, 0, 0], tail = [-0.17, 0, 0];
  const bl = [0, 0, -0.035], br = [0, 0, 0.035];
  tri(nose, bl, br);
  tri(bl, tail, br);
  for (const s of [-1, 1]) {
    const sf = [0.05, 0, 0.03 * s], sb = [-0.05, 0, 0.03 * s];
    const ef = [0.035, 0.07, 0.17 * s], eb = [-0.055, 0.07, 0.16 * s];
    const tip = [-0.12, 0.0, 0.4 * s];
    tri(sf, ef, eb);
    tri(sf, eb, sb);
    tri(ef, tip, eb, 1, 0.55, 1);
  }
  return { position: new Float32Array(tris.flat()), shade: new Float32Array(shade) };
}

const _hit = makeSurfaceHit();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _probe = new THREE.Vector3();

/**
 * Quota di un'orbita (vedi in testa) e il punto più alto sotto di essa, o
 * null se l'orbita non ci sta sotto MAX_ALTITUDE.
 * @param {{position:THREE.Vector3, height:number, size:number}[]} obstacles
 */
function orbitAltitude(center, rho, cfg, obstacles) {
  tangentBasis(center, _u, _v);
  let ground = Math.max(SEA_SURFACE_RADIUS, sampleGround(center, _hit).radius);
  for (let k = 0; k < 24; k++) {
    for (const f of [0.7, 1.0, 1.3]) {
      offsetDir(center, _u, _v, (k / 24) * Math.PI * 2, rho * f, _probe);
      ground = Math.max(ground, sampleGround(_probe, _hit).radius);
    }
  }
  // Gli uccelli girano fra 0.64 e 1.44 volte `rho` (raggio del singolo
  // 0.8–1.2, respiro dell'orbita 0.8–1.2): conta ciò che tocca quell'anello.
  let roof = 0;
  for (const o of obstacles) {
    if (center.angleTo(o.position) < rho * 1.5 + o.size / PLANET_RADIUS) {
      roof = Math.max(roof, o.position.length() + o.height);
    }
  }
  const alt = Math.max(ground + cfg.lift, roof + cfg.clear);
  return alt > MAX_ALTITUDE ? null : { alt, top: Math.max(ground, roof) };
}

/** Sito per i gabbiani: terra bassa con il mare a pochi passi. */
function isCoastSite(dir) {
  const e = sampleGround(dir, _hit).radius - PLANET_RADIUS;
  if (e < 0.05 || e > 0.9) return false;
  tangentBasis(dir, _u, _v);
  let sea = 0;
  for (let k = 0; k < 8; k++) {
    offsetDir(dir, _u, _v, (k / 8) * Math.PI * 2, 3.5 / PLANET_RADIUS, _probe);
    if (sampleGround(_probe, _hit).radius < SEA_SURFACE_RADIUS - 0.3) sea++;
  }
  return sea >= 3 && sea <= 6;
}

export class Birds {
  /**
   * @param {THREE.Scene} scene
   * @param {{towns?: THREE.Vector3[], obstacles?: {position:THREE.Vector3, height:number, size:number}[],
   *          lowQuality?: boolean}} [options]  obstacles: edifici e alberi del terreno
   */
  constructor(scene, { towns = [], obstacles = [], lowQuality = false } = {}) {
    this.enabled = true;
    const rand = mulberry32(4242);
    const q = lowQuality ? 1 : 0;

    const sites = [];
    const site = (kind, center) => {
      const orbit = orbitAltitude(center, FLOCKS[kind].radius / PLANET_RADIUS, FLOCKS[kind], obstacles);
      if (orbit) sites.push({ kind, center: center.clone(), ...orbit });
      return !!orbit;
    };
    // Gabbiani sulle coste.
    const gullFlocks = lowQuality ? 1 : 3;
    const dir = new THREE.Vector3();
    for (let attempt = 0, n = 0; attempt < 3000 && n < gullFlocks; attempt++) {
      dir.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      if (dir.lengthSq() < 1e-4 || dir.lengthSq() > 1) continue;
      dir.normalize();
      if (sites.some((s) => s.center.angleTo(dir) < 0.5)) continue;
      if (!isCoastSite(dir)) continue;
      if (site('gull', dir)) n++;
    }
    // Rondini sopra i paesi (i primi, già sparsi sul pianeta) che le lasciano
    // girare sopra i tetti restando sotto gli aerei.
    const swallowFlocks = lowQuality ? 1 : 3;
    for (let i = 0, n = 0; i < towns.length && n < swallowFlocks; i++) {
      if (site('swallow', towns[i])) n++;
    }

    let total = 0;
    for (const s of sites) total += FLOCKS[s.kind].birds[q];
    this.count = total;

    const aCenter = new Float32Array(total * 4);
    const aAxis = new Float32Array(total * 4);
    const aParams = new Float32Array(total * 4);
    const aColor = new Float32Array(total * 3);
    const aSink = new Float32Array(total);
    const col = new THREE.Color();
    let i = 0;
    for (const s of sites) {
      const cfg = FLOCKS[s.kind];
      const rho = cfg.radius / PLANET_RADIUS;
      tangentBasis(s.center, _u, _v);
      const dirSign = rand() < 0.5 ? -1 : 1;
      const omega = cfg.speed / cfg.radius;
      const lead = rand() * Math.PI * 2;
      for (let b = 0; b < cfg.birds[q]; b++, i++) {
        aCenter.set([s.center.x, s.center.y, s.center.z, rho * (0.8 + rand() * 0.4)], i * 4);
        const alt = s.alt + (rand() - 0.5) * 0.8;
        aAxis.set([_u.x, _u.y, _u.z, alt], i * 4);
        // Al tramonto scende al più fin quasi al punto più alto sotto l'orbita,
        // ondeggio compreso: rimpicciolisce mentre scende, non ci entra.
        aSink[i] = Math.min(1.5, Math.max(0, alt - s.top - 0.55));
        // Stormo raccolto: fasi vicine, così si inseguono invece di stare in cerchio.
        aParams.set([
          lead + (rand() - 0.5) * 1.8,
          // Stessa velocità angolare per tutto lo stormo: con velocità diverse
          // in pochi minuti si sparpaglierebbe lungo tutto l'anello.
          dirSign * omega,
          cfg.size * (0.85 + rand() * 0.3),
          rand() * Math.PI * 2,
        ], i * 4);
        col.set(cfg.color[b % cfg.color.length]);
        aColor.set([col.r, col.g, col.b], i * 3);
      }
    }

    const geo = new THREE.InstancedBufferGeometry();
    const shape = buildBirdShape();
    geo.setAttribute('position', new THREE.BufferAttribute(shape.position, 3));
    geo.setAttribute('aShade', new THREE.BufferAttribute(shape.shade, 1));
    geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(aCenter, 4));
    geo.setAttribute('aAxis', new THREE.InstancedBufferAttribute(aAxis, 4));
    geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(aParams, 4));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
    geo.setAttribute('aSink', new THREE.InstancedBufferAttribute(aSink, 1));
    geo.instanceCount = total;

    this.uniforms = withLifeUniforms({ uFade: { value: 1 } });
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: BIRD_VERT,
      fragmentShader: BIRD_FRAG,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    // Le posizioni nascono nello shader: la bounding sphere della "M" non
    // direbbe nulla su dove sono gli uccelli.
    this.mesh.frustumCulled = false;
    this.mesh.name = 'birds';
    this.mesh.visible = total > 0;
    scene.add(this.mesh);
  }

  update(nightFactor) {
    if (!this.enabled) return;
    const fade = 1 - THREE.MathUtils.smoothstep(nightFactor, 0.6, 0.85);
    this.uniforms.uFade.value = fade;
    this.mesh.visible = this.count > 0 && fade > 0.01;
  }

  setEnabled(on) {
    this.enabled = on;
    this.mesh.visible = on && this.count > 0;
  }
}
