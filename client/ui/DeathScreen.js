export class DeathScreen {
  constructor() {
    this._el       = document.getElementById('death-screen');
    this._msg      = document.getElementById('death-msg');
    this._countdown = document.getElementById('death-countdown');
    this._timer    = null;
  }

  show(killerNickname, byTurret, onDone) {
    this._el.style.display = 'flex';
    if (killerNickname && byTurret) {
      this._msg.textContent = `Abbattuto dalla torretta di ${killerNickname}`;
    } else if (killerNickname) {
      this._msg.textContent = `Eliminato da ${killerNickname}`;
    } else {
      this._msg.textContent = 'Sei stato eliminato!';
    }

    let remaining = 3;
    this._countdown.textContent = `Respawn in ${remaining}…`;

    this._timer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        this._countdown.textContent = `Respawn in ${remaining}…`;
      } else {
        clearInterval(this._timer);
        this.hide();
        onDone?.();
      }
    }, 1000);
  }

  hide() {
    this._el.style.display = 'none';
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}
