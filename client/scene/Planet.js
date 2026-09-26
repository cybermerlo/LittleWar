import * as THREE from 'three';
import { PLANET_RADIUS, elevationAt } from '../../shared/planetField.js';
import { buildPlanetSurfaceIndex, SEA_SURFACE_RADIUS } from './planetSurface.js';
import { faceColor, hash01 } from './planetBiomes.js';
import { worldUniforms, patchWorldMaterial, CLOUD_SHADOW_GLSL, CLOUD_SHADOWS } from './worldShaders.js';

/**
 * Pianeta low-poly: terreno, mare e atmosfera.
 *
 * Terreno
 * -------
 * IcosahedronGeometry con DETAIL = 36: ~27k facce larghe ~1.4 unità (prima
 * erano 720 facce da 10 unità, con coste a zig-zag e montagne a piramide).
 * La geometria non è indicizzata, quindi ogni faccia ha i suoi tre vertici:
 * li coloriamo tutti e tre con il colore del bioma della faccia, ed è questo
 * che dà il look "a sfaccettature" pulito, senza sfumature tra una faccia e
 * l'altra. Con `computeVertexNormals` su una geometria non indicizzata le
 * normali sono già quelle di faccia.
 *
 * Mare
 * ----
 * Stessa suddivisione del terreno, così ogni vertice dell'acqua sta sulla
 * stessa direzione di un vertice del terreno e ne conosce la profondità
 * esatta (attributo `aDepth`): turchese sopra le piattaforme, blu al largo,
 * schiuma dove la profondità tende a zero (cioè esattamente sulla costa
 * disegnata) e ghiaccio vicino ai poli. Le facce interamente sopra la costa
 * non vengono create. L'illuminazione segue il ciclo giorno/notte.
 * In qualità alta linee di schiuma corrono verso riva (anche questo solo da
 * `aDepth`, niente texture).
 *
 * Terreno e mare ricevono le ombre delle nuvole, e il terreno gli aloni caldi
 * dei paesi di notte: entrambi calcolati per vertice (worldShaders.js).
 */

const DETAIL = 36;

// ── Terreno ───────────────────────────────────────────────────────────────────

function buildTerrainGeometry() {
  const geo = new THREE.IcosahedronGeometry(1, DETAIL);
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const elevation = new Float32Array(count);

  // I vertici condivisi compaiono in più facce: la quota si calcola una sola
  // volta per direzione.
  const cache = new Map();
  for (let i = 0; i < count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let e = cache.get(key);
    if (e === undefined) {
      e = elevationAt(x, y, z);
      cache.set(key, e);
    }
    elevation[i] = e;
    const r = PLANET_RADIUS + e;
    pos.setXYZ(i, x * r, y * r, z * r);
  }

  const colors = new Float32Array(count * 3);
  const col = new THREE.Color();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), centroid = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

  for (let f = 0; f < count / 3; f++) {
    const i0 = f * 3;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i0 + 1);
    c.fromBufferAttribute(pos, i0 + 2);
    centroid.copy(a).add(b).add(c).normalize();
    n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)).normalize();
    if (n.dot(centroid) < 0) n.negate();
    const slope = 1 - Math.max(0, Math.min(1, n.dot(centroid)));
    const eAvg = (elevation[i0] + elevation[i0 + 1] + elevation[i0 + 2]) / 3;

    faceColor(col, centroid.x, centroid.y, centroid.z, eAvg, slope, hash01(f));
    for (let k = 0; k < 3; k++) {
      colors[(i0 + k) * 3] = col.r;
      colors[(i0 + k) * 3 + 1] = col.g;
      colors[(i0 + k) * 3 + 2] = col.b;
    }
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return { geo, elevation };
}

// ── Mare ─────────────────────────────────────────────────────────────────────

// Varying costante su tutta la faccia (quella del vertice "provocante"). La
// geometria dell'acqua non è indicizzata, quindi ogni faccia ha i suoi vertici.
// WebGL1 non ha `flat`: lì ricade su un varying normale (riflesso più morbido).
const FLAT_VARYING = /* glsl */`
  #if __VERSION__ >= 300
    #define LW_FLAT flat
  #else
    #define LW_FLAT
  #endif
`;

const WATER_VERT = /* glsl */`
  attribute float aDepth;
  attribute float aIce;
  uniform float uTime;
  varying vec3  vWorldPos;
  varying vec3  vDir;
  ${FLAT_VARYING}
  LW_FLAT varying vec3 vFacePos;
  varying float vDepth;
  varying float vIce;
  varying float vCloudLit;
  ${CLOUD_SHADOW_GLSL}
  #include <fog_pars_vertex>

  void main() {
    vec3 dir = normalize(position);
    // Onde: somme di seni su direzioni 3D (niente coordinate sferiche, quindi
    // niente pizzicature ai poli). Nulle vicino alla costa, così l'acqua non
    // "entra" nella spiaggia.
    float w = sin(dot(dir, vec3(21.0, 17.0, 11.0)) + uTime * 1.3)
            + sin(dot(dir, vec3(-13.0, 27.0, 8.0)) - uTime * 1.1) * 0.7
            + sin(dot(dir, vec3(9.0, -15.0, 31.0)) + uTime * 1.7) * 0.4;
    float amp = 0.028 * smoothstep(0.1, 0.9, aDepth);
    vec3 p = position + dir * w * amp;

    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    vFacePos = wp.xyz;
    vDir = dir;
    vDepth = aDepth;
    vIce = aIce;
    #ifdef LW_CLOUDS
      vCloudLit = lwCloudLight(dir);
    #else
      vCloudLit = 1.0;
    #endif
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const WATER_FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uAmbient;
  uniform vec3  uShallow;
  uniform vec3  uDeep;
  uniform vec3  uFoam;
  uniform vec3  uIce;
  varying vec3  vWorldPos;
  varying vec3  vDir;
  varying float vDepth;
  varying float vIce;
  varying float vCloudLit;
  ${FLAT_VARYING}
  LW_FLAT varying vec3 vFacePos;
  #include <fog_pars_fragment>

  void main() {
    // Normale di faccia dalle derivate: acqua sfaccettata come il terreno,
    // e le onde fanno scintillare le facce una per una.
    vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    if (dot(N, vDir) < 0.0) N = -N;
    vec3 V = normalize(cameraPosition - vWorldPos);
    float ndl = max(dot(N, uSunDir), 0.0);
    // Sotto una nuvola manca solo il sole: l'ambiente resta.
    vec3 light = uAmbient + uSunColor * (ndl * vCloudLit);

    float depthT = smoothstep(0.05, 1.9, vDepth);
    vec3 col = mix(uShallow, uDeep, depthT) * light;

    // Riflesso del sole: scintille faccia per faccia, in una zona piccola.
    // Tutto è costante sul triangolo (normale di faccia, direzione e vista dal
    // vertice flat), quindi ogni faccia si accende intera o resta spenta,
    // come le sfaccettature del terreno. La normale liscia della sfera dice
    // DOVE possono accendersi, quella di faccia, inclinata dalle onde, QUALI.
    // Due versioni scartate: la sola normale di faccia accendeva esagoni pieni
    // attorno ai vertici sollevati dalle onde, lontano quanto voleva; un lobo
    // largo sulla normale liscia, acceso anche dove la faccia non scintillava,
    // dipingeva una macchia bianca tonda e sfocata (allargata dal bloom).
    vec3 Vf = normalize(cameraPosition - vFacePos);
    float zone = dot(reflect(-uSunDir, normalize(vFacePos)), Vf);
    float glint = dot(reflect(-uSunDir, N), Vf);
    float spec = smoothstep(0.993, 0.9995, glint) * smoothstep(0.97, 0.99, zone);

    // Fresnel: ai bordi del pianeta l'acqua riflette il cielo.
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    col = mix(col, uShallow * light * 1.25, fres * 0.35);

    // Schiuma sulla costa: una fascia che respira col tempo.
    float breathe = 0.5 + 0.5 * sin(uTime * 1.6 + dot(vDir, vec3(40.0, 23.0, 31.0)));
    float foam = 1.0 - smoothstep(0.015, 0.08 + 0.04 * breathe, vDepth);

    #ifdef SHORE_WAVES
      // Onde che corrono verso riva: linee a profondità costante che, col
      // tempo, scivolano verso profondità minori, cioè verso la spiaggia, e si
      // sciolgono nella risacca. vDepth è interpolato dentro triangoli da 1.4
      // unità, quindi le linee sono isobate spezzate che ricalcano la costa.
      // fwidth le allarga quanto un pixel e le spegne quando diventano più
      // fitte dei pixel stessi (da lontano sfarfallerebbero).
      float wt = vDepth * 4.5 + uTime * 0.4 + 0.35 * sin(dot(vDir, vec3(17.0, 11.0, 23.0)) + uTime * 0.3);
      float fw = fwidth(wt);
      float band = fract(wt);
      float ring = smoothstep(0.80 - fw, 0.86, band) * (1.0 - smoothstep(0.9, 0.97 + fw, band));
      // Ogni onda è spezzata in tratti di qualche unità, con un disegno suo
      // (floor(wt) è costante lungo la cresta mentre avanza): continue,
      // sembravano le curve di livello di una carta nautica.
      float dash = smoothstep(-0.2, 0.5, sin(dot(vDir, vec3(37.0, 29.0, 41.0)) + floor(wt) * 2.1));
      float reach = smoothstep(0.03, 0.1, vDepth) * (1.0 - smoothstep(0.1, 0.6, vDepth));
      float waves = ring * dash * reach * (1.0 - smoothstep(0.25, 0.5, fw)) * (1.0 - vIce);
      foam = max(foam, waves * 0.75);
    #endif

    col = mix(col, uFoam * light, foam * 0.85);
    col += uSunColor * (spec * 0.45 * vCloudLit * (1.0 - foam));

    // Banchisa polare.
    col = mix(col, uIce * light, vIce);

    float alpha = mix(0.62, 0.93, depthT);
    alpha = max(alpha, max(foam * 0.9, vIce));
    alpha = min(1.0, alpha + fres * 0.1);
    gl_FragColor = vec4(col, alpha);
    // Vuoti nel render target del composer (qualità alta). In bassa la scena
    // va dritta a schermo e senza questi l'acqua usciva in lineare, senza
    // tone mapping: più scura e satura di tutto il resto.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * Banchisa polare (0..1) nella direzione unitaria (dx, dy, dz): ghiaccio oltre
 * ~62° di latitudine, con un bordo frastagliato. È l'attributo `aIce`
 * dell'acqua; chi naviga (Boats.js) lo interroga per restarne fuori.
 * @param {number} [margin]  anticipa il bordo di tanto (in |y| unitario): con
 *        0.03 il ghiaccio "comincia" ~3 unità prima di quello disegnato
 */
export function seaIceAt(dx, dy, dz, margin = 0) {
  const x = dx * SEA_SURFACE_RADIUS, z = dz * SEA_SURFACE_RADIUS;
  const edge = 0.88 + 0.035 * Math.sin(x * 0.9) * Math.cos(z * 0.7);
  return THREE.MathUtils.smoothstep(Math.abs(dy) + margin, edge - 0.015, edge + 0.015);
}

function buildWaterGeometry(elevation) {
  const src = new THREE.IcosahedronGeometry(SEA_SURFACE_RADIUS, DETAIL);
  const pos = src.getAttribute('position');
  const faces = pos.count / 3;

  const keep = [];
  for (let f = 0; f < faces; f++) {
    const i = f * 3;
    const minE = Math.min(elevation[i], elevation[i + 1], elevation[i + 2]);
    if (minE < 0.35) keep.push(f); // facce almeno in parte sotto (o a filo) del mare
  }

  const positions = new Float32Array(keep.length * 9);
  const depth = new Float32Array(keep.length * 3);
  const ice = new Float32Array(keep.length * 3);
  let o = 0;
  for (const f of keep) {
    for (let k = 0; k < 3; k++) {
      const i = f * 3 + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      positions[o * 3] = x; positions[o * 3 + 1] = y; positions[o * 3 + 2] = z;
      depth[o] = -elevation[i];
      ice[o] = seaIceAt(x / SEA_SURFACE_RADIUS, y / SEA_SURFACE_RADIUS, z / SEA_SURFACE_RADIUS);
      o++;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  geo.setAttribute('aIce', new THREE.BufferAttribute(ice, 1));
  geo.computeBoundingSphere();
  src.dispose();
  return geo;
}

/**
 * @param {boolean} lowQuality  niente onde di riva (≈12 ALU per pixel d'acqua,
 *        e l'acqua copre metà schermo); in bassa l'acqua è comunque ferma.
 */
function createWaterMaterial(lowQuality) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime:     { value: 0 },
      uSunDir:   { value: new THREE.Vector3(1, 1, 1).normalize() },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient:  { value: new THREE.Color(0.5, 0.5, 0.5) },
      uShallow:  { value: new THREE.Color(0x46d3d8) },
      uDeep:     { value: new THREE.Color(0x2272c4) },
      uFoam:     { value: new THREE.Color(0xf4fbff) },
      uIce:      { value: new THREE.Color(0xe6f2fb) },
    },
  ]);
  // Dopo il merge, che clona: le ombre delle nuvole devono restare gli stessi
  // oggetti di worldUniforms, aggiornati una volta per frame da CloudShadows.
  const defines = {};
  if (CLOUD_SHADOWS) {
    defines.LW_CLOUDS = '';
    uniforms.uCloudA = worldUniforms.uCloudA;
    uniforms.uCloudB = worldUniforms.uCloudB;
    uniforms.uCloudK = worldUniforms.uCloudK;
  }
  if (!lowQuality) defines.SHORE_WAVES = '';
  return new THREE.ShaderMaterial({
    uniforms,
    defines,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    extensions: { derivatives: true },
  });
}

// ── Atmosfera ────────────────────────────────────────────────────────────────

const ATM_VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vNormal   = normalize(mat3(modelMatrix) * normal);
    vec4 wp   = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const ATM_FRAG = /* glsl */`
  uniform vec3  uColor;
  uniform vec3  uSunDir;
  uniform float uIntensity;
  varying vec3  vNormal;
  varying vec3  vWorldPos;
  void main() {
    vec3 V = normalize(cameraPosition - vWorldPos);
    // BackSide: la normale punta all'interno → abs per un bagliore simmetrico
    float f = pow(1.0 - abs(dot(vNormal, V)), 2.6);
    // Più luminosa dal lato del sole, un filo di luce anche sul lato notte.
    float sun = 0.3 + 0.7 * smoothstep(-0.35, 0.6, dot(normalize(vWorldPos), uSunDir));
    float a = f * uIntensity * sun;
    gl_FragColor = vec4(uColor * a, a);
    // Vuoti nel render target del composer; a schermo (qualità bassa, o la
    // sonda F9 senza post-processing) codificano in sRGB come tutto il resto.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createAtmosphereMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor:     { value: new THREE.Color(0x9fdcff) },
      uSunDir:    { value: new THREE.Vector3(1, 1, 1).normalize() },
      uIntensity: { value: 0.55 },
    },
    vertexShader:   ATM_VERT,
    fragmentShader: ATM_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    // Tone mapping sì: nel render target del composer non cambia nulla (lo fa
    // il GradePass su tutta l'immagine), ma a schermo senza post-processing
    // l'alone usciva più chiaro che in partita, sommato dopo ACES.
  });
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * @param {THREE.Scene} scene
 * @param {object} [options]
 * @param {boolean} [options.lowQuality]  niente atmosfera, acqua ferma
 */
export function createPlanet(scene, options = {}) {
  const lowQuality = !!options.lowQuality;

  const { geo, elevation } = buildTerrainGeometry();
  // Indice dei triangoli renderizzati: da qui in poi chiunque debba appoggiare
  // qualcosa sul terreno interroga la superficie vera, non il campo analitico.
  buildPlanetSurfaceIndex(geo);

  // Ombre delle nuvole e aloni dei paesi: per vertice, nessun costo per pixel
  // oltre a una moltiplicazione (vedi worldShaders.js).
  const mat = patchWorldMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }), { clouds: true, glow: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);

  const waterMat = createWaterMaterial(lowQuality);
  const water = new THREE.Mesh(buildWaterGeometry(elevation), waterMat);
  water.renderOrder = 1;
  water.matrixAutoUpdate = false;
  scene.add(water);

  const atmosphereMat = createAtmosphereMaterial();
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(PLANET_RADIUS + 2.8, 64, 40), atmosphereMat);
  atmosphere.renderOrder = 2;
  atmosphere.visible = !lowQuality;
  atmosphere.matrixAutoUpdate = false;
  scene.add(atmosphere);

  const _tmp = new THREE.Color();

  /**
   * @param {number} delta
   * @param {{sun:THREE.DirectionalLight, ambient:THREE.AmbientLight, fill?:THREE.DirectionalLight}} [lights]
   * @param {THREE.Color} [skyTint] colore del cielo all'orizzonte (tinge l'atmosfera)
   */
  function update(delta, lights, skyTint) {
    const u = waterMat.uniforms;
    if (!lowQuality) u.uTime.value += delta;
    if (lights?.sun) {
      u.uSunDir.value.copy(lights.sun.position).normalize();
      u.uSunColor.value.copy(lights.sun.color).multiplyScalar(lights.sun.intensity);
      atmosphereMat.uniforms.uSunDir.value.copy(u.uSunDir.value);
    }
    if (lights?.ambient) {
      u.uAmbient.value.copy(lights.ambient.color).multiplyScalar(lights.ambient.intensity);
      if (lights.fill) u.uAmbient.value.add(_tmp.copy(lights.fill.color).multiplyScalar(lights.fill.intensity * 0.5));
    }
    if (skyTint) {
      atmosphereMat.uniforms.uColor.value.set(0x9fdcff).lerp(skyTint, 0.35);
    }
  }

  return { mesh, water, atmosphere, update };
}
