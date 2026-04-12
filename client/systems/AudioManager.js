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
};

/** Musica loop — volume più basso dei SFX */
const music = trySound({
  src: ['/music/piccolo-pianeta-blu.mp3'],
  loop: true,
  volume: 0.22,
});

export const AudioManager = {
  playShoot()     { sounds.shoot?.play(); },
  playExplosion() { sounds.explosion?.play(); },
  playPowerup()   { sounds.powerup?.play(); },
  playBomb()      { sounds.bomb?.play(); },

  /** Avvia in un handler da click utente (autoplay browser) */
  startMusic() {
    if (!music || music.playing()) return;
    music.play();
  },

  stopMusic() {
    music?.stop();
  },
};
