import * as THREE from 'three';

/**
 * Luci della scena.
 *
 * Il sole non è fisso nel mondo: segue la zona inquadrata, restando sempre a
 * ~40° dalla verticale locale. Con un sole fisso metà pianeta era perennemente
 * in ombra, e chi ci volava sopra giocava su un terreno scuro e piatto. Qui
 * ogni punto del pianeta, quando lo si sorvola, è illuminato di tre quarti
 * — ed è l'illuminazione che fa leggere le sfaccettature low-poly. Il ciclo
 * giorno/notte (Sky.js) continua a regolare colori e intensità.
 */

// Direzione di riferimento da cui "arriva" la luce, proiettata sul piano
// tangente del punto inquadrato. Qualsiasi vettore non radiale va bene.
const SUN_AZIMUTH_REF = new THREE.Vector3(0.62, 0.35, -0.7).normalize();
const SUN_ELEVATION = 0.9;   // rad dalla verticale (~52°)
const FOLLOW_RATE = 1.5;     // 1/s: il sole si sposta con calma, niente scatti

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

  scene.fog = new THREE.Fog(0xcfeaf7, 160, 430);

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
    _target.copy(_up).multiplyScalar(Math.cos(SUN_ELEVATION))
      .addScaledVector(_tangent, Math.sin(SUN_ELEVATION));

    const k = snap ? 1 : 1 - Math.exp(-FOLLOW_RATE * Math.min(delta, 0.1));
    sun.position.lerp(_target, k).normalize();
    fill.position.copy(sun.position).negate().addScaledVector(_up, 0.35).normalize();
    rim.position.copy(_tangent).negate().addScaledVector(_up, 0.4).normalize();
  }

  return { sun, ambient, fill, rim, follow };
}
