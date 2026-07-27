/**
 * Decima i modelli GLB pesanti del terreno e dei veicoli.
 *
 * I modelli hanno un aspetto low-poly ma non lo sono: una casa costava 7.765
 * triangoli e un ospedale 16.996, per oggetti alti 2-4 unità su un pianeta di
 * raggio 50 che si guardano quasi sempre dall'alto e da lontano. Con 80 case e
 * 12 ospedali facevano da soli mezzo milione di triangoli per frame.
 *
 * Usa meshoptimizer (via gltf-transform) che preserva la silhouette molto
 * meglio di una decimazione ingenua. `weld` è obbligatorio prima di `simplify`:
 * senza vertici saldati il semplificatore non trova spigoli da collassare.
 *
 * Gli originali restano in `public/models/original/` — la decimazione è a
 * perdere, e senza copia non si può ritarare un rapporto sbagliato.
 *
 *   node tools/decimate-models.mjs [--dry]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, dedup, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import draco3d from 'draco3dgltf';

/**
 * Rapporto di semplificazione per modello: frazione di triangoli da tenere.
 * Ritoccare qui e rilanciare; gli originali non vengono toccati.
 */
const TARGETS = [
  // props del terreno: tantissime istanze, sempre lontane → tagliare forte.
  // `error` è la deviazione massima ammessa in frazione della dimensione del
  // modello; è lui, non `ratio`, a fermare il semplificatore quando il modello
  // ha molte parti staccate (meshopt non collassa attraverso i bordi aperti).
  { file: 'building-house.glb',  ratio: 0.08, error: 0.06 },
  { file: 'hospital.glb',        ratio: 0.06, error: 0.06 },
  // torrette: poche istanze, ma la conquistata è un oggetto "eroe" da vicino
  { file: 'torretta_cesare.glb', ratio: 0.20, error: 0.03 },
  { file: 'pre_torretta.glb',    ratio: 0.20, error: 0.03 },
];

/**
 * NON decimati, e perché.
 *
 * - `spitfire.glb`: ha 1.91 vertici per triangolo, cioè vertici spezzati da
 *   normali/UV per faccia. Meshopt non collassa spigoli di bordo, e in una
 *   mesh così ogni spigolo è di bordo: si ferma al 4% di riduzione. Per
 *   guadagnarci davvero servirebbe togliere le normali, saldare per sola
 *   posizione, semplificare e rigenerarle — ma l'aereo del giocatore sta
 *   sempre al centro dello schermo, quindi è rischio visivo per un ritorno
 *   che conta solo con la partita piena. Da valutare a parte.
 * - alberi e powerup: già leggeri (56–694 triangoli), non c'è nulla da togliere.
 */

const SRC_DIR = 'public/models';
const BACKUP_DIR = 'public/models/original';
const DRY = process.argv.includes('--dry');

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

await MeshoptSimplifier.ready;
mkdirSync(BACKUP_DIR, { recursive: true });

function countTriangles(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      n += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
    }
  }
  return Math.round(n);
}

/** Nomi che il codice del gioco cerca per nome: non devono sparire. */
function collectNames(doc) {
  return {
    nodes: doc.getRoot().listNodes().map(n => n.getName()).filter(Boolean),
    materials: doc.getRoot().listMaterials().map(m => m.getName()).filter(Boolean),
    animations: doc.getRoot().listAnimations().map(a => a.getName()).filter(Boolean),
  };
}

console.log('file'.padEnd(24), 'prima'.padStart(8), 'dopo'.padStart(8), 'ridotto'.padStart(8), '  KB');
console.log('-'.repeat(64));

for (const { file, ratio, error } of TARGETS) {
  const src = `${SRC_DIR}/${file}`;
  const backup = `${BACKUP_DIR}/${file}`;
  if (!existsSync(src)) { console.log(`${file}: assente, salto`); continue; }

  // La prima esecuzione salva l'originale; le successive ripartono da quello,
  // così rilanciare lo script non decima un modello già decimato.
  if (!existsSync(backup)) copyFileSync(src, backup);

  const doc = await io.read(backup);
  const before = countTriangles(doc);
  const namesBefore = collectNames(doc);

  await doc.transform(
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error }),
    dedup(),
    // `prune` senza opzioni rimuoverebbe i nodi vuoti — ma `Turret_Pivot` è
    // proprio un nodo vuoto usato come pivot dal codice, quindi va tenuto.
    prune({ keepLeaves: true }),
  );

  const after = countTriangles(doc);
  const namesAfter = collectNames(doc);

  // Verifica che nulla di ciò che il codice cerca per nome sia sparito
  const lost = {
    nodes: namesBefore.nodes.filter(n => !namesAfter.nodes.includes(n)),
    materials: namesBefore.materials.filter(m => !namesAfter.materials.includes(m)),
    animations: namesBefore.animations.filter(a => !namesAfter.animations.includes(a)),
  };

  if (!DRY) await io.write(src, doc);
  const kb = existsSync(src) ? Math.round(statSync(src).size / 1024) : 0;

  const pct = ((1 - after / before) * 100).toFixed(0);
  console.log(
    file.padEnd(24),
    String(before).padStart(8),
    String(after).padStart(8),
    `${pct}%`.padStart(8),
    ` ${kb}`,
  );
  for (const [kind, list] of Object.entries(lost)) {
    if (list.length) console.log(`   ⚠ ${kind} persi: ${list.join(', ')}`);
  }
}

console.log('\nOriginali conservati in', BACKUP_DIR);
if (DRY) console.log('(--dry: nessun file scritto)');
