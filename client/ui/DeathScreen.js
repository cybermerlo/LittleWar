/**
 * Schermata "Mayday" dopo un abbattimento.
 *
 * Compare dopo un attimo e non copre più il mondo: prima uno sfondo opaco al
 * 72-84% nascondeva proprio la propria esplosione e chi aveva sparato, mentre
 * la card diceva "Tieni d'occhio chi ti ha preso". Ora c'è solo una vignetta
 * ai bordi e una card compatta in basso, e intanto la camera della morte
 * (CameraController.startDeathCam) mostra l'esplosione e si gira verso il
 * killer.
 *
 * Il conto alla rovescia è legato all'istante del respawn previsto invece che
 * a tre setInterval da un secondo: arriva a zero quando arriva il respawn.
 */

const DEFAULT_DELAY_MS = 900;
const DEFAULT_RESPAWN_MS = 3000;
const TICK_MS = 100;

export class DeathScreen {
  constructor() {
    this._el = document.getElementById('death-screen');
    this._msg = document.getElementById('death-msg');
    this._countdown = document.getElementById('death-countdown');
    this._countNumber = document.getElementById('death-count-number');
    this._box = document.getElementById('death-box');
    this._timer = null;
    this._delay = null;
    this._lastShown = -1;
  }

  /**
   * @param {string|null} killerNickname
   * @param {boolean} byTurret
   * @param {object|Function} [opts]  { respawnAt (performance.now), delayMs, onDone }
   *                                  (una funzione è trattata come onDone, per compatibilità)
   */
  show(killerNickname, byTurret, opts = {}) {
    const o = typeof opts === 'function' ? { onDone: opts } : (opts ?? {});
    this._clearTimers();
    if (killerNickname && byTurret) {
      this._msg.textContent = `Abbattuto dalla torretta di ${killerNickname}`;
    } else if (killerNickname) {
      this._msg.textContent = `Eliminato da ${killerNickname}`;
    } else {
      this._msg.textContent = 'Sei stato eliminato!';
    }

    const start = performance.now();
    const respawnAt = o.respawnAt ?? start + DEFAULT_RESPAWN_MS;
    const total = Math.max(1, respawnAt - start);
    this._lastShown = -1;
    this._update(respawnAt, total);

    const reveal = () => {
      this._delay = null;
      this._el.style.display = 'flex';
      this._timer = setInterval(() => {
        if (!this._update(respawnAt, total)) {
          // Arrivati a zero: si aspetta il respawn vero dal server (hide()).
          clearInterval(this._timer);
          this._timer = null;
          o.onDone?.();
        }
      }, TICK_MS);
    };
    const delay = o.delayMs ?? DEFAULT_DELAY_MS;
    if (delay > 0) this._delay = setTimeout(reveal, delay);
    else reveal();
  }

  /** Aggiorna numero e anello; false quando il tempo è finito. */
  _update(respawnAt, total) {
    const left = Math.max(0, respawnAt - performance.now());
    const secs = Math.ceil(left / 1000);
    if (secs !== this._lastShown) {
      this._lastShown = secs;
      this._countdown.textContent = secs > 0 ? `Respawn in ${secs}…` : 'Rientro in quota…';
      if (this._countNumber) this._countNumber.textContent = String(secs);
    }
    if (this._box) this._box.style.setProperty('--death-progress', (left / total).toFixed(3));
    return left > 0;
  }

  _clearTimers() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._delay) { clearTimeout(this._delay); this._delay = null; }
  }

  hide() {
    this._el.style.display = 'none';
    this._clearTimers();
  }
}
