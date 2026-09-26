import * as THREE from 'three';

/**
 * Luci della scena.
 *
 * Il sole non è fisso nel mondo: segue la zona inquadrata, restando sempre a
 * ~40° dalla verticale locale. Con un sole fisso metà pianeta era perennemente
 * in ombra, e chi ci volava sopra giocava su un terreno scuro e piatto. Qui
 * ogni punto del pianeta, quando lo si sorvola, è illuminato di tre quarti
 * — ed è l'illuminazione che fa leggere le sfaccettature low-poly. Il ciclo
 * giorno/notte (Sky.js) regola colori, intensità ed elevazione.
 */

// Direzione di riferimento da cui "arriva" la luce, proiettata sul piano
// tangente del punto inquadrato. Qualsiasi vettore non radiale va bene.
const SUN_AZIMUTH_REF = new THREE.Vector3(0.62, 0.35, -0.7).normalize();
const SUN_ELEVATION = 0.9;   // rad dalla verticale (~52°), di giorno
const FOLLOW_RATE = 1.5;     // 1/s: il sole si sposta con calma, niente scatti

/**
 * Quanto al massimo la nebbia copre un oggetto. La nebbia qui è prospettiva
 * aerea, non foschia: un aereo nemico oltre l'orizzonte deve restare
 * riconoscibile, e con `THREE.Fog` il fattore arriva a 1 alla distanza `far`.
 * Il limite sta nel chunk GLSL, patchato una volta sola prima di qualunque
 * compilazione: vale per tutti i materiali con `fog: true`.
 */
const FOG_MAX = 0.6;
{
  const src = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
  if (THREE.ShaderChunk.fog_fragment.includes(src)) {
    THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace(
      src, `gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * ${FOG_MAX.toFixed(3)} );`);
  } else if (import.meta.env?.DEV) {
    console.warn('[fog] chunk fog_fragment cambiato: nebbia senza limite massimo');
  }
}

const _up = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _target = new THREE.Vector3();

export function setupLighting(scene) {
  // Luce ambientale pastello per evitare contrasti duri.
  const ambient = new THREE.AmbientLight(0xfff3e6, 0.68);
  scene.add(ambient);

  // Key light principale (sole cartoon caldo).
  const sun = new THREE.DirectionalLight(0xffe7bf, 1.18);
  sun.position.set(130, 95, 70).normalize();
  sun.castShadow = false; // disabilitato per performance
  scene.add(sun);

  // Fill fredda dal lato opposto: schiarisce le facce in ombra.
  const fill = new THREE.DirectionalLight(0xa6bcff, 0.34);
  fill.position.copy(sun.position).negate();
  scene.add(fill);

  // Rim light per stacco silhouette, utile su pianeta low-poly.
  const rim = new THREE.DirectionalLight(0xffd2f0, 0.24);
  rim.position.set(20, 40, -130).normalize();
  scene.add(rim);

  // Colore, near e far li aggiorna Sky.setView a ogni frame: colore
  // dell'orizzonte e distanze che seguono la quota della camera.
  scene.fog = new THREE.Fog(0xcfeaf7, 20, 90);

  let elevation = SUN_ELEVATION;

  /**
   * Orienta il sole sulla zona inquadrata.
   * @param {THREE.Vector3} viewPoint  punto guardato (di solito la camera)
   * @param {number} delta
   * @param {boolean} [snap]  salta la transizione (primo frame, respawn)
   */
  function follow(viewPoint, delta, snap = false) {
    if (viewPoint.lengthSq() < 1e-6) return;
    _up.copy(viewPoint).normalize();
    _tangent.copy(SUN_AZIMUTH_REF).addScaledVector(_up, -SUN_AZIMUTH_REF.dot(_up));
    if (_tangent.lengthSq() < 1e-4) _tangent.set(1, 0, 0).addScaledVector(_up, -_up.x);
    _tangent.normalize();
    _target.copy(_up).multiplyScalar(Math.cos(elevation))
      .addScaledVector(_tangent, Math.sin(elevation));

    const k = snap ? 1 : 1 - Math.exp(-FOLLOW_RATE * Math.min(delta, 0.1));
    sun.position.lerp(_target, k).normalize();
    fill.position.copy(sun.position).negate().addScaledVector(_up, 0.35).normalize();
    rim.position.copy(_tangent).negate().addScaledVector(_up, 0.4).normalize();
  }

  /**
   * Distanza del sole dalla verticale (rad). Il ciclo la abbassa al tramonto e
   * all'alba: una luce più radente allunga il chiaroscuro sulle sfaccettature.
   */
  function setSunElevation(rad) {
    elevation = rad;
  }

  return { sun, ambient, fill, rim, follow, setSunElevation };
}

/**
 * Toglie la nebbia ai materiali additivi già in scena.
 *
 * `fog_fragment` mescola il colore verso quello della nebbia senza toccare
 * l'alfa: su un materiale additivo le parti nere (code delle scie, bordi dei
 * lampi) diventerebbero colore di nebbia sommato alla scena, cioè aloni e
 * righe chiare. Da chiamare una volta, a mondo caricato e prima della
 * pre-compilazione. Chi crea materiali additivi più tardi (per esempio per
 * ogni aereo che entra) deve dichiarare `fog: false` da sé.
 */
export function excludeAdditiveFromFog(root) {
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (m.blending === THREE.AdditiveBlending && m.fog) {
        m.fog = false;
        m.needsUpdate = true;
      }
    }
  });
}
