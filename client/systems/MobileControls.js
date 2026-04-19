/**
 * Controlli touch per mobile: un joystick virtuale sinistro (sterzata analogica,
 * alternativa al giroscopio) e bottoni touch sulla destra per sparare, bombardare
 * e boost. Gestisce anche il prompt di permesso giroscopio per iOS.
 */
export class MobileControls {
  constructor(input) {
    this.input = input;
    this.root = document.getElementById('mobile-controls');
    if (!this.root) return;

    this._joystick = {
      base: document.getElementById('mc-joystick'),
      thumb: document.getElementById('mc-joystick-thumb'),
      pointerId: null,
      centerX: 0,
      centerY: 0,
      radius: 0,
    };
    this._btnShoot = document.getElementById('mc-shoot');
    this._btnBomb  = document.getElementById('mc-bomb');
    this._btnBoost = document.getElementById('mc-boost');

    // Previene pinch-to-zoom iOS quando si usano più dita contemporaneamente.
    // gesturestart/gesturechange sono eventi webkit-only per pinch/rotate.
    document.addEventListener('gesturestart',  e => e.preventDefault(), { passive: false });
    document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
    document.addEventListener('touchmove', e => {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });

    this._bindJoystick();
    this._bindBoostButton(this._btnBoost);
    this._bindTapButton(this._btnShoot, () => this.input.triggerTouchShoot());
    this._bindTapButton(this._btnBomb,  () => this.input.triggerTouchBomb());

    // Su mobile teniamo sempre attivo il movimento in avanti (l'aereo non sta fermo)
    this.input.setTouchForward(true);
  }

  show() { if (this.root) this.root.style.display = 'block'; }
  hide() { if (this.root) this.root.style.display = 'none'; }

  _bindJoystick() {
    const j = this._joystick;
    if (!j.base || !j.thumb) return;

    const onDown = (e) => {
      if (j.pointerId !== null) return;
      j.pointerId = e.pointerId;
      const rect = j.base.getBoundingClientRect();
      j.centerX = rect.left + rect.width  / 2;
      j.centerY = rect.top  + rect.height / 2;
      j.radius  = rect.width / 2;
      j.base.setPointerCapture(e.pointerId);
      this._updateJoystick(e.clientX, e.clientY);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (j.pointerId !== e.pointerId) return;
      this._updateJoystick(e.clientX, e.clientY);
      e.preventDefault();
    };
    const onUp = (e) => {
      if (j.pointerId !== e.pointerId) return;
      j.pointerId = null;
      j.thumb.style.transform = 'translate(-50%, -50%)';
      this.input.setTouchTurnAxis(0);
      this.input.setTouchSpeedAxis(0);
      try { j.base.releasePointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    };

    j.base.addEventListener('pointerdown',   onDown);
    j.base.addEventListener('pointermove',   onMove);
    j.base.addEventListener('pointerup',     onUp);
    j.base.addEventListener('pointercancel', onUp);
    j.base.addEventListener('pointerleave',  onUp);
  }

  _updateJoystick(x, y) {
    const j = this._joystick;
    const dx = x - j.centerX;
    const dy = y - j.centerY;
    const max = j.radius || 1;
    const len = Math.hypot(dx, dy);
    const clamped = Math.min(len, max);
    const ax = len > 0 ? (dx / len) * clamped : 0;
    const ay = len > 0 ? (dy / len) * clamped : 0;
    j.thumb.style.transform = `translate(calc(-50% + ${ax}px), calc(-50% + ${ay}px))`;
    const DEAD = 0.12;

    // Asse X → sterzata
    const axis = Math.max(-1, Math.min(1, ax / max));
    const out = Math.abs(axis) < DEAD ? 0
      : Math.sign(axis) * ((Math.abs(axis) - DEAD) / (1 - DEAD));
    this.input.setTouchTurnAxis(out);

    // Asse Y → freno (solo verso il basso, ay positivo = dito sotto il centro)
    const axisY = Math.max(-1, Math.min(1, ay / max));
    const outY = axisY < DEAD ? 0 : (axisY - DEAD) / (1 - DEAD);
    this.input.setTouchSpeedAxis(outY);
  }

  _bindBoostButton(el) {
    if (!el) return;
    let lastTapAt = -Infinity;
    const on = (e) => {
      const now = performance.now();
      if (now - lastTapAt <= 280) this.input.triggerTouchBoostDoubleTap();
      lastTapAt = now;
      this.input.setTouchBoost(true);
      el.classList.add('mc-btn--active');
      e.preventDefault();
    };
    const off = (e) => {
      this.input.setTouchBoost(false);
      el.classList.remove('mc-btn--active');
      e.preventDefault();
    };
    el.addEventListener('pointerdown',   on);
    el.addEventListener('pointerup',     off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave',  off);
  }

  _bindHoldButton(el, setter) {
    if (!el) return;
    const on = (e)  => { setter(true);  el.classList.add('mc-btn--active'); e.preventDefault(); };
    const off = (e) => { setter(false); el.classList.remove('mc-btn--active'); e.preventDefault(); };
    el.addEventListener('pointerdown',   on);
    el.addEventListener('pointerup',     off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave',  off);
  }

  _bindTapButton(el, fire) {
    if (!el) return;
    const on = (e) => {
      fire();
      this._flash(el);
      e.preventDefault();
    };
    el.addEventListener('pointerdown', on);
  }

  _flash(el) {
    el.classList.add('mc-btn--active');
    setTimeout(() => el.classList.remove('mc-btn--active'), 110);
  }
}

/** True se il dispositivo è verosimilmente touch (mobile/tablet). */
export function isTouchDevice() {
  return (typeof window !== 'undefined') &&
    (('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0);
}
