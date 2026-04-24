export class DeathScreen {
  constructor() {
    this._el = document.getElementById('death-screen');
    this._msg = document.getElementById('death-msg');
    this._countdown = document.getElementById('death-countdown');
    this._countNumber = document.getElementById('death-count-number');
    this._box = document.getElementById('death-box');
    this._timer = null;
  }

  show(killerNickname, byTurret, onDone) {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._el.style.display = 'flex';
    if (killerNickname && byTurret) {
      this._msg.textContent = `Abbattuto dalla torretta di ${killerNickname}`;
    } else if (killerNickname) {
      this._msg.textContent = `Eliminato da ${killerNickname}`;
    } else {
      this._msg.textContent = 'Sei stato eliminato!';
    }

    let remaining = 3;
    this._setCountdown(remaining);

    this._timer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        this._setCountdown(remaining);
      } else {
        clearInterval(this._timer);
        this.hide();
        onDone?.();
      }
    }, 1000);
  }

  _setCountdown(value) {
    const clamped = Math.max(0, Math.min(3, value));
    this._countdown.textContent = `Respawn in ${clamped}...`;
    if (this._countNumber) this._countNumber.textContent = String(clamped);
    if (this._box) this._box.style.setProperty('--death-progress', String(clamped / 3));
  }

  hide() {
    this._el.style.display = 'none';
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}
