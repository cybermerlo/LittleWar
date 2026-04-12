// AudioManager — effetti sonori via Howler.js
// I file audio vanno in public/sounds/
// Se i file non esistono, i metodi falliscono silenziosamente.

import { Howl } from 'howler';

function trySound(config) {
  try { return new Howl(config); } catch { return null; }
}

const sounds = {
  shoot:     trySound({ src: ['/sounds/shoot.mp3'],     volume: 0.4 }),
  explosion: trySound({ src: ['/sounds/explosion.mp3'], volume: 0.6 }),
  powerup:   trySound({ src: ['/sounds/powerup.mp3'],   volume: 0.5 }),
  bomb:      trySound({ src: ['/sounds/bomb.mp3'],      volume: 0.7 }),
};

export const AudioManager = {
  playShoot()     { sounds.shoot?.play(); },
  playExplosion() { sounds.explosion?.play(); },
  playPowerup()   { sounds.powerup?.play(); },
  playBomb()      { sounds.bomb?.play(); },
};
