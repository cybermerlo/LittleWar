import * as THREE from 'three';

function createPastelSkyGradientTexture() {
  const w = 4;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, 0, h);
  // Gradiente cartoon/pastello con azzurro piu' pieno, evitando il bianco in basso.
  grd.addColorStop(0.0, '#428fcd');
  grd.addColorStop(0.2, '#5fa8dc');
  grd.addColorStop(0.46, '#7ec0e7');
  grd.addColorStop(0.7, '#9bd2ef');
  grd.addColorStop(0.9, '#b6e0f5');
  grd.addColorStop(1.0, '#c4e6f8');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * Cielo a cupola con gradiente pastello (texture + materiale base, compatibile WebGL2).
 * `scene.background` evita buchi neri se la cupola non copre un pixel.
 */
export function createSky(scene) {
  scene.background = new THREE.Color(0x96cfee);

  const geo = new THREE.SphereGeometry(400, 48, 32);
  geo.scale(-1, 1, 1);

  const map = createPastelSkyGradientTexture();
  const mat = new THREE.MeshBasicMaterial({
    map,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });

  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  return { sky, map };
}
