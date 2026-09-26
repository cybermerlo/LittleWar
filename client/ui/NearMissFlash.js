import * as THREE from 'three';

/**
 * Lampo rosso sul bordo dello schermo quando un proiettile nemico passa
 * vicino, dal lato da cui è arrivato: il pericolo si percepisce prima del
 * colpo fatale.
 *
 * Un solo elemento creato da qui (niente markup in index.html), toccato solo
 * all'evento: il gradiente cambia a ogni quasi-colpo e la dissolvenza è una
 * transizione CSS di opacità, che il compositor gestisce senza layout.
 */

const _v = new THREE.Vector3();

export class NearMissFlash {
  constructor() {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '8',
      opacity: '0',
      transition: 'opacity 0.45s ease-out',
    });
    document.body.appendChild(el);
    this._el = el;
    this._raf = 0;
  }

  /**
   * @param {THREE.Vector3} point  punto (world) in cui il proiettile è passato
   * @param {THREE.Camera} camera
   */
  show(point, camera) {
    // Direzione del punto sul piano dello schermo, in spazio camera: anche un
    // colpo alle spalle (fuori inquadratura) indica il lato giusto.
    _v.copy(point).applyMatrix4(camera.matrixWorldInverse);
    let x = _v.x, y = _v.y;
    const len = Math.hypot(x, y) || 1;
    x /= len; y /= len;
    const cx = 50 + x * 55;
    const cy = 50 - y * 55;
    this._el.style.background =
      `radial-gradient(ellipse at ${cx.toFixed(1)}% ${cy.toFixed(1)}%, ` +
      'rgba(255, 70, 50, 0.42), rgba(255, 70, 50, 0.12) 22%, transparent 42%)';
    // Accensione istantanea, poi dissolvenza: la transizione vale solo per lo spegnimento.
    this._el.style.transition = 'none';
    this._el.style.opacity = '1';
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      this._el.style.transition = 'opacity 0.45s ease-out';
      this._el.style.opacity = '0';
    });
  }

  hide() {
    cancelAnimationFrame(this._raf);
    this._el.style.opacity = '0';
  }
}
