import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import { MOUNTAIN_HEIGHT, SEA_DEPTH } from '../../shared/planetField.js';

/**
 * Biomi del pianeta: decidono il colore di ogni faccia del terreno e dove
 * nascono boschi e paesi (Terrain.js). Sono solo estetica, quindi vivono nel
 * client: il server conosce la forma (planetField) ma non gli serve sapere
 * dove c'è il deserto.
 *
 * Tre ingredienti per punto:
 *  - quota (unità sul livello del mare) e pendenza della faccia;
 *  - temperatura: cala con la latitudine e con la quota → calotte polari,
 *    tundra, cime innevate;
 *  - umidità: un rumore a bassa frequenza → deserti, savane, prati, foreste.
 */

export const BIOME = {
  SEA: 0,
  BEACH: 1,
  GRASS: 2,
  FOREST: 3,
  SAVANNA: 4,
  DESERT: 5,
  TUNDRA: 6,
  SNOW: 7,
  ROCK: 8,
};

const moistureNoise = createNoise3D(mulberry32(777));
const tempNoise = createNoise3D(mulberry32(31337));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Umidità −1..1 (bassa frequenza: regioni intere, non macchie). */
export function moistureAt(x, y, z) {
  return moistureNoise(x * 1.6, y * 1.6, z * 1.6) * 0.8 + moistureNoise(x * 4.1, y * 4.1, z * 4.1) * 0.2;
}

/** Temperatura 0..1: 1 all'equatore in pianura, 0 ai poli e sulle vette. */
export function temperatureAt(x, y, z, elevation) {
  const lat = Math.abs(y);
  const jitter = tempNoise(x * 3, y * 3, z * 3) * 0.06;
  return THREE.MathUtils.clamp(1 - Math.pow(lat, 1.6) * 1.15 - Math.max(0, elevation) / MOUNTAIN_HEIGHT * 0.55 + jitter, 0, 1);
}

/**
 * Bioma in un punto.
 * @param {number} x @param {number} y @param {number} z  direzione unitaria
 * @param {number} elevation  quota sul mare (unità mondo)
 * @param {number} slope      0 = piano, 1 = parete
 */
export function biomeAt(x, y, z, elevation, slope) {
  if (elevation < 0) return BIOME.SEA;
  const temp = temperatureAt(x, y, z, elevation);
  if (temp < 0.2) return BIOME.SNOW;
  if (elevation > MOUNTAIN_HEIGHT * 0.52 || slope > 0.42) return BIOME.ROCK;
  if (elevation < 0.42) return temp < 0.32 ? BIOME.TUNDRA : BIOME.BEACH;
  if (temp < 0.34) return BIOME.TUNDRA;
  const wet = moistureAt(x, y, z);
  if (temp > 0.64 && wet < -0.3) return BIOME.DESERT;
  if (temp > 0.55 && wet < -0.1) return BIOME.SAVANNA;
  if (wet > 0.16) return BIOME.FOREST;
  return BIOME.GRASS;
}

// Palette (sRGB): vivace, da cartone, ma non satura al massimo.
const C = (hex) => new THREE.Color(hex);
const PALETTE = {
  shelfSand: C(0xe8dba2),
  shelf: C(0x4fc9c0),
  deep: C(0x1f5e8c),
  abyss: C(0x173e6b),
  beach: C(0xf2dea0),
  grass: C(0x7ccc56),
  grassDark: C(0x68b848),
  forest: C(0x3f9142),
  forestDark: C(0x317a38),
  savanna: C(0xc6c65c),
  desert: C(0xecd08e),
  desertDark: C(0xdcb574),
  tundra: C(0xa8b98b),
  rock: C(0x9a8876),
  rockDark: C(0x7c6c5f),
  snow: C(0xf3f7fc),
  ice: C(0xdbeaf7),
};

/**
 * Colore (lineare) di una faccia del terreno.
 * @param {THREE.Color} out
 * @param {number} rand  0..1, fisso per faccia: piccole variazioni di tono
 */
export function faceColor(out, x, y, z, elevation, slope, rand) {
  const biome = biomeAt(x, y, z, elevation, slope);
  switch (biome) {
    case BIOME.SEA: {
      const d = THREE.MathUtils.clamp(-elevation / SEA_DEPTH, 0, 1);
      if (d < 0.12) out.copy(PALETTE.shelfSand).lerp(PALETTE.shelf, d / 0.12);
      else if (d < 0.55) out.copy(PALETTE.shelf).lerp(PALETTE.deep, (d - 0.12) / 0.43);
      else out.copy(PALETTE.deep).lerp(PALETTE.abyss, (d - 0.55) / 0.45);
      break;
    }
    case BIOME.BEACH: out.copy(PALETTE.beach); break;
    case BIOME.GRASS: out.copy(PALETTE.grass).lerp(PALETTE.grassDark, rand); break;
    case BIOME.FOREST: out.copy(PALETTE.forest).lerp(PALETTE.forestDark, rand); break;
    case BIOME.SAVANNA: out.copy(PALETTE.savanna).lerp(PALETTE.grass, rand * 0.35); break;
    case BIOME.DESERT: out.copy(PALETTE.desert).lerp(PALETTE.desertDark, rand * 0.8); break;
    case BIOME.TUNDRA: out.copy(PALETTE.tundra).lerp(PALETTE.rock, rand * 0.3); break;
    case BIOME.SNOW: out.copy(PALETTE.snow).lerp(PALETTE.ice, rand * 0.6); break;
    case BIOME.ROCK: {
      // Le cime più alte prendono la neve anche in pianura calda.
      if (elevation > MOUNTAIN_HEIGHT * 0.78 && slope < 0.5) out.copy(PALETTE.snow).lerp(PALETTE.ice, rand * 0.4);
      else out.copy(PALETTE.rock).lerp(PALETTE.rockDark, rand);
      break;
    }
    default: out.copy(PALETTE.grass);
  }
  // Leggera variazione per faccia: è ciò che fa leggere le sfaccettature.
  out.multiplyScalar(0.94 + rand * 0.1);
  return biome;
}

/** Hash deterministico 0..1 di un intero (variazione per faccia). */
export function hash01(i) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
