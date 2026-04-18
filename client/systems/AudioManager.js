// AudioManager — effetti sonori e musica di sottofondo via Howler.js
// SFX: public/sounds/ | Musica: public/music/<stazione>/

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
  radioPing: trySound({ src: ['/sounds/radio-ping.mp3'], volume: 0.8 }),
};

// ── Stazioni radio ─────────────────────────────────────────────────────────────
// Le stazioni vengono caricate da /api/music-stations al primo avvio.
// Basta aggiungere file nelle sottocartelle di public/music/ — nessuna modifica al codice.

const MUSIC_VOLUME = 0.22;

let _stations = [];          // [{ name, paths }]
let _currentStationIdx = 0;
let _musicHowls = [];
let _musicPlaylistActive = false;
let _initPromise = null;

async function _fetchStations() {
  try {
    const res = await fetch('/api/music-stations');
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) return data;
  } catch { /* fallback vuoto */ }
  return [];
}

function _buildHowls(stationIdx) {
  const station = _stations[stationIdx];
  if (!station) return [];
  return station.paths.map((src) =>
    trySound({ src: [src], loop: false, volume: MUSIC_VOLUME }),
  );
}

function _wireChain(howls) {
  for (let i = 0; i < howls.length; i++) {
    const h = howls[i];
    if (!h) continue;
    const idx = i;
    h.on('end', () => {
      if (!_musicPlaylistActive) return;
      let j = (idx + 1) % howls.length;
      for (let k = 0; k < howls.length; k++) {
        const next = howls[j];
        if (next) { next.play(); return; }
        j = (j + 1) % howls.length;
      }
    });
  }
}

function _stopAllHowls() {
  for (const h of _musicHowls) h?.stop();
}

function _startStation(stationIdx, randomStart = false) {
  _stopAllHowls();
  _musicHowls = _buildHowls(stationIdx);
  _wireChain(_musicHowls);

  const validIdx = _musicHowls.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
  if (validIdx.length === 0) return false;

  const startAt = randomStart
    ? validIdx[Math.floor(Math.random() * validIdx.length)]
    : validIdx[0];
  _musicHowls[startAt]?.play();
  return true;
}

// ── Motore ────────────────────────────────────────────────────────────────────
const ENGINE_VOL_IDLE   = 0.049;
const ENGINE_VOL_ACCEL  = 0.098;
const ENGINE_VOL_BOOST  = 0.154;
const ENGINE_FADE_SPEED = 2.5;

const engine = trySound({
  src: ['/sounds/engine.mp3'],
  loop: true,
  volume: 0,
});

let _enginePlaying   = false;
let _engineTargetVol  = 0;
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

  /** Carica le stazioni dal server. Va chiamato all'avvio, prima di startMusic(). */
  async init() {
    if (_initPromise) return _initPromise;
    _initPromise = _fetchStations().then((stations) => {
      _stations = stations;
      // Default: "Radio Marilù", altrimenti prima stazione disponibile
      const defaultIdx = stations.findIndex((s) => s.name === 'Radio Marilù');
      _currentStationIdx = defaultIdx >= 0 ? defaultIdx : 0;
    });
    return _initPromise;
  },

  /** Avvia in un handler da click utente (autoplay browser) */
  startMusic() {
    if (_stations.length === 0 || _currentStationIdx === _stations.length) return;
    const anyPlaying = _musicHowls.some((h) => h?.playing());
    if (anyPlaying) return;
    _musicPlaylistActive = true;
    _startStation(_currentStationIdx, true);
  },

  stopMusic() {
    _musicPlaylistActive = false;
    _stopAllHowls();
  },

  /**
   * Passa alla stazione successiva (R).
   * Ciclo: stazioni con tracce → ... → Off → prima stazione con tracce → ...
   * Ritorna il nome della stazione attiva, o 'Off'.
   */
  nextStation() {
    if (_stations.length === 0) return '';
    sounds.radioPing?.play();

    // _currentStationIdx === _stations.length significa "Off"
    const OFF = _stations.length;

    if (_currentStationIdx === OFF) {
      // Off → prima stazione non vuota
      const first = _stations.findIndex((s) => s.paths.length > 0);
      if (first < 0) return 'Off';
      _currentStationIdx = first;
      _musicPlaylistActive = true;
      _startStation(_currentStationIdx, true);
      return _stations[_currentStationIdx].name;
    }

    // Cerca la prossima stazione non vuota dopo quella corrente
    let next = _currentStationIdx + 1;
    while (next < OFF && _stations[next].paths.length === 0) next++;

    if (next === OFF) {
      // Ultima stazione → Off
      _currentStationIdx = OFF;
      _musicPlaylistActive = false;
      _stopAllHowls();
      return 'Off';
    }

    _currentStationIdx = next;
    _musicPlaylistActive = true;
    _startStation(_currentStationIdx, true);
    return _stations[_currentStationIdx].name;
  },

  getStationName() {
    if (_currentStationIdx === _stations.length) return 'Off';
    return _stations[_currentStationIdx]?.name ?? '';
  },

  // ── Motore ────────────────────────────────────────────────────────────────

  startEngine() {
    if (!engine || _enginePlaying) return;
    engine.volume(0);
    engine.play();
    _enginePlaying = true;
    _engineCurrentVol = 0;
  },

  stopEngine() {
    if (!engine) return;
    engine.stop();
    _enginePlaying = false;
    _engineCurrentVol = 0;
    _engineTargetVol = 0;
    this.stopBoost();
  },

  updateEngine(isAccel, isBoost, delta) {
    if (!engine || !_enginePlaying) return;

    if (isBoost) {
      _engineTargetVol = ENGINE_VOL_BOOST;
    } else if (isAccel) {
      _engineTargetVol = ENGINE_VOL_ACCEL;
    } else {
      _engineTargetVol = ENGINE_VOL_IDLE;
    }

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
