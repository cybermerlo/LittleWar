import { FLY_ALTITUDE, BOOST_MAX, BASE_SPEED } from '../shared/constants.js';

let nextId = 1;

/** Campioni di posizione conservati: 48 tick a 40 Hz = 1.2 s. */
const HISTORY_SIZE = 48;

/** Arrotonda per il game-state: 1e-4 rad sono mezzo centesimo di unità a quota di volo. */
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Il nickname finisce nell'HUD di tutti gli altri giocatori: niente caratteri
 * di controllo e lunghezza limitata (prima era accettato qualsiasi testo).
 */
export function sanitizeNickname(raw) {
  const clean = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 16);
  return clean || 'Player';
}

export class Player {
  constructor(socketId, nickname, color, model) {
    this.id = String(nextId++);
    this.socketId = socketId;
    this.nickname = sanitizeNickname(nickname);
    this.color = color || '#ff4444';
    this.model = model || 'airplane';

    // Posizione sferica
    this.theta = Math.random() * Math.PI;
    this.phi = Math.random() * Math.PI * 2;
    this.heading = Math.random() * Math.PI * 2;
    this.altitude = FLY_ALTITUDE;

    // Moto corrente (rad/s): lo usa la predizione del server e viene inoltrato
    // ai client, che ci estrapolano la posizione degli aerei remoti.
    this.speed = BASE_SPEED;
    this.turnRate = 0;
    /** Latenza di sola andata dichiarata dal client (ms), per la compensazione. */
    this.latencyMs = 0;

    // Stato gioco
    this.weaponLevel = 0;
    this.hasShield = false;
    this.shieldInvincible = false;
    this.kills = 0;
    this.bombPoints = 0;
    this.alive = true;
    this.respawnAt = null;
    this.respawnInvincibleUntil = 0;
    this.boostEnergy = BOOST_MAX;
    this.boostPressed = false;
    this.moveForward = false;
    this.moveBackward = false;
    this.hasExtremeBoost = false;
    this.extremeBoostActive = false;
    this.extremeBoostTimer = 0;

    // Cadenza di fuoco: secchiello di gettoni invece di un intervallo minimo
    // rigido, così il jitter di rete non fa scartare colpi sparati in regola.
    this.shotTokens = 2;
    this.shotTokensAt = Date.now();

    // Ultimo input ricevuto
    this.lastInputTime = Date.now();

    /** Ultima theta/phi inviate dal client (non ricalcolate dai tick) — per sweep powerup sul percorso reale. */
    this.lastClientTheta = null;
    this.lastClientPhi = null;

    // Storico recente delle posizioni (un campione per tick): serve a
    // verificare un colpo nel punto in cui il bersaglio era *quando* il
    // proiettile l'ha raggiunto, non dove è quando la notizia arriva.
    this._hist = new Array(HISTORY_SIZE);
    this._histHead = 0;
    this._histCount = 0;
  }

  /** Registra la posizione corrente (chiamato a ogni tick). */
  recordPosition(t) {
    const i = this._histHead;
    const e = this._hist[i] ?? (this._hist[i] = { t: 0, x: 0, y: 0, z: 0 });
    const st = Math.sin(this.theta);
    e.t = t;
    e.x = st * Math.cos(this.phi);
    e.y = Math.cos(this.theta);
    e.z = st * Math.sin(this.phi);
    this._histHead = (i + 1) % HISTORY_SIZE;
    this._histCount = Math.min(HISTORY_SIZE, this._histCount + 1);
  }

  /** Dimentica lo storico (respawn: le posizioni precedenti non valgono più). */
  clearHistory() {
    this._histCount = 0;
  }

  /**
   * Posizione unitaria all'istante `t` (ms), interpolata dallo storico.
   * Fuori dallo storico restituisce l'estremo più vicino (o la posizione
   * attuale se lo storico è vuoto).
   */
  positionAt(t, out) {
    if (this._histCount === 0) {
      const st = Math.sin(this.theta);
      out.x = st * Math.cos(this.phi); out.y = Math.cos(this.theta); out.z = st * Math.sin(this.phi);
      return out;
    }
    let newer = null;
    for (let k = 1; k <= this._histCount; k++) {
      const e = this._hist[(this._histHead - k + HISTORY_SIZE) % HISTORY_SIZE];
      if (e.t <= t) {
        if (!newer) { out.x = e.x; out.y = e.y; out.z = e.z; return out; }
        const f = (t - e.t) / Math.max(1, newer.t - e.t);
        out.x = e.x + (newer.x - e.x) * f;
        out.y = e.y + (newer.y - e.y) * f;
        out.z = e.z + (newer.z - e.z) * f;
        const l = Math.hypot(out.x, out.y, out.z) || 1;
        out.x /= l; out.y /= l; out.z /= l;
        return out;
      }
      newer = e;
    }
    out.x = newer.x; out.y = newer.y; out.z = newer.z; // più vecchio dello storico
    return out;
  }

  /**
   * Stato per tick, volutamente compatto: nickname, colore e modello non
   * cambiano e viaggiano solo in `joined` / `player-joined`.
   */
  toState() {
    const boosting = this.boostPressed && this.boostEnergy > 0;
    const state = {
      id: this.id,
      theta: r4(this.theta),
      phi: r4(this.phi),
      heading: r4(this.heading),
      speed: r4(this.speed),
      turnRate: r4(this.turnRate),
      weaponLevel: this.weaponLevel,
      hasShield: this.hasShield,
      kills: this.kills,
      bombPoints: this.bombPoints,
      alive: this.alive,
      boosting,
      hasExtremeBoost: this.hasExtremeBoost,
      extremeBoosting: this.extremeBoostActive,
    };
    // boostEnergy serve ai remoti solo durante il boost.
    if (boosting) state.boostEnergy = Math.round(Math.max(0, Math.min(BOOST_MAX, this.boostEnergy)));
    return state;
  }

  toPublicInfo() {
    return {
      id: this.id,
      nickname: this.nickname,
      color: this.color,
      model: this.model,
    };
  }

  /** Stato completo (dinamico + statico): per `joined` e `respawned`. */
  toFullState() {
    return { ...this.toState(), ...this.toPublicInfo() };
  }
}
