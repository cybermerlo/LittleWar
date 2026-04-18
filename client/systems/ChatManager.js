// ChatManager — chat di gruppo in partita
// Messaggi liberi (T) e messaggi rapidi (L = esultazione, P = rammarico)

const QUICK_L = [
  'Haha Coglionazzo inferiore! 🐐',
  'Incapace, hai visto chi è l alfa?',
  'Io sono io e voi non siete un cazzo!',
  'Ti rullo, rullo, rullo!',
  'Sborrooooooooooooo!',
  'Le mie balle sono piu grandi di te!',
  'Piero Angela mi fa una sega!',
  'Yeeeeeeeeeee!',
];

const QUICK_P = [
  'Ora atterro a casa dei tuoi ed incapacito tua sorella!!',
  'Maurizio Costanzo Incapace!',
  'Ti buco cane di merda!',
  'Ti prendo e ti detono l ano!',
  'Faccia di merda muori',
  'Tua madre cagna da pochi soldi',
  'I tuo AVI incapaci e sterili',
  'Tutti i tuoi redditi in medicine!',
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class ChatManager {
  /**
   * @param {Function} onSend  — callback(text) per inviare via rete
   * @param {Function} onAudio — callback() per riprodurre il pop sonoro
   */
  constructor(onSend, onAudio) {
    this._onSend  = onSend;
    this._onAudio = onAudio;
    this._active  = false; // true = in gioco, false = lobby

    this._buildUI();
    this._bindInput();
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  _buildUI() {
    // Wrapper chat
    this._wrap = document.createElement('div');
    this._wrap.id = 'chat-wrap';

    // Feed messaggi
    this._feed = document.createElement('div');
    this._feed.id = 'chat-feed';
    this._feed.setAttribute('aria-live', 'polite');

    // Riga input
    this._inputRow = document.createElement('div');
    this._inputRow.id = 'chat-input-row';
    this._inputRow.style.display = 'none';

    this._input = document.createElement('input');
    this._input.type = 'text';
    this._input.id = 'chat-input';
    this._input.maxLength = 120;
    this._input.placeholder = 'Scrivi un messaggio…';
    this._input.autocomplete = 'off';

    this._inputRow.appendChild(this._input);
    this._wrap.appendChild(this._feed);
    this._wrap.appendChild(this._inputRow);
    document.body.appendChild(this._wrap);
  }

  _bindInput() {
    // Invio con Enter
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const text = this._input.value.trim();
        if (text) this._onSend(text);
        this._closeInput();
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        this._closeInput();
        e.preventDefault();
      }
    });

    // Blocca propagazione di qualsiasi tasto mentre si scrive
    this._input.addEventListener('keydown', (e) => e.stopPropagation());
  }

  _openInput() {
    this._inputRow.style.display = 'flex';
    this._input.value = '';
    this._input.focus();
  }

  _closeInput() {
    this._inputRow.style.display = 'none';
    this._input.blur();
  }

  get isChatOpen() {
    return this._inputRow.style.display !== 'none';
  }

  // ── Attivazione ────────────────────────────────────────────────────────────

  enable()  { this._active = true;  this._wrap.style.display = 'block'; }
  disable() { this._active = false; this._wrap.style.display = 'none'; this._closeInput(); }

  // ── Tasti globali (chiamato da main ogni frame o da keydown) ───────────────

  handleKey(e) {
    if (!this._active) return;

    if (e.type === 'keydown') {
      if (e.code === 'KeyT' && !this.isChatOpen) {
        this._openInput();
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyL' && !this.isChatOpen) {
        this._onSend(randomFrom(QUICK_L));
        return;
      }
      if (e.code === 'KeyP' && !this.isChatOpen) {
        this._onSend(randomFrom(QUICK_P));
        return;
      }
    }
  }

  // ── Ricezione messaggi ─────────────────────────────────────────────────────

  receive({ nickname, color, text, variant, meta }) {
    this._onAudio();

    const entry = document.createElement('div');
    entry.className = 'chat-entry';
    if (variant === 'kill-feed') {
      entry.classList.add('chat-entry--killfeed');
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-nick';
    if (variant === 'kill-feed') {
      nameSpan.classList.add('chat-nick--killfeed');
    }
    nameSpan.style.color = color ?? '#adc6ff';
    nameSpan.textContent = nickname ?? '?';

    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    if (variant === 'kill-feed') {
      textSpan.classList.add('chat-text--killfeed');
    }
    if (variant === 'kill-feed') {
      this._renderKillFeedText(textSpan, text, meta);
    } else {
      textSpan.textContent = text;
    }

    entry.appendChild(nameSpan);
    entry.appendChild(textSpan);

    const maxMessages = document.body.classList.contains('is-mobile') ? 3 : 6;
    while (this._feed.children.length >= maxMessages) {
      this._feed.removeChild(this._feed.firstChild);
    }

    this._feed.appendChild(entry);

    // Fade-in
    requestAnimationFrame(() => entry.classList.add('chat-entry--visible'));

    // Auto-rimozione dopo 6s con fade-out
    setTimeout(() => {
      entry.classList.remove('chat-entry--visible');
      entry.addEventListener('transitionend', () => entry.remove(), { once: true });
    }, 6000);
  }

  _renderKillFeedText(textSpan, fallbackText, meta) {
    if (!meta || typeof meta !== 'object') {
      textSpan.textContent = fallbackText;
      return;
    }

    if (meta.kind === 'player-kill' && meta.killer && meta.victim) {
      textSpan.appendChild(this._createPlayerNameSpan(meta.killer.nickname, meta.killer.color));
      if (meta.killer.byTurret) {
        const turretTag = document.createElement('span');
        turretTag.className = 'chat-killfeed-tag';
        turretTag.textContent = ' [Torretta]';
        textSpan.appendChild(turretTag);
      }
      textSpan.appendChild(document.createTextNode(' ha abbattuto '));
      textSpan.appendChild(this._createPlayerNameSpan(meta.victim.nickname, meta.victim.color));
      return;
    }

    if (meta.kind === 'main-objective-destroyed' && meta.actor) {
      textSpan.appendChild(this._createPlayerNameSpan(meta.actor.nickname, meta.actor.color));
      textSpan.appendChild(document.createTextNode(" ha distrutto l'obiettivo principale!"));
      return;
    }

    textSpan.textContent = fallbackText;
  }

  _createPlayerNameSpan(name, color) {
    const span = document.createElement('span');
    span.className = 'chat-killfeed-name';
    span.style.color = color ?? '#ffb86b';
    span.textContent = name ?? 'Sconosciuto';
    return span;
  }
}
