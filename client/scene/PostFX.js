import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Post-processing in qualità alta: RenderPass → BloomOnlyPass → GradePass.
 *
 * Prima il bloom stock era l'ultimo pass e faceva due passate a tutto schermo:
 * copiava la scena a schermo con un MeshBasicMaterial (quindi tone mapping ACES
 * e sRGB) e poi ci sommava sopra il bloom con un CopyShader, cioè *dopo* il
 * tone mapping e senza codifica sRGB. Gli aloni venivano sporchi, con i bordi
 * duri, e i nuclei HDR non avevano il rolloff morbido di ACES.
 *
 * Ora il bloom calcola solo la propria texture e un unico passo finale legge
 * scena e bloom, li somma in HDR, applica tone mapping, grading, vignettatura,
 * effetti di gioco, sRGB e dithering: una passata a tutto schermo in meno.
 *
 * NON aggiungere un OutputPass o uno ShaderPass dopo il bloom stock: il bloom
 * smetterebbe di essere l'ultimo e sommerebbe in place nel target MSAA, cioè
 * una scrittura a tutto schermo in più e un secondo resolve MSAA.
 *
 * In qualità bassa nulla di tutto questo è attivo: la RenderPass disegna
 * direttamente a schermo e gli effetti di gioco passano da un overlay CSS
 * (vedi CssScreenFx), che costa solo composizione.
 */

/**
 * Tetto dell'ingresso del bloom (HDR lineare). La scena voluta sta sotto:
 * sole ~2.7, finestre 2.6, e solo il primo fotogramma di un'esplosione
 * arriva a ~20 in pochi pixel.
 */
const BLOOM_INPUT_MAX = 8.0;

/**
 * Filtro passa-alto del bloom: quello stock (LuminosityHighPassShader) più
 * la pulizia dell'ingresso, nella stessa passata.
 *
 * Il filtro legge la scena con un solo campione per pixel del target ridotto
 * (da 1/5 a 1/8 della risoluzione per lato), e la sfocatura di
 * UnrealBloomPass ha sigma pari al raggio del kernel, tagliata lì: è quasi
 * una scatola. Un solo pixel enorme (un half float traboccato) diventava
 * così due quadrati annidati, uno per mip, larghi 35 e 115 px; un NaN o un
 * infinito (un pow() con base negativa) si propaga per tutti i mip e
 * spegneva il fotogramma intero. Qui NaN e infiniti valgono 0 e il resto è
 * limitato a BLOOM_INPUT_MAX scalando tutto il colore, così un nucleo
 * arancio resta arancio: il caso peggiore è ora un alone tenue come quello
 * di una luce vera.
 */
const HIGH_PASS_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec3 defaultColor;
  uniform float defaultOpacity;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    #if __VERSION__ >= 300
      if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
    #endif
    c = clamp(c, 0.0, 65504.0);
    c *= min(1.0, ${BLOOM_INPUT_MAX.toFixed(1)} / max(max(c.r, max(c.g, c.b)), 1e-4));
    float v = dot(c, vec3(0.299, 0.587, 0.114));
    float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
    gl_FragColor = mix(vec4(defaultColor, defaultOpacity), vec4(c, 1.0), alpha);
  }
`;

/**
 * UnrealBloomPass che si ferma alla composizione dei mip: niente copia della
 * scena a schermo e niente somma finale, ci pensa il GradePass.
 *
 * Dipende dall'implementazione di UnrealBloomPass di three r160 (campi
 * renderTargetBright, renderTargetsHorizontal/Vertical, separableBlurMaterials,
 * compositeMaterial, materialHighPassFilter): aggiornando three va ricontrollata.
 */
export class BloomOnlyPass extends UnrealBloomPass {
  constructor(resolution, strength, radius, threshold) {
    super(resolution, strength, radius, threshold);
    // Mai compilato finora: basta sostituire il sorgente. Vale anche per il
    // ripiego a schermo di render() (super.render usa lo stesso materiale).
    this.materialHighPassFilter.fragmentShader = HIGH_PASS_FRAG;
  }

  /** Bloom già composto, a risoluzione ridotta, in lineare HDR. */
  get bloomTexture() {
    return this.renderTargetsHorizontal[0].texture;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // Se dopo non c'è nessun GradePass attivo (la sonda F9 lo spegne per
    // misurarlo) si torna al comportamento originale: copia e somma a schermo.
    if (this.renderToScreen) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }

    renderer.getClearColor(this._oldClearColor);
    this.oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);
    if (maskActive) renderer.state.buffers.stencil.setTest(false);

    // 1. Zone luminose
    this.highPassUniforms.tDiffuse.value = readBuffer.texture;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    this.fsQuad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this.fsQuad.render(renderer);

    // 2. Sfocatura progressiva dei mip
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const blur = this.separableBlurMaterials[i];
      this.fsQuad.material = blur;
      blur.uniforms.colorTexture.value = input.texture;
      blur.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this.fsQuad.render(renderer);

      blur.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      blur.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this.fsQuad.render(renderer);
      input = this.renderTargetsVertical[i];
    }

    // 3. Composizione dei mip in renderTargetsHorizontal[0] (= bloomTexture)
    this.fsQuad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    this.fsQuad.render(renderer);

    if (maskActive) renderer.state.buffers.stencil.setTest(true);
    renderer.setClearColor(this._oldClearColor, this.oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }
}

const GRADE_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GRADE_FRAG = /* glsl */`
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloom;
  uniform vec2  uTexel;
  uniform float uAspect;
  uniform float uFxaa;
  uniform vec3  uWhite;
  uniform float uSat;
  uniform float uContrast;
  uniform vec3  uLift;
  uniform float uVignette;
  uniform float uBoost;
  uniform vec3  uBoostTint;
  uniform float uDeath;
  uniform float uHit;
  uniform vec3  uHitColor;
  varying vec2 vUv;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  vec3 sceneAt(vec2 uv) { return texture2D(tScene, uv).rgb; }
  // Luma percettiva di un valore HDR: FXAA ragiona su valori già compressi.
  float lp(vec3 c) { return sqrt(dot(c, LUMA) / (1.0 + dot(c, LUMA))); }

  // FXAA "console" a 9 letture. Solo quando l'MSAA non c'è (niente
  // EXT_color_buffer_float, o l'ultimo gradino della risoluzione adattiva):
  // il ramo dipende da una uniform, quindi è coerente su tutta la GPU e a
  // MSAA attivo non costa nulla.
  vec3 fxaa(vec2 uv) {
    vec3 cM  = sceneAt(uv);
    vec3 cNW = sceneAt(uv + vec2(-0.5, -0.5) * uTexel);
    vec3 cNE = sceneAt(uv + vec2( 0.5, -0.5) * uTexel);
    vec3 cSW = sceneAt(uv + vec2(-0.5,  0.5) * uTexel);
    vec3 cSE = sceneAt(uv + vec2( 0.5,  0.5) * uTexel);
    float lM = lp(cM), lNW = lp(cNW), lNE = lp(cNE), lSW = lp(cSW), lSE = lp(cSE);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    if (lMax - lMin < max(0.03, lMax * 0.12)) return cM;
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
    float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    dir = clamp(dir * rcp, -6.0, 6.0) * uTexel;
    vec3 a = 0.5 * (sceneAt(uv - dir / 6.0) + sceneAt(uv + dir / 6.0));
    vec3 b = a * 0.5 + 0.25 * (sceneAt(uv - dir * 0.5) + sceneAt(uv + dir * 0.5));
    float lB = lp(b);
    return (lB < lMin || lB > lMax) ? a : b;
  }

  void main() {
    vec2 q = vUv - 0.5;
    float r = length(q * vec2(uAspect, 1.0));
    // 0 al centro, 1 verso gli angoli: l'aereo sta al centro e resta nitido.
    float edge = smoothstep(0.28, 0.85, r);

    vec3 hdr;
    if (uBoost > 0.01) {
      // Turbo: sfocatura radiale e aberrazione cromatica, solo ai bordi.
      vec2 off = q * (0.028 * uBoost * edge);
      vec3 a = sceneAt(vUv);
      vec3 b = sceneAt(vUv - off);
      vec3 c = sceneAt(vUv - off * 2.0);
      vec3 streak = (a + b + c) * (1.0 / 3.0);
      hdr = mix(streak, vec3(c.r, b.g, a.b), 0.55);
    } else if (uFxaa > 0.5) {
      hdr = fxaa(vUv);
    } else {
      hdr = sceneAt(vUv);
    }
    if (uBloom > 0.5) hdr += texture2D(tBloom, vUv).rgb;
    hdr *= uWhite;

    vec3 col = hdr;
    #ifdef TONE_MAPPING
      col = toneMapping(col);
    #endif
    col = clamp(col, 0.0, 1.0);

    // Grading per fase del ciclo (Sky.js): saturazione e ombre sollevate.
    float l = dot(col, LUMA);
    col = max(mix(vec3(l), col, uSat), 0.0);
    col += uLift * (1.0 - col);

    // Vignettatura: porta l'occhio al centro, più stretta col turbo.
    float vig = uVignette + uBoost * 0.22;
    col *= 1.0 - vig * smoothstep(0.45, 1.5, r * r * 1.6);
    col = mix(col, col * uBoostTint, edge * uBoost);

    // Abbattimento: il mondo perde colore e si scurisce.
    col = mix(col, vec3(dot(col, LUMA)) * vec3(0.52, 0.55, 0.62), uDeath * 0.85);
    // Scudo perso: bordo azzurro che si spegne.
    col += uHitColor * (uHit * 0.5 * smoothstep(0.45, 1.05, r));

    gl_FragColor = linearToOutputTexel(vec4(col, 1.0));
    // Curva a S leggera sui valori già codificati.
    vec3 g = clamp(gl_FragColor.rgb, 0.0, 1.0);
    gl_FragColor.rgb = mix(g, g * g * (3.0 - 2.0 * g), uContrast);
    // Dithering: i gradienti del cielo a 8 bit facevano bande.
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    gl_FragColor.rgb += (n - 0.5) / 255.0;
  }
`;

/**
 * Passo finale: somma HDR scena + bloom, tone mapping (ACES con
 * toneMappingExposure, identico ai materiali), grading, vignettatura, effetti
 * di gioco, sRGB, dithering. Deve essere l'ultimo pass del composer.
 */
export class GradePass extends Pass {
  /** @param {BloomOnlyPass} bloomPass */
  constructor(bloomPass) {
    super();
    this.needsSwap = false;
    this.bloomPass = bloomPass;
    this.material = new THREE.ShaderMaterial({
      name: 'GradePass',
      uniforms: {
        tScene:     { value: null },
        tBloom:     { value: null },
        uBloom:     { value: 0 },
        uTexel:     { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uAspect:    { value: 1 },
        uFxaa:      { value: 0 },
        uWhite:     { value: new THREE.Color(1, 1, 1) },
        uSat:       { value: 1 },
        uContrast:  { value: 0 },
        uLift:      { value: new THREE.Color(0, 0, 0) },
        uVignette:  { value: 0.2 },
        uBoost:     { value: 0 },
        uBoostTint: { value: new THREE.Color(1, 1, 1) },
        uDeath:     { value: 0 },
        uHit:       { value: 0 },
        uHitColor:  { value: new THREE.Color(0.25, 0.75, 1.0) },
      },
      vertexShader: GRADE_VERT,
      fragmentShader: GRADE_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    const u = this.material.uniforms;
    u.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    u.uAspect.value = width / Math.max(1, height);
  }

  /** FXAA al posto dell'MSAA assente. Uniform, quindi nessuna ricompilazione. */
  setFxaa(on) {
    this.material.uniforms.uFxaa.value = on ? 1 : 0;
  }

  /** @param {{sat:number, contrast:number, vignette:number, white:THREE.Color, lift:THREE.Color}} g */
  setGrade(g) {
    const u = this.material.uniforms;
    u.uSat.value = g.sat;
    u.uContrast.value = g.contrast;
    u.uVignette.value = g.vignette;
    u.uWhite.value.copy(g.white);
    u.uLift.value.copy(g.lift);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tScene.value = readBuffer.texture;
    const bloomOn = !!this.bloomPass?.enabled;
    u.uBloom.value = bloomOn ? 1 : 0;
    // Mai una texture nulla nel sampler: a bloom spento si lega la scena, che
    // il ramo sulla uniform non legge comunque.
    u.tBloom.value = bloomOn ? this.bloomPass.bloomTexture : readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
    // Se qualcuno aggiungesse un pass dopo, il risultato va passato avanti.
    this.needsSwap = !this.renderToScreen;
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

/**
 * Effetti a schermo di qualità bassa: tre velature CSS statiche di cui cambia
 * solo l'opacità (composizione pura, niente repaint né backdrop-filter). Sono
 * `display: none` quando spente, così fuori dagli effetti non costano nulla.
 * Sotto l'HUD (z-index ≥ 10) e sopra il canvas.
 */
class CssScreenFx {
  constructor() {
    this._layers = null;
    this._values = [0, 0, 0];
  }

  _build() {
    const make = (background) => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;display:none;opacity:0;'
        + `background:${background};`;
      document.body.appendChild(el);
      return el;
    };
    this._layers = [
      make('radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(8,14,30,0.7) 100%)'),
      make('radial-gradient(ellipse at center, rgba(40,40,52,0.45) 0%, rgba(12,12,18,0.8) 100%)'),
      make('radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(120,220,255,0.85) 100%)'),
    ];
  }

  set(boost, death, hit) {
    this._setLayer(0, boost);
    this._setLayer(1, death);
    this._setLayer(2, hit);
  }

  _setLayer(i, value) {
    // Quantizzata: lo stile si tocca solo quando cambia davvero.
    const next = value < 0.01 ? 0 : Math.round(value * 50) / 50;
    if (next === this._values[i]) return;
    if (!this._layers) this._build();
    this._values[i] = next;
    const el = this._layers[i];
    el.style.display = next > 0 ? 'block' : 'none';
    el.style.opacity = String(next);
  }
}

/**
 * Effetti a schermo di gioco, pilotati solo da stato che main.js ha già:
 * turbo ed extreme boost, morte del giocatore locale (isAlive che passa a
 * false), scudo perso (hasShield da true a false restando vivi).
 */
export class ScreenEffects {
  /** @param {{gradePass?: GradePass, lowQuality?: boolean}} opts */
  constructor({ gradePass, lowQuality }) {
    this.grade = lowQuality ? null : gradePass;
    this.css = lowQuality ? new CssScreenFx() : null;
    this.boost = 0;
    this.extreme = 0;
    this.death = 0;
    this.hit = 0;
    this._wasAlive = true;
    this._hadShield = false;
    this._tint = new THREE.Color();
    this._debugUntil = 0;
  }

  /**
   * @param {number} delta
   * @param {{active:boolean, alive:boolean, boost:boolean, extreme:boolean, shield:boolean}} s
   */
  update(delta, s) {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    if (!s.active) {
      this.boost = this.extreme = this.death = this.hit = 0;
      this._wasAlive = true;
      this._hadShield = false;
    } else {
      const target = s.extreme ? 1 : (s.boost ? 0.6 : 0);
      const rate = target > this.boost ? 5 : 2.5;
      this.boost += (target - this.boost) * (1 - Math.exp(-rate * dt));
      this.extreme += ((s.extreme ? 1 : 0) - this.extreme) * (1 - Math.exp(-4 * dt));

      const hold = performance.now() < this._debugUntil;
      // La rampa dura mezzo secondo e non ritarda la schermata di morte.
      if (!s.alive) this.death = Math.min(1, this.death + dt * 2);
      else if (!hold) this.death = Math.max(0, this.death - dt * 4);

      if (s.alive && this._wasAlive && this._hadShield && !s.shield) this.hit = 1;
      if (!hold) this.hit = Math.max(0, this.hit - dt * 2.2);
      this._wasAlive = s.alive;
      this._hadShield = s.alive && s.shield;
    }
    if (!s.alive || !s.active) this.boost = Math.max(0, this.boost - dt * 4);

    if (this.grade) {
      const u = this.grade.material.uniforms;
      u.uBoost.value = this.boost < 0.005 ? 0 : this.boost;
      // Turbo normale: bordi appena freddi. Extreme: bordi caldi e più forti.
      u.uBoostTint.value.copy(this._tint.setRGB(0.86, 0.94, 1.08).lerp(_EXTREME_TINT, this.extreme));
      u.uDeath.value = this.death;
      u.uHit.value = this.hit;
    } else if (this.css) {
      this.css.set(this.boost, this.death * 0.9, this.hit);
    }
  }

  /** Solo per test e screenshot. */
  debugPulse(kind) {
    this._debugUntil = performance.now() + 2000;
    if (kind === 'hit') this.hit = 1;
    else if (kind === 'death') this.death = 1;
    else if (kind === 'reset') this.hit = this.death = this.boost = 0;
  }
}

const _EXTREME_TINT = new THREE.Color(1.12, 0.9, 0.7);
