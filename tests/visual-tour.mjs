/**
 * Giro fotografico del gioco per le verifiche visive.
 *
 * Avvia una partita in singolo in Chromium headless e salva una serie fissa di
 * inquadrature: lobby, partita di giorno, raffica di colpi, tramonto, notte,
 * torretta da vicino, pianeta intero, esplosione. Le inquadrature "a camera
 * libera" passano dal composer, quindi includono bloom e tone mapping come in
 * partita.
 *
 * Prerequisiti: `npm start` e `npx vite` in esecuzione, più Playwright
 * (`npm i --no-save playwright`, fuori da package.json come per
 * visual-ground-check.mjs).
 *
 *   node tests/visual-tour.mjs [cartella-output]
 *
 * Attenzione: Chromium senza GPU gira a pochi fps. Le immagini servono a
 * giudicare forme, colori e composizione, non la fluidità.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'tests/out/tour';
const URL = process.env.LITTLEWAR_URL || 'http://localhost:5173/';
const W = 1280, H = 720;
mkdirSync(OUT, { recursive: true });

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((d) => d.startsWith('chromium'))
    .map((d) => join(root, d, 'chrome-linux', 'chrome'))
    .find((p) => existsSync(p));
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => { if (m.type() !== 'debug' && !m.text().includes('CERT')) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const shot = async (name) => { await page.screenshot({ path: join(OUT, `${name}.png`) }); console.log('  ', name); };

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await shot('01-lobby');

await page.fill('#nickname', 'Tour');
await page.click('#solo-btn');
await page.waitForSelector('body.in-game', { timeout: 30000 });
await page.waitForFunction(() => window.__lwDebug?.scene?.children?.some(o => o.userData?.isTerrainGroup), null, { timeout: 90000 });
await page.evaluate(() => window.__lwDebug.sky.setPhase(0.35));
await page.waitForTimeout(1200);
await shot('02-giorno');

for (let i = 0; i < 4; i++) {
  await page.mouse.move(W / 2, H / 2 - 80);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(160);
}
await shot('03-raffica');

await page.evaluate(() => window.__lwDebug.sky.setPhase(1.35));
await page.waitForTimeout(900);
await shot('04-tramonto');

await page.evaluate(() => window.__lwDebug.sky.setPhase(3.1));
await page.waitForTimeout(900);
await shot('05-notte');

// Inquadrature a camera libera, attraverso il composer (bloom compreso).
await page.evaluate(() => window.__lwDebug.sky.setPhase(0.35));
await page.waitForTimeout(600);
const free = await page.evaluate(({ W, H }) => {
  const d = window.__lwDebug;
  const { THREE, scene, renderer, composer } = d;
  const out = [];
  const render = (name, pos, look, up) => {
    const cam = new THREE.PerspectiveCamera(55, W / H, 0.1, 1000);
    cam.position.copy(pos);
    cam.up.copy(up ?? new THREE.Vector3(0, 1, 0));
    cam.lookAt(look);
    const rp = composer.passes[0];
    const prev = rp.camera;
    rp.camera = cam;
    composer.render();
    rp.camera = prev;
    out.push({ name, data: renderer.domElement.toDataURL('image/png') });
  };
  const turret = scene.children.find((o) => o.userData?.isTurretGroup);
  if (turret) {
    const p = new THREE.Vector3().setFromMatrixPosition(turret.matrixWorld);
    const up = p.clone().normalize();
    const ref = new THREE.Vector3(Math.abs(up.y) < 0.9 ? 0 : 1, Math.abs(up.y) < 0.9 ? 1 : 0, 0);
    const side = new THREE.Vector3().crossVectors(up, ref).normalize();
    render('06-torretta', p.clone().addScaledVector(side, 13).addScaledVector(up, 6), p, up);
  }
  const me = d.localPos;
  if (me) {
    const up = me.clone().normalize();
    render('07-pianeta', up.clone().multiplyScalar(150).add(new THREE.Vector3(20, 10, 0)), new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  }
  return out;
}, { W, H });
for (const f of free) { writeFileSync(join(OUT, `${f.name}.png`), Buffer.from(f.data.split(',')[1], 'base64')); console.log('  ', f.name); }

await page.evaluate(() => {
  const d = window.__lwDebug;
  const fwd = new d.THREE.Vector3(0, 0, -1).applyQuaternion(d.camera.quaternion);
  d.spawnExplosionAt(d.camera.position.clone().addScaledVector(fwd, 16), { scale: 1 });
});
await page.waitForTimeout(260);
await shot('08-esplosione');

if (logs.length) console.log('\n── Console ──\n' + logs.slice(0, 30).join('\n'));
await browser.close();
