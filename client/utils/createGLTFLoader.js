import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Allineare a `dependencies.three` in package.json (decoder Draco da jsDelivr). */
const THREE_NPM_VERSION = '0.160.0';

let _draco = null;

function getDracoLoader() {
  if (!_draco) {
    _draco = new DRACOLoader();
    _draco.setDecoderPath(
      `https://cdn.jsdelivr.net/npm/three@${THREE_NPM_VERSION}/examples/jsm/libs/draco/gltf/`,
    );
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
