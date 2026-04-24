// AudioManager — effetti sonori e musica di sottofondo via Howler.js
// SFX: public/sounds/ | Musica: public/music/<stazione>/

import { Howl } from 'howler';

function trySound(config) {
  try { return new Howl(config); } catch { return null; }
}

const sounds = {
  shoot:     trySound({ src: ['/sounds/shoot.mp3'],     volume: 0.4 }),
  explosion: trySound({ src: ['/sounds/explosion.wav'], volume: 0.6 }),
  powerup:   trySound({ src: ['/sounds/powerup.mp3'],   volume: 0.5 }),
  bomb:      trySound({ src: ['/sounds/bomb.mp3'],      volume: 0.7 }),
  chatPop:   trySound({ src: ['/sounds/chat-pop.mp3'], volume: 0.5 }),
  radioPing: trySound({ src: ['/sounds/radio-ping.mp3'], volume: 0.8 }),
};

let _sfxPrimed = false;
let _lastExplosionAt = 0;

function _primeHowl(howl) {
  if (!howl) return;
  try {
    if (howl.state && howl.state() === 'unloaded') howl.load();
  } catch {
    // Best-effort warmup only: normal playback still works if the browser refuses.
  }
}

// ── Stazioni radio ─────────────────────────────────────────────────────────────
// Le stazioni da cartella vengono caricate da /api/music-stations al primo avvio.
// "Giornale Radio" è una stazione speciale (type:'news') sempre iniettata in fondo.

const MUSIC_VOLUME = 0.22;

// Stazione speciale notizie — non ha paths, usa /api/gr1-latest
const NEWS_STATION = { name: 'Giornale Radio', type: 'news' };

let _stations = [];          // [{ name, type, paths? }]
let _currentStationIdx = 0;
let _musicHowls = [];
let _musicPlaylistActive = false;
let _initPromise = null;

// Ritorna true se una stazione ha audio da riprodurre
function _isPlayable(s) {
  return s.type === 'news' || (s.paths?.length > 0);
}

async function _fetchStations() {
  try {
    const res = await fetch('/api/music-stations');
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (Array.isArray(data)) return data;
  } catch { /* fallback vuoto */ }
  return [];
}

function _buildHowls(stationIdx) {
  const station = _stations[stationIdx];
  if (!station || station.type === 'news') return [];
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
  _musicHowls = [];
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

async function _playNewsStation() {
  _stopAllHowls();
  try {
    const res = await fetch('/api/gr1-latest');
    if (!res.ok) throw new Error('feed error');
    const { url } = await res.json();
    // html5:true evita problemi CORS con Web Audio API sullo stream RAI
    const h = trySound({ src: [url], loop: false, volume: MUSIC_VOLUME, html5: true });
    if (h) {
      _musicHowls = [h];
      h.play();
    }
  } catch {
    console.warn('[AudioManager] Giornale Radio: bollettino non disponibile');
  }
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

/** Attenuazione sparo “remoto” (nemici / torrette): volume in funzione della distanza 3D sul raggio di volo. */
const SHOOT_REMOTE_BASE_VOL = 0.4;
const SHOOT_REMOTE_NEAR = 5;
const SHOOT_REMOTE_FAR = 92;

/** Sgancio bomba udibile lontano (stessa logica degli spari remoti). */
const BOMB_DROP_REMOTE_BASE_VOL = 0.7;
const BOMB_DROP_REMOTE_NEAR = 5;
const BOMB_DROP_REMOTE_FAR = 92;

export const AudioManager = {
  playShoot()     { sounds.shoot?.play(); },

  /**
   * Sparo udibile in base alla distanza dal giocatore locale (stessa metrica di `sphereDist` in main).
   * Usa un'istanza Howler separata con volume dedicato, così non interferisce con `playShoot()`.
   */
  playShootAtDistance(distance) {
    const h = sounds.shoot;
    if (!h || !Number.isFinite(distance)) return;
    if (distance >= SHOOT_REMOTE_FAR) return;
    const span = SHOOT_REMOTE_FAR - SHOOT_REMOTE_NEAR;
    const t = span > 0
      ? Math.max(0, Math.min(1, (distance - SHOOT_REMOTE_NEAR) / span))
      : 0;
    const gain = (1 - t) * (1 - t);
    const vol = SHOOT_REMOTE_BASE_VOL * gain;
    if (vol < 0.018) return;
    const id = h.play();
    h.volume(vol, id);
  },

  /** Suono “caduta / sgancio” bomba per altri giocatori, attenuato con la distanza. */
  playBombAtDistance(distance) {
    const h = sounds.bomb;
    if (!h || !Number.isFinite(distance)) return;
    if (distance >= BOMB_DROP_REMOTE_FAR) return;
    const span = BOMB_DROP_REMOTE_FAR - BOMB_DROP_REMOTE_NEAR;
    const t = span > 0
      ? Math.max(0, Math.min(1, (distance - BOMB_DROP_REMOTE_NEAR) / span))
      : 0;
    const gain = (1 - t) * (1 - t);
    const vol = BOMB_DROP_REMOTE_BASE_VOL * gain;
    if (vol < 0.018) return;
    const id = h.play();
    h.volume(vol, id);
  },
  playExplosion() {
    const now = performance.now();
    if (now - _lastExplosionAt < 120) return;
    _lastExplosionAt = now;
    const h = sounds.explosion;
    if (!h) return;
    h.volume(0.6);
    h.play();
  },
  playPowerup()   { sounds.powerup?.play(); },
  playBomb()      { sounds.bomb?.play(); },
  playChatPop()   { sounds.chatPop?.play(); },

  /** Prepara SFX brevi durante il gesto utente di ingresso, evitando decode spike alla prima kill. */
  warmupSfx() {
    if (_sfxPrimed) return;
    _sfxPrimed = true;
    for (const h of Object.values(sounds)) _primeHowl(h);
    _primeHowl(engine);
    _primeHowl(boost);
  },

  /** Carica le stazioni dal server. Va chiamato all'avvio, prima di startMusic(). */
  async init() {
    if (_initPromise) return _initPromise;
    _initPromise = _fetchStations().then((folderStations) => {
      // Radio Marilù sempre prima, poi le altre cartelle, poi Giornale Radio, poi Off (implicito)
      const marilù = folderStations.find((s) => s.name === 'Radio Marilù');
      const rest    = folderStations.filter((s) => s.name !== 'Radio Marilù');
      _stations = [...(marilù ? [marilù] : []), ...rest, NEWS_STATION];
      _currentStationIdx = 0;
    });
    return _initPromise;
  },

  /** Avvia in un handler da click utente (autoplay browser) */
  startMusic() {
    const OFF = _stations.length;
    if (_stations.length === 0 || _currentStationIdx === OFF) return;
    const anyPlaying = _musicHowls.some((h) => h?.playing());
    if (anyPlaying) return;
    const station = _stations[_currentStationIdx];
    _musicPlaylistActive = true;
    if (station?.type === 'news') { _playNewsStation(); return; }
    _startStation(_currentStationIdx, true);
  },

  stopMusic() {
    _musicPlaylistActive = false;
    _stopAllHowls();
  },

  /**
   * Passa alla stazione successiva (R).
   * Ciclo: stazioni riproducibili (cartelle non vuote + Giornale Radio) → Off → ricomincia.
   * Ritorna il nome della nuova stazione (o 'Off').
   */
  nextStation() {
    if (_stations.length === 0) return '';
    sounds.radioPing?.play();

    const OFF = _stations.length;

    if (_currentStationIdx === OFF) {
      // Off → prima stazione riproducibile
      const first = _stations.findIndex(_isPlayable);
      if (first < 0) return 'Off';
      _currentStationIdx = first;
    } else {
      // Cerca la prossima stazione riproducibile
      let next = _currentStationIdx + 1;
      while (next < OFF && !_isPlayable(_stations[next])) next++;

      if (next === OFF) {
        // Fine lista → Off
        _currentStationIdx = OFF;
        _musicPlaylistActive = false;
        _stopAllHowls();
        return 'Off';
      }
      _currentStationIdx = next;
    }

    _musicPlaylistActive = true;
    const station = _stations[_currentStationIdx];
    if (station.type === 'news') {
      _playNewsStation();
    } else {
      _startStation(_currentStationIdx, true);
    }
    return station.name;
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
