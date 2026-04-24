import { PLAYER_COLORS } from '../../shared/constants.js';

const LAST_NICKNAME_KEY = 'littlewar_last_nickname';

const MODELS = [
  { id: 'spitfire', label: 'Spitfire' },
];

export class LobbyScreen {
  constructor(onPlay, onPlaySolo, onPlaySfida) {
    this.onPlay = onPlay;
    this.onPlaySolo = onPlaySolo;
    this.onPlaySfida = onPlaySfida;
    this.selectedColor = PLAYER_COLORS[0];
    this.selectedModel = MODELS[0].id;
    this._isFull = false;

    this._lobbyEl    = document.getElementById('lobby');
    this._nicknameEl = document.getElementById('nickname');
    this._playBtn    = document.getElementById('play-btn');
    this._soloBtnEl  = document.getElementById('solo-btn');
    this._sfidaBtnEl = document.getElementById('sfida-btn');
    this._msgEl      = document.getElementById('lobby-msg');
    this._countEl   = document.getElementById('online-count');
    this._colorEl   = document.getElementById('color-options');
    this._modelEl   = document.getElementById('model-options');

    this._restoreLastNickname();

    this._buildColorPicker();
    this._buildModelPicker();
    this._playBtn.addEventListener('click', () => this._handlePlay());
    this._soloBtnEl?.addEventListener('click', () => this._handlePlaySolo());
    this._sfidaBtnEl?.addEventListener('click', () => this._handlePlaySfida());
    const onNicknameMaybeChanged = () => this._updatePlayState();
    this._nicknameEl.addEventListener('input', onNicknameMaybeChanged);
    this._nicknameEl.addEventListener('change', onNicknameMaybeChanged);
    this._nicknameEl.addEventListener('focus', onNicknameMaybeChanged);
    this._nicknameEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this._handlePlay();
    });

    this._updatePlayState();
    // Autofill / browser che imposta il valore dopo il primo frame spesso non emettono `input`.
    requestAnimationFrame(() => {
      this._updatePlayState();
      requestAnimationFrame(() => this._updatePlayState());
    });
    setTimeout(() => this._updatePlayState(), 300);
  }

  _restoreLastNickname() {
    try {
      const raw = localStorage.getItem(LAST_NICKNAME_KEY);
      if (raw == null || !this._nicknameEl) return;
      const trimmed = String(raw).trim().slice(0, 16);
      if (!trimmed) return;
      this._nicknameEl.value = trimmed;
      this._updatePlayState();
    } catch {
      /* localStorage non disponibile (privacy mode, ecc.) */
    }
  }

  _persistNickname(nickname) {
    try {
      localStorage.setItem(LAST_NICKNAME_KEY, nickname);
    } catch {
      /* ignorato */
    }
  }

  _getNicknameTrimmed() {
    return (this._nicknameEl?.value ?? '').trim();
  }

  _updatePlayState() {
    const nickname = this._getNicknameTrimmed();
    const valid = nickname.length > 0;
    this._playBtn.disabled = this._isFull || !valid;
    if (this._soloBtnEl)  this._soloBtnEl.disabled = !valid;
    if (this._sfidaBtnEl) this._sfidaBtnEl.disabled = !valid;
    if (this._isFull) return;
    if (!valid) {
      this._msgEl.textContent = 'Inserisci un nickname per giocare.';
      return;
    }
    if (this._msgEl.textContent === 'Inserisci un nickname per giocare.') {
      this._msgEl.textContent = '';
    }
  }

  _buildColorPicker() {
    PLAYER_COLORS.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-btn' + (i === 0 ? ' selected' : '');
      btn.dataset.color = c;
      btn.style.background = c;
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.selectedColor = c;
      });
      this._colorEl.appendChild(btn);
    });
  }

  /**
   * Marca i colori occupati come disabilitati.
   * Se il colore correntemente selezionato è tra quelli occupati,
   * seleziona automaticamente il primo libero.
   */
  setTakenColors(takenColors) {
    const taken = new Set(takenColors);
    let currentStillFree = false;

    document.querySelectorAll('.color-btn').forEach(btn => {
      const c = btn.dataset.color;
      if (taken.has(c)) {
        btn.disabled = true;
        btn.classList.add('color-btn--taken');
        btn.classList.remove('selected');
      } else {
        btn.disabled = false;
        btn.classList.remove('color-btn--taken');
        if (c === this.selectedColor) currentStillFree = true;
      }
    });

    if (!currentStillFree) {
      // Seleziona il primo colore libero disponibile
      const firstFree = document.querySelector('.color-btn:not([disabled])');
      if (firstFree) {
        firstFree.classList.add('selected');
        this.selectedColor = firstFree.dataset.color;
      }
    }
  }

  _buildModelPicker() {
    MODELS.forEach((model, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-btn' + (i === 0 ? ' selected' : '');
      btn.textContent = model.label;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.model-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.selectedModel = model.id;
      });
      this._modelEl.appendChild(btn);
    });
  }

  _handlePlay() {
    const nickname = this._getNicknameTrimmed();
    if (!nickname) {
      this._updatePlayState();
      this._nicknameEl?.focus();
      return;
    }
    this._persistNickname(nickname);
    this.onPlay(nickname, this.selectedColor, this.selectedModel);
  }

  _handlePlaySolo() {
    const nickname = this._getNicknameTrimmed();
    if (!nickname) {
      this._updatePlayState();
      this._nicknameEl?.focus();
      return;
    }
    this._persistNickname(nickname);
    this.onPlaySolo?.(nickname, this.selectedColor, this.selectedModel);
  }

  _handlePlaySfida() {
    const nickname = this._getNicknameTrimmed();
    if (!nickname) {
      this._updatePlayState();
      this._nicknameEl?.focus();
      return;
    }
    this._persistNickname(nickname);
    this.onPlaySfida?.(nickname, this.selectedColor, this.selectedModel);
  }

  setOnlineCount(n, max) {
    this._countEl.textContent = `Online: ${n}/${max}`;
  }

  setFull(isFull) {
    this._isFull = !!isFull;
    this._msgEl.textContent = this._isFull ? 'Server pieno, riprova tra poco.' : '';
    this._updatePlayState();
  }

  setMessage(msg) {
    this._msgEl.textContent = msg;
  }

  hide() {
    this._lobbyEl.style.display = 'none';
  }

  show() {
    this._lobbyEl.style.display = 'flex';
    this._updatePlayState();
  }
}
