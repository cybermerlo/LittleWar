import * as THREE from 'three';

/**
 * Aspetto degli aerei: materiali condivisi e ritocchi agli shader del modello.
 *
 * I materiali di spitfire.glb sono scuri (gris, bleu_clair e rouge hanno un
 * baseColor lineare sotto 0.11) e il clearcoat della vernice non riflette
 * nulla, perché in scena non c'è una envMap. Risultato: di giorno l'aereo è
 * una macchia scura sul terreno, di notte una sagoma nera. Qui si aggiungono
 * tre termini emissivi calcolati nello shader del modello stesso (nessuna
 * draw call in più):
 *
 *  - un bordo luminoso (rim) nel colore del giocatore, che stacca la sagoma
 *    da terreno e cielo e dice di chi è l'aereo anche da lontano;
 *  - un riflesso finto di cielo e terra sulla vernice. Non si usa una envMap
 *    vera perché su un pianeta il "su" cambia da punto a punto: una envMap è
 *    fissa nel mondo, e un aereo nell'emisfero sud rifletterebbe il terreno
 *    sulla schiena. Qui il "su" è la verticale del pianeta sotto l'aereo,
 *    passata come uniform;
 *  - un minimo di luce propria di notte.
 *
 * Le uniform sono PER AEREO (colore del rim, intensità, verticale), ma il
 * programma GLSL è uno solo per tipo di materiale: `customProgramCacheKey`
 * restituisce la stessa chiave per tutti, e in r160 `onBeforeCompile` viene
 * chiamato per ogni istanza di materiale, che si tiene i propri riferimenti
 * alle uniform. Per questo ogni aereo clona tutti i propri materiali.
 */

// ── Colori condivisi (uno scrittura per frame, per tutti gli aerei) ───────────

const _skyDay = new THREE.Color(0.62, 0.8, 1.0);
const _skyNight = new THREE.Color(0.06, 0.08, 0.2);
const _groundDay = new THREE.Color(0.32, 0.28, 0.2);
const _groundNight = new THREE.Color(0.02, 0.02, 0.04);

const shared = {
  uSkyCol: { value: _skyDay.clone() },
  uGroundCol: { value: _groundDay.clone() },
};

/** Tempo condiviso degli shader animati (scudo, disco dell'elica). */
const _time = { value: 0 };

/** Luminosità degli elementi non illuminati (disco elica): più bassa di notte. */
const _unlitLight = { value: 1 };

let _lastNight = -1;
/** Una volta per frame: tempo e giorno/notte per tutti gli aerei. */
export function tickAirplaneLook(timeSec, night) {
  _time.value = timeSec;
  if (Math.abs(night - _lastNight) < 0.002) return;
  _lastNight = night;
  shared.uSkyCol.value.copy(_skyDay).lerp(_skyNight, night);
  shared.uGroundCol.value.copy(_groundDay).lerp(_groundNight, night);
  _unlitLight.value = 1 - 0.65 * night;
}

// ── Rim, riflesso e luce propria ──────────────────────────────────────────────

const LOOK_PARS = /* glsl */ `
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uSelfLit;
uniform vec3 uUpWorld;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
uniform float uGloss;
`;

const LOOK_FRAGMENT = /* glsl */ `
{
  vec3 lwV = normalize(vViewPosition);
  float lwNdV = saturate(dot(normal, lwV));
  float lwRim = pow(1.0 - lwNdV, 2.5);
  vec3 lwUp = normalize((viewMatrix * vec4(uUpWorld, 0.0)).xyz);
  vec3 lwR = reflect(-lwV, normal);
  vec3 lwEnv = mix(uGroundCol, uSkyCol, smoothstep(-0.25, 0.35, dot(lwR, lwUp)));
  float lwFres = 0.12 + 0.88 * pow(1.0 - lwNdV, 4.0);
  totalEmissiveRadiance += lwEnv * (uGloss * lwFres) + uRimColor * (uRimStrength * lwRim + uSelfLit);
}
`;

const _white = new THREE.Color(1, 1, 1);

/** Colore del rim: quello del giocatore, schiarito quanto basta da vedersi (anche il nero). */
export function rimColorFor(color, out = new THREE.Color()) {
  out.set(color ?? '#ffffff');
  if (!Number.isFinite(out.r + out.g + out.b)) out.set('#ffffff');
  out.lerp(_white, 0.15);
  const lum = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  if (lum < 0.3) out.lerp(_white, 0.3 - lum);
  return out;
}

/** Uniform di un aereo: condivise da tutti i suoi materiali. */
export function makePlaneLookUniforms(color) {
  return {
    uRimColor: { value: rimColorFor(color) },
    uRimStrength: { value: 0.35 },
    uSelfLit: { value: 0 },
    uUpWorld: { value: new THREE.Vector3(0, 1, 0) },
  };
}

/**
 * Aggancia rim e riflesso a un materiale (già clonato per questo aereo).
 * @param {number} gloss  intensità del riflesso (vernice lucida ~0.5, opaco ~0.1)
 */
export function dressPlaneMaterial(mat, planeUniforms, gloss) {
  const glossU = { value: gloss };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = planeUniforms.uRimColor;
    shader.uniforms.uRimStrength = planeUniforms.uRimStrength;
    shader.uniforms.uSelfLit = planeUniforms.uSelfLit;
    shader.uniforms.uUpWorld = planeUniforms.uUpWorld;
    shader.uniforms.uSkyCol = shared.uSkyCol;
    shader.uniforms.uGroundCol = shared.uGroundCol;
    shader.uniforms.uGloss = glossU;
    // I nomi dei chunk sono quelli di three r160 (Lambert, Standard, Physical):
    // se un aggiornamento li cambia, il replace non trova nulla e l'aereo
    // torna semplicemente all'aspetto di prima.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LOOK_PARS}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${LOOK_FRAGMENT}`);
  };
  mat.customProgramCacheKey = () => 'lw-plane-look';
  return mat;
}

/** Quanto riflette ogni materiale dello spitfire (per nome). */
export function glossFor(materialName) {
  switch (materialName) {
    case 'blue': return 0.5;      // vernice col colore del giocatore (clearcoat nel GLB)
    case 'vitre': return 0.75;    // tettuccio
    case 'blanc':
    case 'jaune':
    case 'rouge': return 0.28;
    default: return 0.16;
  }
}

// ── Disco dell'elica ──────────────────────────────────────────────────────────
//
// Le pale del modello (Object_12 "jaune", Object_13 "gris") sono ~11.7k dei
// ~19.9k vertici dell'aereo e, animate a 5-10 giri al secondo, a 60 fps (e
// peggio a 30) producono l'effetto stroboscopico. Un disco trasparente con tre
// scie morbide e l'anello giallo delle punte è quello che l'occhio vede
// davvero di un'elica in moto, e costa quattro triangoli invece di ~11k.

export const propDiscGeometry = new THREE.CircleGeometry(1, 32);

export const propDiscMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uBlade: { value: new THREE.Color(0.1, 0.11, 0.11) },
    uTip: { value: new THREE.Color(1.0, 0.62, 0.08) },
    uLight: _unlitLight,
  },
  vertexShader: /* glsl */ `
    varying vec2 vP;
    varying float vFacing;
    void main() {
      vP = position.xy;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vFacing = abs(dot(normalize(normalMatrix * vec3(0.0, 0.0, 1.0)), normalize(-mv.xyz)));
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uBlade;
    uniform vec3 uTip;
    uniform float uLight;
    varying vec2 vP;
    varying float vFacing;
    void main() {
      float r = length(vP);
      if (r > 1.0) discard;
      float a = atan(vP.y, vP.x);
      float blades = pow(abs(cos(1.5 * a)), 6.0);
      float bladeA = (0.05 + 0.16 * blades) * smoothstep(0.1, 0.3, r) * (1.0 - smoothstep(0.87, 0.9, r));
      float tip = smoothstep(0.88, 0.91, r) * (1.0 - smoothstep(0.96, 0.995, r));
      float alpha = max(bladeA, tip * (0.14 + 0.2 * blades));
      // Visto di fronte (la camera di inseguimento sta proprio dietro) il
      // disco si attenua: un anello pieno attorno al muso, al centro dello
      // schermo, sembrerebbe un mirino. Di lato resta pieno.
      alpha *= mix(1.0, 0.35, smoothstep(0.7, 0.97, vFacing));
      gl_FragColor = vec4(mix(uBlade, uTip, tip) * uLight, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});

// ── Scudo: gabbia low-poly a campo di forza ───────────────────────────────────

function makeShieldGeometry() {
  // Non indicizzata: ogni triangolo ha i propri vertici, con coordinate
  // baricentriche (per illuminare gli spigoli) e normale di faccia (per il
  // fresnel sfaccettato, nello stile del pianeta).
  // PolyhedronGeometry è già non indicizzata.
  const geo = new THREE.IcosahedronGeometry(1.7, 1);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  const n = geo.getAttribute('position').count;
  const bary = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) bary[i * 3 + (i % 3)] = 1;
  geo.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
  return geo;
}

export const shieldGeometry = makeShieldGeometry();

/** Materiale dello scudo; `alpha` separato per le copie delle esplosioni. */
export function makeShieldMaterial(alpha = 1) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: _time,
      uAlpha: { value: alpha },
      uColor: { value: new THREE.Color(0.12, 0.55, 1.0) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aBary;
      varying vec3 vBary;
      varying vec3 vN;
      varying vec3 vV;
      varying float vH;
      void main() {
        vBary = aBary;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = -mv.xyz;
        vH = dot(position, vec3(0.35, 0.9, 0.25));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uAlpha;
      uniform vec3 uColor;
      varying vec3 vBary;
      varying vec3 vN;
      varying vec3 vV;
      varying float vH;
      void main() {
        float ndv = abs(dot(normalize(vN), normalize(vV)));
        float fres = pow(1.0 - ndv, 2.0);
        float e = min(min(vBary.x, vBary.y), vBary.z);
        float edge = 1.0 - smoothstep(0.0, 0.04, e);
        // Luccichio che scorre lento sulla gabbia.
        float sweep = smoothstep(0.9, 1.0, sin(vH * 2.2 - uTime * 2.6) * 0.5 + 0.5);
        // Centro quasi trasparente: lo scudo non deve coprire l'aereo.
        float a = (0.02 + 0.3 * fres + edge * (0.1 + 0.32 * fres) + 0.1 * sweep) * uAlpha;
        vec3 col = mix(uColor, vec3(0.75, 0.95, 1.0), 0.25 * fres + 0.2 * edge);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** Un solo materiale per gli scudi di tutti gli aerei. */
export const shieldMaterial = makeShieldMaterial(1);
