import * as THREE from 'three';
import { isLowPowerQuality } from '../utils/performanceProfile.js';

/**
 * Mondo vivo: uniform condivise e pezzi di shader per terreno, mare e decori.
 *
 * Tutto ciò che rende il mondo "abitato" senza costare draw call vive qui:
 *  - ombre delle nuvole (calcolate per vertice su pianeta, mare, alberi e case);
 *  - aloni caldi dei paesi di notte (per vertice sul pianeta);
 *  - finestre che si accendono una casa alla volta (attributo `aSeed`);
 *  - vento sugli alberi (attributo `aSway`, solo vertex shader).
 *
 * I materiali vengono patchati con `onBeforeCompile` e le uniform sono gli
 * stessi oggetti di `worldUniforms`: aggiornarle una volta per frame (vedi
 * NightLights.js e CloudShadows.js) aggiorna tutti i materiali.
 *
 * Ogni blocco ha anche un interruttore a uniform (`uCloudK`, `uGlowOn`,
 * `uWindAmp`): un ramo su una uniform è coerente su tutta la GPU, quindi a
 * zero il ciclo non costa nulla. Serve di giorno agli aloni, di notte alle
 * ombre, e alla sonda F9 per misurare davvero ogni effetto.
 */

/** Nuvole che proiettano ombra, scelte fra le più vicine alla camera. */
export const CLOUD_SLOTS = 8;
/** Paesi con alone notturno (TOWNS in Terrain.js è 11 in alta, 4 in bassa). */
export const GLOW_SLOTS = 12;
/** In bassa qualità le nuvole non esistono: niente ombre né codice per calcolarle. */
export const CLOUD_SHADOWS = !isLowPowerQuality();

/**
 * Seme d'accensione che nessuna notte raggiunge (`uLit` arriva al massimo a 1):
 * lo ricevono i vertici non-finestra nei gruppi che contengono finestre.
 */
export const WINDOW_NEVER = 2.0;
/** Semi fino a questo valore sono ospedali: luce fredda, accesa per prima. */
export const HOSPITAL_SEED_MAX = 0.05;

export const worldUniforms = {
  uWorldTime: { value: 0 },
  /** 0..1: soglia di accensione delle finestre, sale con la notte. */
  uLit: { value: 0 },
  /** A = (centro dell'ombra, 1/semiasse lungo), B = (asse lungo, 1/semiasse corto). */
  uCloudA: { value: Array.from({ length: CLOUD_SLOTS }, () => new THREE.Vector4()) },
  uCloudB: { value: Array.from({ length: CLOUD_SLOTS }, () => new THREE.Vector4()) },
  /** Quanta luce diretta tolgono le ombre (0 = spente). */
  uCloudK: { value: 0 },
  /** xyz = centro del paese (direzione unitaria), w = coseno del raggio angolare. */
  uGlowDir: { value: Array.from({ length: GLOW_SLOTS }, () => new THREE.Vector4()) },
  uGlowCol: { value: Array.from({ length: GLOW_SLOTS }, () => new THREE.Color(0, 0, 0)) },
  uGlowOn: { value: 0 },
  /** Asse attorno a cui "gira" il vento: soffia tangente al pianeta. */
  uWindAxis: { value: new THREE.Vector3(0.28, 0.93, -0.24).normalize() },
  uWindAmp: { value: 1 },
};

/**
 * Luce diretta rimasta sotto le nuvole in una direzione `d` (unitaria).
 * L'ombra è un'ellisse morbida sul piano tangente al suo centro, allungata
 * come la nuvola. `step(0.9, dot(d, c))` taglia la copia antipodale che le
 * proiezioni su `a` e `b` produrrebbero dall'altra parte del pianeta, e spegne
 * gli slot vuoti (centro nullo).
 */
export const CLOUD_SHADOW_GLSL = /* glsl */`
#ifdef LW_CLOUDS
  uniform vec4 uCloudA[${CLOUD_SLOTS}];
  uniform vec4 uCloudB[${CLOUD_SLOTS}];
  uniform float uCloudK;
  float lwCloudLight(vec3 d) {
    if (uCloudK <= 0.0) return 1.0;
    float lit = 1.0;
    for (int i = 0; i < ${CLOUD_SLOTS}; i++) {
      vec3 c = uCloudA[i].xyz;
      vec3 a = uCloudB[i].xyz;
      float x = dot(d, a) * uCloudA[i].w;
      float y = dot(d, cross(c, a)) * uCloudB[i].w;
      float f = (1.0 - smoothstep(0.3, 1.0, x * x + y * y)) * step(0.9, dot(d, c));
      lit = min(lit, 1.0 - f);
    }
    return 1.0 - (1.0 - lit) * uCloudK;
  }
#endif
`;

const GLOW_GLSL = /* glsl */`
#ifdef LW_GLOW
  uniform vec4 uGlowDir[${GLOW_SLOTS}];
  uniform vec3 uGlowCol[${GLOW_SLOTS}];
  uniform float uGlowOn;
  vec3 lwTownGlow(vec3 d) {
    vec3 g = vec3(0.0);
    if (uGlowOn <= 0.0) return g;
    for (int i = 0; i < ${GLOW_SLOTS}; i++) {
      float k = smoothstep(uGlowDir[i].w, 1.0, dot(d, uGlowDir[i].xyz));
      g += uGlowCol[i] * (k * k);
    }
    return g;
  }
#endif
`;

const VERTEX_PARS = /* glsl */`
${CLOUD_SHADOW_GLSL}
${GLOW_GLSL}
#ifdef LW_CLOUDS
  varying float vCloudLit;
#endif
#ifdef LW_GLOW
  varying vec3 vGlow;
#endif
#ifdef LW_SWAY
  attribute vec2 aSway;   // x = peso (0 al piede, 1 in cima), y = fase dell'albero
  uniform float uWorldTime;
  uniform vec3 uWindAxis;
  uniform float uWindAmp;
#endif
#ifdef LW_WINDOWS
  attribute float aSeed;
  varying float vSeed;
#endif
`;

/**
 * Vento. Le mesh fuse del terreno hanno matrice identità, quindi `transformed`
 * è già in coordinate mondo. Le raffiche sono un fronte che scorre sul
 * pianeta: alberi vicini si piegano insieme, come un campo di grano.
 */
const SWAY_VERTEX = /* glsl */`
#ifdef LW_SWAY
  if (uWindAmp > 0.0 && aSway.x > 0.0) {
    vec3 lwR = normalize(transformed);
    vec3 lwW = cross(lwR, uWindAxis);
    lwW *= inversesqrt(max(dot(lwW, lwW), 1e-4));
    float gust = 0.55 + 0.45 * sin(dot(lwR, vec3(6.0, 4.0, -5.0)) - uWorldTime * 0.7);
    float osc = sin(uWorldTime * 1.7 + aSway.y) + 0.35 * sin(uWorldTime * 4.1 + aSway.y * 2.3);
    transformed += lwW * (aSway.x * gust * (0.05 + 0.055 * osc) * uWindAmp);
  }
#endif
`;

const END_VERTEX = /* glsl */`
#if defined(LW_CLOUDS) || defined(LW_GLOW)
  vec3 lwDir = normalize((modelMatrix * vec4(transformed, 1.0)).xyz);
#endif
#ifdef LW_CLOUDS
  vCloudLit = lwCloudLight(lwDir);
#endif
#ifdef LW_GLOW
  vGlow = lwTownGlow(lwDir);
#endif
#ifdef LW_WINDOWS
  vSeed = aSeed;
#endif
`;

const FRAGMENT_PARS = /* glsl */`
#ifdef LW_CLOUDS
  varying float vCloudLit;
#endif
#ifdef LW_GLOW
  varying vec3 vGlow;
#endif
#ifdef LW_WINDOWS
  uniform float uLit;
  uniform float uWorldTime;
  varying float vSeed;
#endif
`;

/**
 * Finestre: ogni casa ha un seme e si accende quando `uLit` lo supera, quindi
 * al tramonto si accendono una alla volta e all'alba si spengono in ordine
 * inverso. Toni caldi diversi per casa e qualche azzurro da televisore.
 * Gli ospedali (seme sotto `HOSPITAL_SEED_MAX`) hanno una luce fredda e più
 * tenue: nel modello il materiale "vetro" è il profilo del tetto, e acceso
 * in giallo pieno sembrava un'insegna al neon.
 * Il vetro acceso perde il ciano del giorno: sommato al giallo diventerebbe
 * bianco.
 *
 * Rosso forte, poco verde, niente blu. Di notte l'esposizione è 1.18 (quasi
 * 2× dentro ACES, che divide per 0.6) e il grading desatura e tira al blu:
 * il vecchio mix(arancio, giallo) × 2.5 usciva color crema, il bloom ci
 * aggiungeva un alone bianco e una fascia di vetro diventava una lastra al
 * neon. Il bloom scatta sulla luminanza (0.299, 0.587, 0.114) sopra 0.88,
 * prima del tone mapping: per avere l'alone serve quella luminanza, e
 * ottenerla col rosso invece che col verde lascia il vetro ambra
 * (~ 247,195,140 sRGB a notte piena) con un alone arancio. Abbassare il
 * rosso sotto ~2.5 spegne l'alone; alzare il verde torna verso il bianco.
 */
const WINDOW_FRAGMENT = /* glsl */`
#ifdef LW_WINDOWS
  {
    float on = smoothstep(vSeed, vSeed + 0.05, uLit);
    vec3 tint = mix(vec3(2.6, 0.21, 0.012), vec3(2.2, 0.4, 0.04), fract(vSeed * 17.0));
    float tv = step(0.93, fract(vSeed * 31.0));
    tint = mix(tint, vec3(0.28, 0.46, 1.0) * (0.7 + 0.25 * sin(uWorldTime * 9.0 + vSeed * 60.0)), tv);
    float hospital = step(vSeed, ${HOSPITAL_SEED_MAX.toFixed(3)});
    tint = mix(tint, vec3(0.75, 0.92, 1.0) * 0.85, hospital);
    totalEmissiveRadiance += tint * on;
    diffuseColor.rgb *= 1.0 - 0.75 * on;
  }
#endif
`;

/**
 * L'ombra toglie solo la luce diretta (l'ambiente resta). L'alone del paese è
 * luce che cade sul terreno, quindi si moltiplica per il colore della faccia
 * e non è un velo arancione uniforme; ma solo in parte: moltiplicato per il
 * verde pieno di un prato il giallo diventava verde acido, e con la luna blu
 * della notte non si leggeva più come luce calda.
 */
const LIGHT_FRAGMENT = /* glsl */`
#ifdef LW_CLOUDS
  reflectedLight.directDiffuse *= vCloudLit;
#endif
#ifdef LW_GLOW
  reflectedLight.directDiffuse += vGlow * mix(diffuseColor.rgb, vec3(0.45), 0.4);
#endif
`;

function injectAfter(source, include, code) {
  const tag = `#include <${include}>`;
  if (!source.includes(tag)) {
    if (import.meta.env?.DEV) console.warn(`[worldShaders] chunk ${include} non trovato`);
    return source;
  }
  return source.replace(tag, `${tag}\n${code}`);
}

/**
 * Aggiunge al materiale (Lambert o Standard) gli effetti richiesti.
 *
 * La chiave di cache è obbligatoria: senza, due materiali dello stesso tipo
 * con patch diverse finirebbero a condividere lo stesso programma GLSL,
 * perché Three.js userebbe il sorgente di `onBeforeCompile` (identico) come
 * chiave.
 *
 * @param {THREE.Material} material
 * @param {{clouds?:boolean, glow?:boolean, sway?:boolean, windows?:boolean}} flags
 */
export function patchWorldMaterial(material, flags) {
  const clouds = !!flags.clouds && CLOUD_SHADOWS;
  const { glow = false, sway = false, windows = false } = flags;
  if (!clouds && !glow && !sway && !windows) return material;

  const defines = [
    clouds ? '#define LW_CLOUDS' : '',
    glow ? '#define LW_GLOW' : '',
    sway ? '#define LW_SWAY' : '',
    windows ? '#define LW_WINDOWS' : '',
  ].filter(Boolean).join('\n');
  const key = `lw-world|${+clouds}${+glow}${+sway}${+windows}`;

  material.onBeforeCompile = (shader) => {
    const u = worldUniforms;
    if (clouds) Object.assign(shader.uniforms, { uCloudA: u.uCloudA, uCloudB: u.uCloudB, uCloudK: u.uCloudK });
    if (glow) Object.assign(shader.uniforms, { uGlowDir: u.uGlowDir, uGlowCol: u.uGlowCol, uGlowOn: u.uGlowOn });
    if (sway || windows) shader.uniforms.uWorldTime = u.uWorldTime;
    if (sway) Object.assign(shader.uniforms, { uWindAxis: u.uWindAxis, uWindAmp: u.uWindAmp });
    if (windows) shader.uniforms.uLit = u.uLit;

    let vs = shader.vertexShader;
    vs = injectAfter(vs, 'common', `${defines}\n${VERTEX_PARS}`);
    vs = injectAfter(vs, 'begin_vertex', SWAY_VERTEX);
    vs = injectAfter(vs, 'fog_vertex', END_VERTEX);

    let fs = shader.fragmentShader;
    fs = injectAfter(fs, 'common', `${defines}\n${FRAGMENT_PARS}`);
    fs = injectAfter(fs, 'emissivemap_fragment', WINDOW_FRAGMENT);
    fs = injectAfter(fs, 'lights_fragment_end', LIGHT_FRAGMENT);

    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return material;
}
