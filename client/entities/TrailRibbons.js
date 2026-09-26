import * as THREE from 'three';
import { MAX_PLAYERS } from '../../shared/constants.js';

/**
 * Scie alari a nastro, tutte in UNA mesh.
 *
 * Prima ogni punta d'ala aveva una THREE.Line di 32 punti che avanzava di un
 * punto per FRAME: la lunghezza dipendeva dagli fps (mezzo secondo a 60 fps,
 * otto secondi a 4 fps), quindi sulle macchine lente e in extreme boost
 * diventavano linee bianche dritte lunghe decine di unità. In più nessuno le
 * azzerava al respawn, e restava una corda che attraversava il pianeta dal
 * punto di morte a quello di rinascita. THREE.Line disegna poi 1 pixel con la
 * stessa luminosità a qualunque distanza, e costava due draw call per aereo
 * anche con la scia vuota.
 *
 * Qui la durata è in SECONDI: ogni scia è un anello di campioni con il proprio
 * istante, e a ogni frame si costruisce un nastro rivolto alla camera che si
 * assottiglia e svanisce con l'età. La scia si spezza da sola se la punta
 * salta più di quanto un aereo possa volare in quel tempo (teletrasporto,
 * respawn, correzione di rete), e chi lo sa prima può spezzarla con `cut()`.
 */

const MAX_TRAILS = (MAX_PLAYERS + 4) * 2;
/** Salto oltre il quale la scia si spezza: base + velocità massima plausibile × dt. */
const JUMP_BASE = 6;
const JUMP_SPEED = 80;       // unità/s: l'extreme boost arriva a ~55
const SAMPLE_INTERVAL = 25;  // ms fra un campione consolidato e l'altro
const MAX_SEGMENT = 0.8;     // unità: oltre, si consolida anche prima dell'intervallo
const HALF_WIDTH = 0.075;

const _toCam = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _side = new THREE.Vector3();
const _p = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1);
const _tint = new THREE.Color();

const VERTEX = /* glsl */ `
  attribute float aAlpha;
  attribute float aSide;
  attribute vec3 aColor;
  varying float vAlpha;
  varying float vSide;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vSide = aSide;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  varying float vAlpha;
  varying float vSide;
  varying vec3 vColor;
  void main() {
    // Bordo morbido: pieno al centro del nastro, nullo sui lati.
    float a = vAlpha * (1.0 - vSide * vSide);
    if (a < 0.002) discard;
    gl_FragColor = vec4(vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

class TrailRibbons {
  constructor() {
    this.mesh = null;
  }

  /**
   * Crea la mesh e la mette in scena. Da chiamare all'avvio, prima della
   * pre-compilazione degli shader.
   */
  init(scene, { lowQuality = false } = {}) {
    if (this.mesh) return;
    this.low = lowQuality;
    this.samples = lowQuality ? 12 : 20;
    this.life = lowQuality ? 0.35 : 0.5;
    this.points = this.samples + 1; // + il punto vivo, che segue la punta
    const S = this.samples;
    const P = this.points;

    this._pts = new Float32Array(MAX_TRAILS * S * 3);
    this._time = new Float64Array(MAX_TRAILS * S);
    this._int = new Float32Array(MAX_TRAILS * S);
    this._head = new Int32Array(MAX_TRAILS);
    this._count = new Int32Array(MAX_TRAILS);
    this._live = new Float32Array(MAX_TRAILS * 3);
    this._liveT = new Float64Array(MAX_TRAILS);
    this._liveI = new Float32Array(MAX_TRAILS);
    this._hasLive = new Uint8Array(MAX_TRAILS);
    this._inUse = new Uint8Array(MAX_TRAILS);
    this._lifeK = new Float32Array(MAX_TRAILS).fill(1);
    // Scratch per la costruzione: posizioni ed età dei punti di una scia.
    this._bx = new Float32Array(P * 3);
    this._ba = new Float32Array(P);
    this._bi = new Float32Array(P);

    const nVerts = MAX_TRAILS * P * 2;
    this._pos = new Float32Array(nVerts * 3);
    this._alpha = new Float32Array(nVerts);
    const side = new Float32Array(nVerts);
    for (let v = 0; v < nVerts; v++) side[v] = (v & 1) ? 1 : -1;
    this._colors = new Float32Array(nVerts * 3);

    const quadsPerTrail = P - 1;
    this._indicesPerTrail = quadsPerTrail * 6;
    const index = new Uint16Array(MAX_TRAILS * this._indicesPerTrail);
    let o = 0;
    for (let k = 0; k < MAX_TRAILS; k++) {
      const base = k * P * 2;
      for (let j = 0; j < quadsPerTrail; j++) {
        const a = base + j * 2;
        index[o++] = a; index[o++] = a + 1; index[o++] = a + 2;
        index[o++] = a + 1; index[o++] = a + 3; index[o++] = a + 2;
      }
    }

    const geo = new THREE.BufferGeometry();
    this._posAttr = new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._alphaAttr = new THREE.BufferAttribute(this._alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this._colorAttr = new THREE.BufferAttribute(this._colors, 3);
    geo.setAttribute('position', this._posAttr);
    geo.setAttribute('aAlpha', this._alphaAttr);
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setAttribute('aColor', this._colorAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Prende una scia libera; -1 se il pool è esaurito (l'aereo vola senza scia). */
  acquire(color) {
    if (!this.mesh) return -1;
    for (let k = 0; k < MAX_TRAILS; k++) {
      if (this._inUse[k]) continue;
      this._inUse[k] = 1;
      this.cut(k);
      // Bianco con un velo del colore del giocatore (in qualità bassa solo bianco).
      _tint.set(color ?? '#ffffff');
      if (!Number.isFinite(_tint.r + _tint.g + _tint.b)) _tint.set('#ffffff');
      _tint.lerp(_white, this.low ? 1 : 0.7).multiplyScalar(0.85);
      const P = this.points;
      for (let v = k * P * 2, end = v + P * 2; v < end; v++) {
        this._colors[v * 3] = _tint.r;
        this._colors[v * 3 + 1] = _tint.g;
        this._colors[v * 3 + 2] = _tint.b;
      }
      this._colorAttr.needsUpdate = true;
      return k;
    }
    return -1;
  }

  release(id) {
    if (id < 0 || !this.mesh) return -1;
    this.cut(id);
    this._inUse[id] = 0;
    // `build()` salta gli slot liberi ma il draw range arriva fino al più alto
    // in uso: senza azzerarli qui, gli ultimi nastri di un aereo rimosso (la
    // demo della lobby, un giocatore uscito) restavano sospesi nel cielo.
    // Alfa 0 e triangoli degeneri: nessun frammento. Solo al rilascio.
    const P = this.points;
    const v0 = id * P * 2, v1 = v0 + P * 2;
    this._alpha.fill(0, v0, v1);
    this._pos.fill(0, v0 * 3, v1 * 3);
    this._alphaAttr.needsUpdate = true;
    this._posAttr.needsUpdate = true;
    return -1;
  }

  /** Svuota la scia: il prossimo `push` ricomincia da zero. */
  cut(id) {
    if (id < 0 || !this.mesh) return;
    this._count[id] = 0;
    this._hasLive[id] = 0;
  }

  /**
   * Posizione corrente della punta d'ala (world).
   * @param {number} intensity  0..~1.2: quanto è marcata la scia in questo tratto
   * @param {number} lifeK      moltiplicatore della durata (boost: scie più lunghe)
   */
  push(id, x, y, z, now, intensity, lifeK = 1) {
    if (id < 0 || !this.mesh) return;
    const l = id * 3;
    if (this._hasLive[id]) {
      const dx = x - this._live[l], dy = y - this._live[l + 1], dz = z - this._live[l + 2];
      const dt = Math.min(0.3, Math.max(0, (now - this._liveT[id]) / 1000));
      const jump = JUMP_BASE + JUMP_SPEED * dt;
      if (dx * dx + dy * dy + dz * dz > jump * jump) this.cut(id);
    }
    this._live[l] = x; this._live[l + 1] = y; this._live[l + 2] = z;
    this._liveT[id] = now;
    this._liveI[id] = intensity;
    this._hasLive[id] = 1;
    this._lifeK[id] = lifeK;

    // Consolidamento: a intervalli di TEMPO (non di frame), o prima se la
    // punta si è spostata molto (extreme boost: la curva resta curva).
    const S = this.samples;
    const cnt = this._count[id];
    let consolidate = cnt === 0;
    if (!consolidate) {
      const h = id * S + this._head[id];
      const hx = this._pts[h * 3] - x, hy = this._pts[h * 3 + 1] - y, hz = this._pts[h * 3 + 2] - z;
      consolidate = now - this._time[h] >= SAMPLE_INTERVAL
        || hx * hx + hy * hy + hz * hz > MAX_SEGMENT * MAX_SEGMENT;
    }
    if (!consolidate) return;
    const head = cnt === 0 ? 0 : (this._head[id] + 1) % S;
    this._head[id] = head;
    if (cnt < S) this._count[id] = cnt + 1;
    const h = id * S + head;
    this._pts[h * 3] = x; this._pts[h * 3 + 1] = y; this._pts[h * 3 + 2] = z;
    this._time[h] = now;
    this._int[h] = intensity;
  }

  /**
   * Costruisce i nastri. Una volta per frame, DOPO l'aggiornamento della
   * camera e di tutti gli aerei: il lato del nastro va calcolato rispetto
   * alla camera di questo frame, altrimenti si vede un frame di ritardo.
   */
  build(camPos, now) {
    if (!this.mesh) return;
    const S = this.samples;
    const P = this.points;
    const bx = this._bx, ba = this._ba, bi = this._bi;
    let maxUsed = -1;
    let anyVisible = false;

    for (let k = 0; k < MAX_TRAILS; k++) {
      if (!this._inUse[k]) continue;
      maxUsed = k;
      const lifeMs = this.life * 1000 * this._lifeK[k];

      // Punti della scia dal più giovane al più vecchio, tagliati alla durata.
      let n = 0;
      if (this._hasLive[k]) {
        const age = (now - this._liveT[k]) / lifeMs;
        if (age < 1) {
          bx[0] = this._live[k * 3]; bx[1] = this._live[k * 3 + 1]; bx[2] = this._live[k * 3 + 2];
          ba[0] = Math.max(0, age);
          bi[0] = this._liveI[k];
          n = 1;
        }
      }
      const cnt = this._count[k];
      for (let c = 0; c < cnt && n > 0 && n < P; c++) {
        const idx = k * S + ((this._head[k] - c + S) % S);
        const age = (now - this._time[idx]) / lifeMs;
        let x = this._pts[idx * 3], y = this._pts[idx * 3 + 1], z = this._pts[idx * 3 + 2];
        let a = age;
        if (age >= 1) {
          // Coda esatta: il punto oltre la durata viene riportato lungo il
          // segmento fino all'età 1, così la scia non accorcia a scatti
          // quando gli fps sono bassi e i campioni radi.
          const pa = ba[n - 1];
          const f = age > pa ? (1 - pa) / (age - pa) : 0;
          const px = bx[(n - 1) * 3], py = bx[(n - 1) * 3 + 1], pz = bx[(n - 1) * 3 + 2];
          x = px + (x - px) * f; y = py + (y - py) * f; z = pz + (z - pz) * f;
          a = 1;
        }
        bx[n * 3] = x; bx[n * 3 + 1] = y; bx[n * 3 + 2] = z;
        ba[n] = a;
        bi[n] = this._int[idx];
        n++;
        if (a >= 1) break;
      }

      const vBase = k * P * 2;
      if (n < 2) {
        // Scia vuota: triangoli degeneri, nessun frammento.
        for (let v = vBase, end = vBase + P * 2; v < end; v++) {
          this._pos[v * 3] = 0; this._pos[v * 3 + 1] = 0; this._pos[v * 3 + 2] = 0;
          this._alpha[v] = 0;
        }
        continue;
      }
      anyVisible = true;

      for (let j = 0; j < P; j++) {
        const v = vBase + j * 2;
        if (j >= n) {
          // Punti inutilizzati: collassati sull'ultimo valido, invisibili.
          const q = (n - 1) * 3;
          this._pos[v * 3] = this._pos[v * 3 + 3] = bx[q];
          this._pos[v * 3 + 1] = this._pos[v * 3 + 4] = bx[q + 1];
          this._pos[v * 3 + 2] = this._pos[v * 3 + 5] = bx[q + 2];
          this._alpha[v] = this._alpha[v + 1] = 0;
          continue;
        }
        const j0 = j > 0 ? j - 1 : j;
        const j1 = j < n - 1 ? j + 1 : j;
        _tan.set(bx[j0 * 3] - bx[j1 * 3], bx[j0 * 3 + 1] - bx[j1 * 3 + 1], bx[j0 * 3 + 2] - bx[j1 * 3 + 2]);
        _p.set(bx[j * 3], bx[j * 3 + 1], bx[j * 3 + 2]);
        _toCam.subVectors(camPos, _p);
        const dist = _toCam.length();
        _side.crossVectors(_tan, _toCam);
        if (_side.lengthSq() < 1e-10) {
          // Scia che si allontana esattamente dalla camera: si ripiega sul
          // piano tangente del pianeta invece di collassare.
          _side.crossVectors(_tan, _p);
          if (_side.lengthSq() < 1e-10) _side.set(0, 0, 0);
        }
        const age = ba[j];
        const w = HALF_WIDTH * Math.pow(1 - age, 0.6);
        if (_side.lengthSq() > 0) _side.normalize().multiplyScalar(w);
        let alpha = bi[j] * (1 - age) * (1 - age);
        // Da lontano un nastro sottile diventa un filo che sfarfalla: meglio sparire.
        if (!this.low) alpha *= 1 - THREE.MathUtils.smoothstep(dist, 50, 110);
        this._pos[v * 3] = _p.x - _side.x; this._pos[v * 3 + 1] = _p.y - _side.y; this._pos[v * 3 + 2] = _p.z - _side.z;
        this._pos[v * 3 + 3] = _p.x + _side.x; this._pos[v * 3 + 4] = _p.y + _side.y; this._pos[v * 3 + 5] = _p.z + _side.z;
        this._alpha[v] = this._alpha[v + 1] = alpha;
      }
    }

    this.mesh.visible = anyVisible;
    this.geometry.setDrawRange(0, (maxUsed + 1) * this._indicesPerTrail);
    if (anyVisible) {
      this._posAttr.needsUpdate = true;
      this._alphaAttr.needsUpdate = true;
    }
  }
}

/** Scie alari di tutti gli aerei (una draw call). `init()` in main.js. */
export const wingTrails = new TrailRibbons();
