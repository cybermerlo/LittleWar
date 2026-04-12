import { io } from 'socket.io-client';

export class NetworkManager {
  constructor(handlers) {
    this.socket = io({ transports: ['websocket', 'polling'] });
    this.handlers = handlers;
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
    this.socket.on('respawned',         (d) => h.onRespawned?.(d));
    this.socket.on('connect',           ()  => h.onConnect?.());
    this.socket.on('disconnect',        ()  => h.onDisconnect?.());
    this.socket.on('lobby-info',        (d) => h.onLobbyInfo?.(d));
    this.socket.on('color-taken',       (d) => h.onColorTaken?.(d));
  }

  join(nickname, color, model) {
    this.socket.emit('join', { nickname, color, model });
  }

  sendInput(theta, phi, heading, boost) {
    this.socket.emit('player-input', { theta, phi, heading, boost });
  }

  sendShoot(theta, phi, heading) {
    this.socket.emit('shoot', { theta, phi, heading });
  }

  sendBomb(theta, phi) {
    this.socket.emit('drop-bomb', { theta, phi });
  }
}
