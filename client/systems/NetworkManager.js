import { io } from 'socket.io-client';

export class NetworkManager {
  constructor(handlers) {
    this.socket = io({ transports: ['websocket', 'polling'] });
    this.handlers = handlers;
    /** Payload join in attesa dopo `socket.connect()` (es. dopo leave volontario). */
    this._pendingJoin = null;
    /** True se l'ultima disconnessione è stata richiesta dal client (torna al menu). */
    this._voluntaryDisconnect = false;
    this._setupEvents();
  }

  _setupEvents() {
    const h = this.handlers;
    this.socket.on('joined',            (d) => h.onJoined?.(d));
    this.socket.on('server-full',       ()  => h.onServerFull?.());
    this.socket.on('player-joined',     (d) => h.onPlayerJoined?.(d));
    this.socket.on('player-left',       (d) => h.onPlayerLeft?.(d));
    this.socket.on('game-state',        (d) => h.onGameState?.(d));
    this.socket.on('player-killed',     (d) => h.onPlayerKilled?.(d));
    this.socket.on('shield-broken',     (d) => h.onShieldBroken?.(d));
    this.socket.on('powerup-spawned',   (d) => h.onPowerupSpawned?.(d));
    this.socket.on('powerup-collected', (d) => h.onPowerupCollected?.(d));
    this.socket.on('bomb-exploded',     (d) => h.onBombExploded?.(d));
    this.socket.on('new-target',        (d) => h.onNewTarget?.(d));
    this.socket.on('respawned',           (d) => h.onRespawned?.(d));
    this.socket.on('building-destroyed', (d) => h.onBuildingDestroyed?.(d));
    this.socket.on('connect', () => {
      if (this._pendingJoin) {
        const payload = this._pendingJoin;
        this._pendingJoin = null;
        this.socket.emit('join', payload);
      }
      h.onConnect?.();
    });
    this.socket.on('disconnect', () => {
      const voluntary = this._voluntaryDisconnect;
      this._voluntaryDisconnect = false;
      h.onDisconnect?.({ voluntary });
    });
    this.socket.on('lobby-info',        (d) => h.onLobbyInfo?.(d));
    this.socket.on('color-taken',       (d) => h.onColorTaken?.(d));
    this.socket.on('chat-message',      (d) => h.onChatMessage?.(d));
  }

  join(nickname, color, model) {
    const payload = { nickname, color, model };
    if (this.socket.connected) {
      this.socket.emit('join', payload);
      return;
    }
    this._pendingJoin = payload;
    this.socket.connect();
  }

  /** Chiude la sessione e torna alla lobby; il socket si riconnette al prossimo `join`. */
  disconnectVoluntary() {
    this._voluntaryDisconnect = true;
    this.socket.disconnect();
  }

  sendInput(theta, phi, heading, boost, forward, backward) {
    this.socket.emit('player-input', { theta, phi, heading, boost, forward, backward });
  }

  sendShoot(theta, phi, heading) {
    this.socket.emit('shoot', { theta, phi, heading });
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
}
