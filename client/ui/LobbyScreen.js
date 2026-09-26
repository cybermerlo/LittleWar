import { PLAYER_COLORS } from '../../shared/constants.js';
import { getRenderQualityPreference, setRenderQualityPreference } from '../utils/performanceProfile.js';

const LAST_NICKNAME_KEY = 'littlewar_last_nickname';

const MODELS = [
  { id: 'spitfire', label: 'Spitfire' },
];

const QUALITY_OPTIONS = [
  { id: 'high', label: 'High' },
  { id: 'low', label: 'Low' },
];

/** Nomi dei colori di PLAYER_COLORS, per l'etichetta e per i lettori di schermo. */
const COLOR_NAMES = {
  '#ff0000': 'Rosso',
  '#0000ff': 'Blu',
  '#ffff00': 'Giallo',
  '#008000': 'Verde',
  '#ffa500': 'Arancione',
  '#800080': 'Viola',
  '#ffc0cb': 'Rosa',
  '#8b4513': 'Marrone',
  '#ffffff': 'Bianco',
  '#000000': 'Nero',
};

/** Durata dell'uscita del pannello (deve coprire le transizioni CSS di #lobby.lw-leaving). */
const LEAVE_MS = 420;

export class LobbyScreen {
  /**
   * @param {Function} onPlay
   * @param {Function} onPlaySolo
   * @param {object}   [opts]
   * @param {Function} [opts.onColorChange]  colore scelto (anche quando cambia da solo
   *                                         perché quello selezionato è stato preso)
   */
  constructor(onPlay, onPlaySolo, { onColorChange } = {}) {
    this.onPlay = onPlay;
    this.onPlaySolo = onPlaySolo;
    this.onColorChange = onColorChange ?? null;
    this.selectedColor = PLAYER_COLORS[0];
    this.selectedModel = MODELS[0].id;
    this.selectedQuality = getRenderQualityPreference();
    this._isFull = false;
    this._leaveTimer = null;

    this._lobbyEl   = document.getElementById('lobby');
    this._nicknameEl = document.getElementById('nickname');
    this._playBtn   = document.getElementById('play-btn');
    this._soloBtnEl = document.getElementById('solo-btn');
    this._msgEl     = document.getElementById('lobby-msg');
    this._countEl   = document.getElementById('online-count');
    this._colorEl   = document.getElementById('color-options');
    this._colorNameEl = document.getElementById('color-name');
    this._modelEl   = document.getElementById('model-options');
    this._modelRow  = document.getElementById('model-row');
    this._qualityEl = document.getElementById('quality-options');
    this._howEl     = document.getElementById('lw-how');

    const hadNickname = this._restoreLastNickname();
    // Istruzioni aperte solo alla prima visita e se c'è spazio: chi torna sa già
    // giocare, e su schermi più bassi coprirebbero il pianeta e l'aereo.
    if (this._howEl && !hadNickname && window.innerHeight >= 860 && window.innerWidth > 1100) {
      this._howEl.open = true;
    }

    this._buildColorPicker();
    this._buildModelPicker();
    this._buildQualityPicker();
    this._showColorName();
    this._playBtn.addEventListener('click', () => this._handlePlay());
    this._soloBtnEl?.addEventListener('click', () => this._handlePlaySolo());
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
      if (raw == null || !this._nicknameEl) return false;
      const trimmed = String(raw).trim().slice(0, 16);
      if (!trimmed) return false;
      this._nicknameEl.value = trimmed;
      this._updatePlayState();
      return true;
    } catch {
      /* localStorage non disponibile (privacy mode, ecc.) */
      return false;
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
    if (this._soloBtnEl) this._soloBtnEl.disabled = !valid;
    if (this._isFull) return;
    if (!valid) {
      this._msgEl.textContent = 'Inserisci un nickname per giocare.';
      return;
    }
    if (this._msgEl.textContent === 'Inserisci un nickname per giocare.') {
      this._msgEl.textContent = '';
    }
  }

  _selectColor(c) {
    const changed = c !== this.selectedColor;
    this.selectedColor = c;
    this._colorEl.querySelectorAll('.color-btn').forEach((b) => {
      const on = b.dataset.color === c;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    this._showColorName();
    if (changed) this.onColorChange?.(c);
  }

  _showColorName() {
    if (this._colorNameEl) this._colorNameEl.textContent = COLOR_NAMES[this.selectedColor] ?? '';
  }

  _buildColorPicker() {
    PLAYER_COLORS.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-btn' + (i === 0 ? ' selected' : '');
      btn.dataset.color = c;
      btn.style.background = c;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', i === 0 ? 'true' : 'false');
      btn.setAttribute('aria-label', COLOR_NAMES[c] ?? c);
      btn.title = COLOR_NAMES[c] ?? c;
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        this._selectColor(c);
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

    this._colorEl.querySelectorAll('.color-btn').forEach(btn => {
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
      const firstFree = this._colorEl.querySelector('.color-btn:not([disabled])');
      if (firstFree) this._selectColor(firstFree.dataset.color);
    }
  }

  _buildModelPicker() {
    // Con un solo modello la riga non serve a nulla: resta nascosta.
    if (this._modelRow) this._modelRow.hidden = MODELS.length < 2;
    MODELS.forEach((model, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-btn' + (i === 0 ? ' selected' : '');
      btn.textContent = model.label;
      btn.addEventListener('click', () => {
        this._modelEl.querySelectorAll('.model-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.selectedModel = model.id;
      });
      this._modelEl?.appendChild(btn);
    });
  }

  _buildQualityPicker() {
    if (!this._qualityEl) return;

    QUALITY_OPTIONS.forEach((quality) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quality-btn' + (quality.id === this.selectedQuality ? ' selected' : '');
      btn.textContent = quality.label;
      btn.addEventListener('click', () => {
        if (quality.id === this.selectedQuality) return;
        setRenderQualityPreference(quality.id);
        window.location.reload();
      });
      this._qualityEl.appendChild(btn);
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

  /** Il mondo 3D dietro la lobby è pronto: via la copertura opaca. */
  setWorldReady() {
    this._lobbyEl.classList.remove('lw-world-loading');
  }

  /** Il pannello scivola via mentre la camera scende verso l'aereo. */
  hide() {
    if (this._lobbyEl.style.display === 'none') return;
    // Via il focus dal nickname: i tasti di volo non devono finire nel campo.
    const active = document.activeElement;
    if (active && this._lobbyEl.contains(active)) active.blur();
    this._lobbyEl.classList.add('lw-leaving');
    if (this._leaveTimer) clearTimeout(this._leaveTimer);
    this._leaveTimer = setTimeout(() => {
      this._leaveTimer = null;
      this._lobbyEl.style.display = 'none';
    }, LEAVE_MS);
  }

  show() {
    if (this._leaveTimer) { clearTimeout(this._leaveTimer); this._leaveTimer = null; }
    this._lobbyEl.classList.remove('lw-leaving');
    this._lobbyEl.style.display = 'flex';
    this._updatePlayState();
  }
}
