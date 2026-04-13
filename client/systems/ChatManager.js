// ChatManager — chat di gruppo in partita
// Messaggi liberi (T) e messaggi rapidi (L = esultazione, P = rammarico)

const QUICK_L = [
  'GOAT in volo! 🐐',
  'Non c\'era storia!',
  'Troppo forte per voi!',
  'Chi ferma un carro armato?',
  'Sto volando alto oggi!',
  'Ineguagliabile!',
  'Questo è il mio cielo!',
  'Nessuno come me!',
];

const QUICK_P = [
  'Mannaggia...',
  'Ma dai! :(',
  'Ci stavo quasi!',
  'Riconquisterò il cielo!',
  'La lag, giuro.',
  'Sono stato tradito dalla torretta!',
  'Rivincita immediata!',
  'Poteva andare peggio... no in realtà no.',
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

  receive({ nickname, color, text }) {
    this._onAudio();

    const entry = document.createElement('div');
    entry.className = 'chat-entry';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-nick';
    nameSpan.style.color = color ?? '#adc6ff';
    nameSpan.textContent = nickname ?? '?';

    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = text;

    entry.appendChild(nameSpan);
    entry.appendChild(textSpan);
    this._feed.appendChild(entry);

    // Fade-in
    requestAnimationFrame(() => entry.classList.add('chat-entry--visible'));

    // Auto-rimozione dopo 6s con fade-out
    setTimeout(() => {
      entry.classList.remove('chat-entry--visible');
      entry.addEventListener('transitionend', () => entry.remove(), { once: true });
    }, 6000);
  }
}
