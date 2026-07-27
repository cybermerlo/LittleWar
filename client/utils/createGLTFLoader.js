import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Decoder Draco servito dal nostro dominio (`public/draco/`, copiato da
 * `three/examples/jsm/libs/draco/gltf/`).
 *
 * Prima arrivava da jsDelivr. Dipendere da una CDN esterna per decomprimere i
 * modelli significa che, se quella è lenta o irraggiungibile, **tutti** i GLB
 * compressi falliscono in silenzio e il gioco ricade sui proxy procedurali:
 * niente errori, solo un mondo diverso da quello previsto — un guasto difficile
 * da riconoscere proprio perché non sembra un guasto. In locale il decoder pesa
 * 750 KB, viene messo in cache dal browser e funziona anche offline.
 *
 * Se si aggiorna `three` in package.json, ricopiare i file:
 *   cp node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.{js,wasm} \
 *      node_modules/three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js \
 *      public/draco/
 */
const DRACO_DECODER_PATH = '/draco/';

let _draco = null;

function getDracoLoader() {
  if (!_draco) {
    _draco = new DRACOLoader();
    _draco.setDecoderPath(DRACO_DECODER_PATH);
  }
  return _draco;
}

/**
 * @param {import('three').LoadingManager | undefined} manager
 * @returns {GLTFLoader}
 */
export function createGLTFLoader(manager) {
  const loader = new GLTFLoader(manager);
  loader.setDRACOLoader(getDracoLoader());
  return loader;
}
