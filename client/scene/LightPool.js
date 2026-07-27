import * as THREE from 'three';
import { allowTinyPointLights } from '../utils/performanceProfile.js';

/**
 * Pool di PointLight a numero FISSO.
 *
 * Perché esiste (causa storica dei "rallentamenti improvvisi")
 * -----------------------------------------------------------
 * In Three.js la program cache key di ogni materiale include il *numero* di
 * luci della scena. Quando quel numero cambia, `lights.state.version` avanza e
 * al frame successivo ogni materiale illuminato ricompila il proprio shader:
 * una pausa da decine o centinaia di millisecondi, in mezzo alla partita.
 *
 * Nel gioco quel numero cambiava di continuo, perché `projectObject()` scarta
 * gli oggetti invisibili — e con loro le luci che stanno sotto:
 *  - due PointLight per aereo, che sparivano a ogni morte e tornavano al respawn;
 *  - una PointLight per beacon di torretta, all'atto della conquista;
 *  - una PointLight creata e distrutta a ogni singolo colpo di torretta.
 * Ogni conteggio mai visto prima = ricompilazione completa di tutti gli shader.
 * In un deathmatch il conteggio non si stabilizza mai, quindi le pause
 * continuavano a ripresentarsi per tutta la sessione.
 *
 * Qui le luci vengono create una volta sola, restano per sempre nella scena e
 * non vengono mai nascoste: chi ne ha bisogno prende in prestito uno slot e ne
 * imposta posizione, colore e intensità. Intensità 0 = spenta ma ancora
 * contata, quindi il conteggio non cambia mai e non si ricompila più nulla.
 *
 * Il pool è volutamente minuscolo: ogni PointLight presente costa un ciclo in
 * più nel fragment shader di *ogni* pixel illuminato, quindi tenerne trenta
 * "spente" sarebbe solo un altro modo di rallentare il gioco. Gli slot vanno a
 * chi si vede davvero (aereo locale e vampata di sparo); per beacon e aerei
 * remoti resta il puntino additivo con bloom, che è ciò che si nota da lontano.
 */

/** 2 luci alari dell'aereo locale + 2 muzzle flash alternati. */
const POOL_SIZE = 4;

const _worldPos = new THREE.Vector3();

class LightSlot {
  constructor(light) {
    this.light = light;
    this.inUse = false;
  }

  /** Posiziona e accende la luce (coordinate world). */
  set(position, color, intensity) {
    this.light.position.copy(position);
    if (color !== undefined && color !== null) this.light.color.set(color);
    this.light.intensity = Math.max(0, intensity);
  }

  /** Posiziona partendo da coordinate locali di un oggetto. */
  setFromLocal(object, localPos, color, intensity) {
    _worldPos.copy(localPos);
    object.localToWorld(_worldPos);
    this.set(_worldPos, color, intensity);
  }

  /** Regola raggio e caduta della luce. */
  configure(distance, decay) {
    this.light.distance = distance;
    this.light.decay = decay;
  }

  off() {
    this.light.intensity = 0;
  }
}

class LightPool {
  constructor() {
    this.enabled = false;
    this.slots = [];
  }

  /**
   * Crea le luci e le aggiunge alla scena. Da chiamare una volta sola, prima
   * del primo render (e comunque prima di `renderer.compile`).
   */
  init(scene) {
    if (this.slots.length > 0) return;
    this.enabled = allowTinyPointLights();
    if (!this.enabled) return;

    for (let i = 0; i < POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 0.55, 2);
      light.name = `pooled-point-${i}`;
      // Mai nascondere e mai rimuovere: cambierebbe il conteggio luci.
      light.visible = true;
      scene.add(light);
      this.slots.push(new LightSlot(light));
    }
  }

  /**
   * Prende uno slot libero, o `null` se il pool è esaurito o disabilitato.
   * Un `null` non è un errore: il chiamante deve funzionare lo stesso, senza
   * la luce puntiforme.
   */
  acquire(distance = 0.55, decay = 2) {
    if (!this.enabled) return null;
    for (const slot of this.slots) {
      if (slot.inUse) continue;
      slot.inUse = true;
      slot.configure(distance, decay);
      slot.light.intensity = 0;
      return slot;
    }
    return null;
  }

  /** Restituisce sempre `null`, così si può scrivere `s = pool.release(s)`. */
  release(slot) {
    if (!slot) return null;
    slot.off();
    slot.inUse = false;
    return null;
  }
}

export const lightPool = new LightPool();
