import * as THREE from 'three';

/**
 * Linee di velocità durante il boost.
 *
 * Sottili righe di vento che sfrecciano verso la camera ai bordi
 * dell'inquadratura: una sola draw call, e solo mentre il boost è attivo.
 * Le posizioni sono calcolate direttamente in spazio camera nel vertex shader
 * (`gl_Position = projectionMatrix * vista`), quindi seguono la camera senza
 * che la CPU tocchi un vertice. Niente DOM: un overlay HTML sopra il canvas
 * costerebbe compositing a ogni frame.
 *
 * Il colore non conta sul bloom (spento in qualità bassa): sono righe chiare
 * e basta, più dense e più lunghe con l'extreme boost.
 */

const VERTEX = /* glsl */ `
  attribute vec3 aSeed; // angolo, distanza dall'asse, fase
  uniform float uTime;
  uniform float uAmount;
  uniform float uLen;
  uniform float uSpeed;
  varying float vAlpha;
  varying float vAcross;
  void main() {
    float ang = aSeed.x;
    float rad = aSeed.y;
    float ph = fract(aSeed.z + uTime * uSpeed);
    float z = -(3.0 + (1.0 - ph) * 26.0);
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 across = vec2(-dir.y, dir.x);
    // position.x: -0.5..0.5 sulla larghezza, position.y: -0.5..0.5 sulla lunghezza.
    vec3 p = vec3(dir * rad + across * position.x * 0.05, z + (position.y + 0.5) * uLen);
    // Entrano sfumate da lontano ed escono sfumate prima di toccare la camera.
    float fadeIn = smoothstep(0.0, 0.3, ph);
    float fadeOut = 1.0 - smoothstep(0.75, 1.0, ph);
    vAlpha = uAmount * fadeIn * fadeOut * (0.45 + 0.55 * fract(aSeed.z * 7.13));
    vAcross = position.x * 2.0;
    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  varying float vAlpha;
  varying float vAcross;
  void main() {
    float a = vAlpha * (1.0 - vAcross * vAcross);
    if (a < 0.003) discard;
    gl_FragColor = vec4(0.9, 0.95, 1.0, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class SpeedLines {
  constructor(scene, { lowQuality = false } = {}) {
    const count = lowQuality ? 20 : 36;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Angoli distribuiti uniformemente con un po' di disordine, lontano
      // dall'asse: il centro dello schermo è dove si mira.
      seeds[i * 3] = ((i + Math.random() * 0.8) / count) * Math.PI * 2;
      seeds[i * 3 + 1] = 2.6 + Math.random() * 3.4;
      seeds[i * 3 + 2] = Math.random();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    geo.instanceCount = count;

    this.uniforms = {
      uTime: { value: 0 },
      uAmount: { value: 0 },
      uLen: { value: 2 },
      uSpeed: { value: 1.6 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this._amount = 0;
    this._extreme = 0;
    this._time = 0;
  }

  /**
   * @param {number} boost    0..1 (boost normale)
   * @param {boolean} extreme extreme boost attivo
   */
  update(delta, boost, extreme) {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    const kUp = 1 - Math.exp(-5 * dt);
    const kDown = 1 - Math.exp(-3 * dt);
    const target = extreme ? 1 : 0.45 * boost;
    this._amount += (target - this._amount) * (target > this._amount ? kUp : kDown);
    this._extreme += ((extreme ? 1 : 0) - this._extreme) * kUp;
    this._time += dt;
    // Il tempo si riavvolge: in float32 dopo ore di gioco `fract` perderebbe precisione.
    if (this._time > 1000) this._time -= 1000;

    const u = this.uniforms;
    u.uTime.value = this._time;
    u.uAmount.value = this._amount * 0.8;
    u.uLen.value = 2 + 5 * this._extreme;
    u.uSpeed.value = 1.5 + 1.3 * this._extreme;
    this.mesh.visible = this._amount > 0.01;
  }
}
