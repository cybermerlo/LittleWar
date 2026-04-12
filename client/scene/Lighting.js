import * as THREE from 'three';

export function setupLighting(scene) {
  // Luce ambientale pastello per evitare contrasti duri.
  const ambient = new THREE.AmbientLight(0xfff3e6, 0.68);
  scene.add(ambient);

  // Key light principale (sole cartoon caldo).
  const sun = new THREE.DirectionalLight(0xffe7bf, 1.18);
  sun.position.set(130, 95, 70);
  sun.castShadow = false; // disabilitato per performance
  scene.add(sun);

  // Fill fredda: schiarisce il lato in ombra.
  const fill = new THREE.DirectionalLight(0xa6bcff, 0.34);
  fill.position.set(-110, -25, -75);
  scene.add(fill);

  // Rim light per stacco silhouette, utile su pianeta low-poly.
  const rim = new THREE.DirectionalLight(0xffd2f0, 0.24);
  rim.position.set(20, 40, -130);
  scene.add(rim);

  scene.fog = new THREE.Fog(0xcfeaf7, 160, 430);

  return { sun, ambient, fill, rim };
}
