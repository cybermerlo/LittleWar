// AudioManager — effetti sonori e musica di sottofondo via Howler.js
// SFX: public/sounds/ | Musica: public/music/

import { Howl } from 'howler';

function trySound(config) {
  try { return new Howl(config); } catch { return null; }
}

const sounds = {
  shoot:     trySound({ src: ['/sounds/shoot.wav'],     volume: 0.4 }),
  explosion: trySound({ src: ['/sounds/explosion.wav'], volume: 0.6 }),
  powerup:   trySound({ src: ['/sounds/powerup.wav'],   volume: 0.5 }),
  bomb:      trySound({ src: ['/sounds/bomb.wav'],      volume: 0.7 }),
  chatPop:   trySound({ src: ['/sounds/chat-pop.mp3'], volume: 0.5 }),
};

/** Playlist musica: prima traccia casuale all’avvio, poi in ordine e di nuovo dal primo */
const MUSIC_PATHS = [
  '/music/piccolo-pianeta-blu.mp3',
  '/music/whatsapp-2026-04-16.mp3',
];
const MUSIC_VOLUME = 0.22;

const _musicHowls = MUSIC_PATHS.map((src) =>
  trySound({ src: [src], loop: false, volume: MUSIC_VOLUME }),
);

let _musicPlaylistActive = false;

for (let i = 0; i < _musicHowls.length; i++) {
  const h = _musicHowls[i];
  if (!h) continue;
  const idx = i;
  h.on('end', () => {
    if (!_musicPlaylistActive) return;
    let j = (idx + 1) % _musicHowls.length;
    for (let k = 0; k < _musicHowls.length; k++) {
      const next = _musicHowls[j];
      if (next) {
        next.play();
        return;
      }
      j = (j + 1) % _musicHowls.length;
    }
  });
}

// ── Motore ────────────────────────────────────────────────────────────────────
// Volume target e corrente per il motore locale
const ENGINE_VOL_IDLE   = 0.049; // volume base quando si vola
const ENGINE_VOL_ACCEL  = 0.098; // quando si accelera (W)
const ENGINE_VOL_BOOST  = 0.154; // durante il boost
const ENGINE_FADE_SPEED = 2.5;   // unità/secondo — velocità lerp volume

const engine = trySound({
  src: ['/sounds/engine.mp3'],
  loop: true,
  volume: 0,
});

let _enginePlaying  = false;
let _engineTargetVol = 0;
let _engineCurrentVol = 0;

// ── Boost ─────────────────────────────────────────────────────────────────────
const boost = trySound({
  src: ['/sounds/boost.mp3'],
  loop: true,
  volume: 0.35,
});

let _boostPlaying = false;

export const AudioManager = {
  playShoot()     { sounds.shoot?.play(); },
  playExplosion() { sounds.explosion?.play(); },
  playPowerup()   { sounds.powerup?.play(); },
  playBomb()      { sounds.bomb?.play(); },
  playChatPop()   { sounds.chatPop?.play(); },

  /** Avvia in un handler da click utente (autoplay browser) */
  startMusic() {
    const anyPlaying = _musicHowls.some((h) => h?.playing());
    if (anyPlaying) return;
    const validIdx = _musicHowls.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
    if (validIdx.length === 0) return;
    const startAt = validIdx[Math.floor(Math.random() * validIdx.length)];
    const first = _musicHowls[startAt];
    if (!first) return;
    _musicPlaylistActive = true;
    first.play();
  },

  stopMusic() {
    _musicPlaylistActive = false;
    for (const h of _musicHowls) h?.stop();
  },

  // ── Motore ────────────────────────────────────────────────────────────────

  /** Chiamato una volta sola quando il giocatore entra in gioco. */
  startEngine() {
    if (!engine || _enginePlaying) return;
    engine.volume(0);
    engine.play();
    _enginePlaying = true;
    _engineCurrentVol = 0;
  },

  /** Chiamato quando il giocatore lascia il gioco / muore definitivamente. */
  stopEngine() {
    if (!engine) return;
    engine.stop();
    _enginePlaying = false;
    _engineCurrentVol = 0;
    _engineTargetVol = 0;
    this.stopBoost();
  },

  /**
   * Aggiorna volume motore ogni frame.
   * @param {boolean} isAccel  - tasto avanti premuto
   * @param {boolean} isBoost  - boost attivo
   * @param {number}  delta    - secondi dall'ultimo frame
   */
  updateEngine(isAccel, isBoost, delta) {
    if (!engine || !_enginePlaying) return;

    if (isBoost) {
      _engineTargetVol = ENGINE_VOL_BOOST;
    } else if (isAccel) {
      _engineTargetVol = ENGINE_VOL_ACCEL;
    } else {
      _engineTargetVol = ENGINE_VOL_IDLE;
    }

    // Lerp morbido verso il target
    const diff = _engineTargetVol - _engineCurrentVol;
    const step = ENGINE_FADE_SPEED * delta;
    if (Math.abs(diff) <= step) {
      _engineCurrentVol = _engineTargetVol;
    } else {
      _engineCurrentVol += Math.sign(diff) * step;
    }

    engine.volume(_engineCurrentVol);
  },

  // ── Boost ──────────────────────────────────────────────────────────────────

  startBoost() {
    if (!boost || _boostPlaying) return;
    boost.play();
    _boostPlaying = true;
  },

  stopBoost() {
    if (!boost || !_boostPlaying) return;
    boost.stop();
    _boostPlaying = false;
  },
};
