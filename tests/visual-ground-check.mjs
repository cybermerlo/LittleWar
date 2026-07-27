/**
 * Verifica visiva e numerica dell'appoggio degli oggetti sul terreno.
 *
 * Avvia il gioco in modalità singleplayer in un Chromium headless, misura la
 * distanza di ogni oggetto statico dalla superficie renderizzata e salva
 * qualche screenshot ravvicinato.
 *
 * Prerequisiti: `npm start` e `npx vite` già in esecuzione, più Playwright
 * (`npm i --no-save playwright`; volutamente fuori da package.json, così il
 * deploy non se lo porta dietro).
 *
 *   node tests/visual-ground-check.mjs [cartella-output]
 *
 * Cosa guardare: `quota locale base` deve restare ~0. Se non lo è, il problema
 * non è il terreno ma il modello (pivot fuori posto) o la rotazione applicata.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'tests/out';
const URL = process.env.LITTLEWAR_URL || 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });

/** Trova il Chromium preinstallato senza dipendere dal numero di build. */
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .filter((d) => d.startsWith('chromium'))
    .map((d) => join(root, d, 'chrome-linux', 'chrome'))
    .filter((p) => existsSync(p));
  return candidates[0];
}

const browser = await chromium.launch({
  // preserveDrawingBuffer non serve: si legge il canvas nello stesso task del render
  executablePath: findChromium(),
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });

// Verifica che WebGL sia realmente disponibile prima di dare la colpa al gioco.
const glInfo = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return null;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'webgl ok';
});
console.log('WebGL:', glInfo ?? 'NON DISPONIBILE');
if (!glInfo) {
  console.log(logs.join('\n'));
  await browser.close();
  process.exit(2);
}

await page.fill('#nickname', 'GroundCheck');
await page.click('#solo-btn');
await page.waitForSelector('body.in-game', { timeout: 20000 });

// Attende la costruzione del terreno invece di sperare in un timeout fisso:
// il caricamento dei GLB (e del decoder Draco, che sta su CDN) può essere lento.
await page.waitForFunction(
  () => window.__lwDebug?.scene?.children?.some(o => o.userData?.isTerrainGroup),
  null,
  { timeout: 60000 },
).catch(() => console.warn('ATTENZIONE: terreno non costruito entro 60 s'));
await page.waitForTimeout(1500);

await page.screenshot({ path: `${OUT}/01-partita.png` });

/**
 * Misura, per ogni mesh statica del terreno e per ogni torretta, quanto il
 * punto più basso si discosta dalla superficie renderizzata sotto di esso.
 * Negativo = sepolto, positivo = sospeso in aria.
 */
const report = await page.evaluate(async () => {
  const THREE = window.__lwDebug?.THREE;
  const scene = window.__lwDebug?.scene;
  const sampleGround = window.__lwDebug?.sampleGround;
  if (!THREE || !scene || !sampleGround) return { error: 'hook di debug assente' };

  const hit = window.__lwDebug.makeSurfaceHit();
  const results = { trees: [], turrets: [], rings: [] };
  const v = new THREE.Vector3();

  const groundDelta = (worldPoint) => {
    sampleGround(worldPoint, hit);
    // proiezione lungo il radiale: quanto sta sopra (o sotto) il terreno
    return worldPoint.length() - hit.radius;
  };

  // Torrette: base del gruppo
  for (const obj of scene.children) {
    if (!obj.userData?.isTurretGroup) continue;
    v.setFromMatrixPosition(obj.matrixWorld);
    results.turrets.push(groundDelta(v));
  }

  // Terreno statico: usa i punti d'appoggio registrati durante il piazzamento
  // (dopo il merge le singole mesh non esistono più).
  const terrain = scene.children.find(o => o.userData?.isTerrainGroup);
  if (terrain) {
    let drawCalls = 0, tris = 0;
    for (const mesh of terrain.children) {
      drawCalls++;
      tris += mesh.geometry.getAttribute('position').count / 3;
    }
    results.drawCalls = drawCalls;
    results.triangles = Math.round(tris);

    // `baseDelta` è la distanza dal terreno del vertice più basso del modello:
    // è quello che l'occhio vede toccare (o non toccare) il suolo, mentre
    // l'origine del gruppo è per definizione dove l'abbiamo messa noi.
    results.buildings = [];
    results.localMinY = { tree: [], building: [] };
    for (const p of terrain.userData.placements ?? []) {
      const d = p.baseDelta ?? groundDelta(v.copy(p.point));
      (p.kind === 'tree' ? results.trees : results.buildings).push(d);
      results.localMinY[p.kind]?.push(p.localMinY ?? 0);
    }
  }

  results.lightCount = scene.children.filter(o => o.isLight).length;
  return results;
});

const stats = (arr) => {
  if (!arr?.length) return 'n/d';
  const s = [...arr].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return `min ${s[0].toFixed(3)} | p05 ${p(0.05).toFixed(3)} | mediana ${p(0.5).toFixed(3)} | max ${s[s.length - 1].toFixed(3)}`;
};

console.log('\n── Appoggio sul terreno (unità mondo, negativo = sotto la superficie) ──');
if (report.error) {
  console.log('  ', report.error);
} else {
  console.log('  basi alberi   :', stats(report.trees), `(${report.trees?.length ?? 0})`);
  console.log('  basi edifici  :', stats(report.buildings), `(${report.buildings?.length ?? 0})`);
  console.log('  basi torrette :', stats(report.turrets), `(${report.turrets?.length ?? 0})`);
  console.log('  quota locale base alberi :', stats(report.localMinY?.tree));
  console.log('  quota locale base edifici:', stats(report.localMinY?.building), '(deve essere ~0)');
  console.log('  draw call terreno:', report.drawCalls, '| triangoli:', report.triangles);
  console.log('  luci in scena    :', report.lightCount, '(deve restare costante per tutta la partita)');
}

// ── Inquadrature ravvicinate deterministiche ─────────────────────────────────
// Il gioco muove la camera da solo (e il giocatore può morire): per guardare
// davvero il terreno si renderizza a mano da posizioni scelte, catturando il
// framebuffer nello stesso task JS del render.

const shots = await page.evaluate(() => {
  const { THREE, scene, renderer, sampleGround, makeSurfaceHit } = window.__lwDebug;
  const hit = makeSurfaceHit();
  const out = [];

  /** Camera radente puntata su un punto della superficie. */
  const shoot = (name, targetPoint, distance = 9, elevation = 3.5) => {
    const cam = new THREE.PerspectiveCamera(55, 1280 / 720, 0.1, 1000);
    const up = targetPoint.clone().normalize();
    const ref = new THREE.Vector3(Math.abs(up.y) < 0.9 ? 0 : 1, Math.abs(up.y) < 0.9 ? 1 : 0, 0);
    const side = new THREE.Vector3().crossVectors(up, ref).normalize();
    cam.position.copy(targetPoint).addScaledVector(side, distance).addScaledVector(up, elevation);
    cam.up.copy(up);
    cam.lookAt(targetPoint);
    renderer.render(scene, cam);
    out.push({ name, data: renderer.domElement.toDataURL('image/png') });
  };

  const terrain = scene.children.find(o => o.userData?.isTerrainGroup);
  const places = terrain?.userData?.placements ?? [];
  const trees = places.filter(p => p.kind === 'tree');
  const builds = places.filter(p => p.kind === 'building');
  const turret = scene.children.find(o => o.userData?.isTurretGroup);

  if (trees.length) {
    // Il punto con più vicini intorno: una macchia di bosco, non un albero isolato.
    let best = trees[0], bestN = -1;
    for (const t of trees) {
      let n = 0;
      for (const u of trees) if (t.point.distanceToSquared(u.point) < 64) n++;
      if (n > bestN) { bestN = n; best = t; }
    }
    shoot('alberi', new THREE.Vector3().copy(best.point), 7, 2.2);
  }
  if (builds.length) shoot('edifici', new THREE.Vector3().copy(builds[0].point), 8, 3);
  if (turret) {
    const p = new THREE.Vector3().setFromMatrixPosition(turret.matrixWorld);
    shoot('torretta', p, 13, 5);
  }

  // Colpo di controllo: profilo del terreno con l'orizzonte, per vedere se
  // qualcosa fluttua contro il cielo.
  if (trees.length) {
    const p = new THREE.Vector3().copy(trees[0].point);
    sampleGround(p, hit);
    shoot('profilo', hit.point.clone(), 16, 0.6);
  }

  return out;
});

for (const s of shots) {
  const b64 = s.data.replace(/^data:image\/png;base64,/, '');
  writeFileSync(`${OUT}/${s.name}.png`, Buffer.from(b64, 'base64'));
}
console.log('\nScreenshot:', shots.map(s => `${OUT}/${s.name}.png`).join(', '));

if (logs.length) {
  console.log('\n── Console della pagina ──');
  console.log(logs.slice(0, 40).join('\n'));
}

await browser.close();
