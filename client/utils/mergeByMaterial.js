import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();

/**
 * Copia una geometria glTF in attributi Float32 semplici.
 *
 * I GLB decimati usano KHR_mesh_quantization (posizioni in int16
 * normalizzati, con la scala nel nodo): applicarci una matrice scriverebbe
 * valori fuori da [-1, 1] dentro un Int16Array, cioè li troncherebbe.
 * getX/getY/getZ restituiscono già i valori denormalizzati.
 */
function toPlainGeometry(src, keepUv) {
  const geo = new THREE.BufferGeometry();
  const pos = src.getAttribute('position');
  const p = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    p[i * 3] = pos.getX(i); p[i * 3 + 1] = pos.getY(i); p[i * 3 + 2] = pos.getZ(i);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));

  const nrm = src.getAttribute('normal');
  if (nrm) {
    const n = new Float32Array(nrm.count * 3);
    for (let i = 0; i < nrm.count; i++) {
      n[i * 3] = nrm.getX(i); n[i * 3 + 1] = nrm.getY(i); n[i * 3 + 2] = nrm.getZ(i);
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  }

  if (keepUv) {
    const uv = src.getAttribute('uv');
    const t = new Float32Array(pos.count * 2);
    if (uv) for (let i = 0; i < uv.count; i++) { t[i * 2] = uv.getX(i); t[i * 2 + 1] = uv.getY(i); }
    geo.setAttribute('uv', new THREE.BufferAttribute(t, 2));
  }

  if (src.index) geo.setIndex(Array.from(src.index.array));
  if (!nrm) geo.computeVertexNormals();
  return geo;
}

/**
 * Fonde un insieme di mesh statiche in una mesh per materiale.
 *
 * Le geometrie vengono portate nel sistema di riferimento `frameInverse`
 * (l'inversa della matrice world del nodo che conterrà le mesh fuse) e unite.
 * I materiali restano gli stessi oggetti — con i loro nomi — così chi li
 * cerca per nome (tinta del proprietario) continua a trovarli.
 *
 * @param {THREE.Mesh[]} meshes
 * @param {THREE.Matrix4} frameInverse
 * @param {object} [o]
 * @param {(m: THREE.Material) => THREE.Material} [o.materialFor]  sostituzione di stile
 * @param {Object<string, THREE.BufferGeometry[]>} [o.extra]  geometrie aggiuntive (già nel frame) per nome di materiale
 * @returns {THREE.Mesh[]}
 */
export function mergeMeshesByMaterial(meshes, frameInverse, o = {}) {
  const materialFor = o.materialFor ?? ((m) => m);
  const byMat = new Map();

  for (const mesh of meshes) {
    if (!mesh.geometry || !mesh.material || Array.isArray(mesh.material)) continue;
    const mat = materialFor(mesh.material);
    mesh.updateWorldMatrix(true, false);
    const geo = toPlainGeometry(mesh.geometry, !!mat.map);
    geo.applyMatrix4(_m.multiplyMatrices(frameInverse, mesh.matrixWorld));
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(geo);
  }

  if (o.extra) {
    for (const [name, geos] of Object.entries(o.extra)) {
      const mat = [...byMat.keys()].find((m) => m.name === name);
      if (!mat) continue;
      for (const g of geos) byMat.get(mat).push(toPlainGeometry(g, !!mat.map));
    }
  }

  const out = [];
  for (const [mat, geos] of byMat) {
    // mergeGeometries vuole tutti indicizzati o tutti no.
    const mixed = geos.some((g) => !g.index) && geos.some((g) => g.index);
    const parts = mixed ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos;
    const merged = mergeGeometries(parts, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const m = new THREE.Mesh(merged, mat);
    m.name = mat.name || '';
    out.push(m);
  }
  return out;
}
