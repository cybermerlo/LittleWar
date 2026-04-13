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

/** Musica loop — volume più basso dei SFX */
const music = trySound({
  src: ['/music/piccolo-pianeta-blu.mp3'],
  loop: true,
  volume: 0.22,
});

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

export const AudioManager = {
  playShoot()     { sounds.shoot?.play(); },
  playExplosion() { sounds.explosion?.play(); },
  playPowerup()   { sounds.powerup?.play(); },
  playBomb()      { sounds.bomb?.play(); },
  playChatPop()   { sounds.chatPop?.play(); },

  /** Avvia in un handler da click utente (autoplay browser) */
  startMusic() {
    if (!music || music.playing()) return;
    music.play();
  },

  stopMusic() {
    music?.stop();
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
};
