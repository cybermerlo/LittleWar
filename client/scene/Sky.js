import * as THREE from 'three';

export function createSky(scene) {
  // Gradiente cielo tramite sfera grande invertita
  const geo = new THREE.SphereGeometry(400, 16, 16);
  // Invertiamo le normali per renderizzare dall'interno
  geo.scale(-1, 1, 1);

  const mat = new THREE.MeshBasicMaterial({
    color: 0x1a2a5a,
    side: THREE.BackSide,
  });

  const sky = new THREE.Mesh(geo, mat);
  scene.add(sky);

  // Qualche stella semplice (punti)
  const starCount = 600;
  const starPositions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = Math.acos(2 * Math.random() - 1);
    const phi = Math.random() * Math.PI * 2;
    const r = 380;
    starPositions[i * 3]     = r * Math.sin(theta) * Math.cos(phi);
    starPositions[i * 3 + 1] = r * Math.cos(theta);
    starPositions[i * 3 + 2] = r * Math.sin(theta) * Math.sin(phi);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.8 });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  return { sky, stars };
}
