import * as THREE from 'three';

export function setupLighting(scene) {
  // Luce ambientale tenue
  const ambient = new THREE.AmbientLight(0xffeedd, 0.6);
  scene.add(ambient);

  // Sole principale
  const sun = new THREE.DirectionalLight(0xfff5e0, 1.4);
  sun.position.set(120, 80, 60);
  sun.castShadow = false; // disabilitato per performance
  scene.add(sun);

  // Luce di rimbalzo opposta (fill light)
  const fill = new THREE.DirectionalLight(0x8899ff, 0.3);
  fill.position.set(-80, -40, -60);
  scene.add(fill);

  return { sun, ambient, fill };
}
