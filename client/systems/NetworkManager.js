import { io } from 'socket.io-client';

/** Ogni quanto misurare il ping (serve alla compensazione della latenza). */
const PING_INTERVAL_MS = 2000;

export class NetworkManager {
  constructor(handlers) {
    this.socket = io({ transports: ['websocket', 'polling'] });
    this.handlers = handlers;
    /** Payload join in attesa dopo `socket.connect()` (es. dopo leave volontario). */
    this._pendingJoin = null;
    /** True se l'ultima disconnessione è stata richiesta dal client (torna al menu). */
    this._voluntaryDisconnect = false;

    /**
     * Stima del tempo di andata e ritorno (ms). Parte da un valore prudente e
     * si aggiorna con una media mobile, scartando i picchi isolati: un singolo
     * pacchetto lento non deve spostare tutti gli aerei remoti in avanti.
     */
    this.rttMs = 80;
    this.lastPingMs = -1;
    this._pingTimer = null;

    this._setupEvents();
  }

  /** Latenza di sola andata stimata (ms). */
  get oneWayMs() {
    return this.rttMs / 2;
  }

  _setupEvents() {
    const h = this.handlers;
    this.socket.on('joined',            (d) => h.onJoined?.(d));
    this.socket.on('server-full',       ()  => h.onServerFull?.());
    this.socket.on('player-joined',     (d) => h.onPlayerJoined?.(d));
    this.socket.on('player-left',       (d) => h.onPlayerLeft?.(d));
    this.socket.on('game-state',        (d) => h.onGameState?.(d));
    this.socket.on('buildings',         (d) => h.onBuildings?.(d));
    this.socket.on('shots',             (d) => h.onShots?.(d));
    this.socket.on('shot-rejected',     (d) => h.onShotRejected?.(d));
    this.socket.on('projectile-hit',    (d) => h.onProjectileHit?.(d));
    this.socket.on('player-killed',     (d) => h.onPlayerKilled?.(d));
    this.socket.on('powerup-spawned',   (d) => h.onPowerupSpawned?.(d));
    this.socket.on('powerup-collected', (d) => h.onPowerupCollected?.(d));
    this.socket.on('bomb-exploded',     (d) => h.onBombExploded?.(d));
    this.socket.on('new-target',        (d) => h.onNewTarget?.(d));
    this.socket.on('respawned',         (d) => h.onRespawned?.(d));
    this.socket.on('building-destroyed', (d) => h.onBuildingDestroyed?.(d));
    this.socket.on('connect', () => {
      if (this._pendingJoin) {
        const { payload, event } = this._pendingJoin;
        this._pendingJoin = null;
        this.socket.emit(event, payload);
      }
      this._startPinging();
      h.onConnect?.();
    });
    this.socket.on('disconnect', () => {
      const voluntary = this._voluntaryDisconnect;
      this._voluntaryDisconnect = false;
      clearInterval(this._pingTimer);
      this._pingTimer = null;
      h.onDisconnect?.({ voluntary });
    });
    this.socket.on('lobby-info',        (d) => h.onLobbyInfo?.(d));
    this.socket.on('color-taken',       (d) => h.onColorTaken?.(d));
    this.socket.on('chat-message',      (d) => h.onChatMessage?.(d));
  }

  _startPinging() {
    clearInterval(this._pingTimer);
    const ping = () => this.measurePing((ms) => {
      this.lastPingMs = ms;
      // Media mobile asimmetrica: scende subito, sale piano.
      const k = ms < this.rttMs ? 0.5 : 0.15;
      this.rttMs += (Math.min(ms, 1000) - this.rttMs) * k;
    });
    ping();
    this._pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  join(nickname, color, model) {
    this._join('join', { nickname, color, model });
  }

  joinSolo(nickname, color, model) {
    this._join('join-solo', { nickname, color, model });
  }

  _join(event, payload) {
    if (this.socket.connected) {
      this.socket.emit(event, payload);
      return;
    }
    this._pendingJoin = { payload, event };
    this.socket.connect();
  }

  /** Chiude la sessione e torna alla lobby; il socket si riconnette al prossimo `join`. */
  disconnectVoluntary() {
    this._voluntaryDisconnect = true;
    this.socket.disconnect();
  }

  /**
   * Posizione e moto correnti. `sp` e `tr` (velocità e virata effettive,
   * rad/s) e `lat` (latenza stimata, ms) servono al server per portare la
   * posizione al presente e agli altri client per estrapolare il volo.
   */
  sendInput(theta, phi, heading, boost, forward, backward, speed, turnRate) {
    this.socket.emit('player-input', {
      theta, phi, heading, boost, forward, backward,
      sp: speed,
      tr: turnRate,
      lat: Math.round(this.oneWayMs),
    });
  }

  sendShoot(seq, theta, phi, heading) {
    this.socket.emit('shoot', { seq, theta, phi, heading });
  }

  /**
   * "Il mio proiettile `id` ha colpito `victimId` quando aveva `ageMs`
   * millisecondi di volo" — decide chi spara, il server verifica.
   */
  sendHit(id, victimId, ageMs) {
    this.socket.emit('hit', { id, v: victimId, a: Math.round(ageMs) });
  }

  sendBomb(theta, phi) {
    this.socket.emit('drop-bomb', { theta, phi });
  }

  sendChat(text) {
    this.socket.emit('chat', { text });
  }

  sendTryCollect(powerupId) {
    this.socket.emit('try-collect', { powerupId });
  }

  sendActivateExtremeBoost() {
    this.socket.emit('activate-extreme-boost');
  }

  measurePing(callback) {
    const t0 = performance.now();
    this.socket.emit('perf-ping', null, () => callback(Math.round(performance.now() - t0)));
  }

  getTransport() {
    return this.socket.io?.engine?.transport?.name ?? 'unknown';
  }
}
