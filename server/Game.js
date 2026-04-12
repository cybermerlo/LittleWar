import { Player } from './Player.js';
import { Projectile } from './Projectile.js';
import { PowerUp } from './PowerUp.js';
import { Target } from './Target.js';
import {
  MAX_PLAYERS,
  TICK_INTERVAL,
  WEAPON_CONFIGS,
  MAX_WEAPON_LEVEL,
  POWERUP_COLLECT_RADIUS,
  POWERUP_LIFETIME,
  POWERUP_RANDOM_INTERVAL,
  POWERUP_DROP_CHANCE,
  RESPAWN_DELAY,
  SHIELD_INVINCIBILITY,
  BULLET_HIT_RADIUS,
  BOMB_HIT_RADIUS,
  BOMB_FALL_SPEED,
  PLANET_RADIUS,
  FLY_ALTITUDE,
} from '../shared/constants.js';

const TICK_DT = TICK_INTERVAL / 1000; // secondi per tick
const VALID_MODELS = new Set(['airplane', 'spaceship']);

export class Game {
  constructor(io) {
    this.io = io;
    this.players = new Map();   // socketId → Player
    this.projectiles = new Map();
    this.powerups = new Map();
    this.targets = new Map();   // playerId → Target
    this.bombs = [];

    this.lastPowerupSpawn = Date.now();

    setInterval(() => this.tick(), TICK_INTERVAL);
    setInterval(() => this.spawnRandomPowerup(), POWERUP_RANDOM_INTERVAL);
  }

  // ── Giocatori ──────────────────────────────────────────────────────────────

  addPlayer(socket, nickname, color, model) {
    if (this.players.size >= MAX_PLAYERS) {
      socket.emit('server-full');
      return;
    }

    const safeModel = VALID_MODELS.has(model) ? model : 'airplane';
    const player = new Player(socket.id, nickname, color, safeModel);
    this.players.set(socket.id, player);

    const allPlayers = [...this.players.values()].map(p => p.toState());
    const allPowerups = [...this.powerups.values()].map(p => p.toState());

    // Assegna un obiettivo bombardamento
    const target = new Target(player.id);
    this.targets.set(player.id, target);

    socket.emit('joined', {
      playerId: player.id,
      players: allPlayers,
      powerups: allPowerups,
      target: target.toState(),
    });

    socket.broadcast.emit('player-joined', player.toPublicInfo());

    console.log(`[game] ${nickname} entrato (${this.players.size}/${MAX_PLAYERS})`);
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;

    this.targets.delete(player.id);
    this.players.delete(socketId);

    // Rimuovi i proiettili del giocatore
    for (const [id, proj] of this.projectiles) {
      if (proj.ownerId === player.id) this.projectiles.delete(id);
    }

    this.io.emit('player-left', { id: player.id });
    console.log(`[game] ${player.nickname} uscito (${this.players.size}/${MAX_PLAYERS})`);
  }

  updatePlayerInput(socketId, input) {
    const player = this.players.get(socketId);
    if (!player || !player.alive) return;
    player.theta = input.theta;
    player.phi = input.phi;
    player.heading = input.heading;
    player.lastInputTime = Date.now();
  }

  // ── Sparo ──────────────────────────────────────────────────────────────────

  playerShoot(socketId, data) {
    const player = this.players.get(socketId);
    if (!player || !player.alive) return;

    const config = WEAPON_CONFIGS[player.weaponLevel];
    const baseHeading = player.heading;

    // Genera N proiettili con spread
    for (let i = 0; i < config.bullets; i++) {
      const offset = config.bullets === 1
        ? 0
        : (i / (config.bullets - 1) - 0.5) * config.spread;
      const proj = new Projectile(
        player.id,
        player.theta,
        player.phi,
        baseHeading + offset
      );
      this.projectiles.set(proj.id, proj);
    }
  }

  // ── Bomba ──────────────────────────────────────────────────────────────────

  playerDropBomb(socketId, data) {
    const player = this.players.get(socketId);
    if (!player || !player.alive) return;

    this.bombs.push({
      id: String(Date.now()) + Math.random(),
      ownerId: player.id,
      theta: player.theta,
      phi: player.phi,
      altitude: FLY_ALTITUDE,
    });
  }

  // ── Tick principale ────────────────────────────────────────────────────────

  tick() {
    const now = Date.now();

    // Aggiorna proiettili + controlla collisioni
    for (const [id, proj] of this.projectiles) {
      if (proj.isExpired()) { this.projectiles.delete(id); continue; }
      proj.update();

      for (const player of this.players.values()) {
        if (!player.alive) continue;
        if (player.id === proj.ownerId) continue;

        const dist = proj.distanceTo(player.theta, player.phi);
        if (dist < BULLET_HIT_RADIUS) {
          this.projectiles.delete(id);
          this.hitPlayer(proj.ownerId, player);
          break;
        }
      }
    }

    // Aggiorna bombe
    this.bombs = this.bombs.filter(bomb => {
      bomb.altitude -= BOMB_FALL_SPEED * TICK_DT;
      if (bomb.altitude <= PLANET_RADIUS + 0.5) {
        this.bombLanded(bomb);
        return false;
      }
      return true;
    });

    // Pulizia powerup scaduti
    for (const [id, pu] of this.powerups) {
      if (now - pu.createdAt > POWERUP_LIFETIME) this.powerups.delete(id);
    }

    // Raccolta powerup (rimozione dopo il giro: niente delete durante l’iterazione sulla Map)
    const powerupsToRemove = new Set();
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      for (const [id, pu] of this.powerups) {
        if (powerupsToRemove.has(id)) continue;
        const dist = this.distanceSphere(player.theta, player.phi, pu.theta, pu.phi, FLY_ALTITUDE);
        if (dist < POWERUP_COLLECT_RADIUS) {
          this.collectPowerup(player, pu);
          powerupsToRemove.add(id);
        }
      }
    }
    for (const id of powerupsToRemove) this.powerups.delete(id);

    // Respawn
    for (const player of this.players.values()) {
      if (!player.alive && player.respawnAt && now >= player.respawnAt) {
        this.respawnPlayer(player);
      }
    }

    // Broadcast stato
    this.io.emit('game-state', {
      players: [...this.players.values()].map(p => p.toState()),
      projectiles: [...this.projectiles.values()].map(p => p.toState()),
      powerups: [...this.powerups.values()].map(p => p.toState()),
      bombs: this.bombs.map(b => ({ id: b.id, theta: b.theta, phi: b.phi, altitude: b.altitude })),
    });
  }

  // ── Logica colpi ──────────────────────────────────────────────────────────

  hitPlayer(killerId, victim) {
    if (victim.shieldInvincible) return;

    if (victim.hasShield) {
      victim.hasShield = false;
      victim.shieldInvincible = true;
      setTimeout(() => { victim.shieldInvincible = false; }, SHIELD_INVINCIBILITY);

      const killerSocket = this.getSocketById(killerId);
      this.io.emit('shield-broken', { playerId: victim.id });
      return;
    }

    // Morte
    victim.alive = false;
    victim.respawnAt = Date.now() + RESPAWN_DELAY;
    victim.weaponLevel = 0;
    victim.hasShield = false;

    const killer = this.getPlayerById(killerId);
    if (killer) killer.kills++;

    this.io.emit('player-killed', {
      killerId,
      victimId: victim.id,
      theta: victim.theta,
      phi: victim.phi,
    });

    // Drop powerup
    if (Math.random() < POWERUP_DROP_CHANCE) {
      const pu = new PowerUp('weapon', victim.theta, victim.phi);
      this.powerups.set(pu.id, pu);
      this.io.emit('powerup-spawned', pu.toState());
    }
  }

  respawnPlayer(player) {
    player.alive = true;
    player.respawnAt = null;
    player.theta = Math.acos(2 * Math.random() - 1);
    player.phi = Math.random() * Math.PI * 2;
    player.heading = Math.random() * Math.PI * 2;
    player.weaponLevel = 0;
    player.hasShield = false;

    const socket = this.getSocketById(player.socketId);
    if (socket) socket.emit('respawned', player.toState());
  }

  // ── Bomba atterrata ───────────────────────────────────────────────────────

  bombLanded(bomb) {
    const target = this.targets.get(bomb.ownerId);
    if (!target) return;

    const dist = this.distanceSphere(bomb.theta, bomb.phi, target.theta, target.phi, PLANET_RADIUS);

    this.io.emit('bomb-exploded', {
      theta: bomb.theta,
      phi: bomb.phi,
      ownerId: bomb.ownerId,
      hit: dist < BOMB_HIT_RADIUS,
    });

    if (dist < BOMB_HIT_RADIUS) {
      const player = this.getPlayerById(bomb.ownerId);
      if (player) player.bombPoints++;

      // Nuovo obiettivo
      const newTarget = new Target(bomb.ownerId);
      this.targets.set(bomb.ownerId, newTarget);

      const socket = this.getSocketByPlayerId(bomb.ownerId);
      if (socket) socket.emit('new-target', newTarget.toState());
    }
  }

  // ── Powerup ───────────────────────────────────────────────────────────────

  collectPowerup(player, pu) {
    if (pu.type === 'weapon' && player.weaponLevel < MAX_WEAPON_LEVEL) {
      player.weaponLevel++;
    } else if (pu.type === 'shield') {
      player.hasShield = true;
    }

    this.io.emit('powerup-collected', {
      playerId: player.id,
      powerupId: pu.id,
      type: pu.type,
    });
  }

  spawnRandomPowerup() {
    if (this.players.size === 0) return;
    const type = Math.random() < 0.7 ? 'weapon' : 'shield';
    const pu = new PowerUp(type);
    this.powerups.set(pu.id, pu);
    this.io.emit('powerup-spawned', pu.toState());
  }

  // ── Utils ─────────────────────────────────────────────────────────────────

  distanceSphere(t1, p1, t2, p2, r) {
    const x1 = r * Math.sin(t1) * Math.cos(p1);
    const y1 = r * Math.cos(t1);
    const z1 = r * Math.sin(t1) * Math.sin(p1);
    const x2 = r * Math.sin(t2) * Math.cos(p2);
    const y2 = r * Math.cos(t2);
    const z2 = r * Math.sin(t2) * Math.sin(p2);
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2 + (z1 - z2) ** 2);
  }

  getPlayerById(id) {
    for (const p of this.players.values()) if (p.id === id) return p;
    return null;
  }

  getSocketById(socketId) {
    return this.io.sockets.sockets.get(socketId) ?? null;
  }

  getSocketByPlayerId(playerId) {
    const player = this.getPlayerById(playerId);
    if (!player) return null;
    return this.io.sockets.sockets.get(player.socketId) ?? null;
  }
}
