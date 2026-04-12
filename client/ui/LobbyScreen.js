const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f',
  '#9b59b6', '#ffffff', '#e67e22', '#1abc9c',
];

export class LobbyScreen {
  constructor(onPlay) {
    this.onPlay = onPlay;
    this.selectedColor = COLORS[0];

    this._lobbyEl   = document.getElementById('lobby');
    this._nicknameEl = document.getElementById('nickname');
    this._playBtn   = document.getElementById('play-btn');
    this._msgEl     = document.getElementById('lobby-msg');
    this._countEl   = document.getElementById('online-count');
    this._colorEl   = document.getElementById('color-options');

    this._buildColorPicker();
    this._playBtn.addEventListener('click', () => this._handlePlay());
  }

  _buildColorPicker() {
    COLORS.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.className = 'color-btn' + (i === 0 ? ' selected' : '');
      btn.style.background = c;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.selectedColor = c;
      });
      this._colorEl.appendChild(btn);
    });
  }

  _handlePlay() {
    const nickname = this._nicknameEl.value.trim() || 'Pilota';
    this.onPlay(nickname, this.selectedColor);
  }

  setOnlineCount(n, max) {
    this._countEl.textContent = `Online: ${n}/${max}`;
  }

  setFull(isFull) {
    this._playBtn.disabled = isFull;
    this._msgEl.textContent = isFull ? 'Server pieno, riprova tra poco.' : '';
  }

  setMessage(msg) {
    this._msgEl.textContent = msg;
  }

  hide() {
    this._lobbyEl.style.display = 'none';
  }

  show() {
    this._lobbyEl.style.display = 'flex';
  }
}
