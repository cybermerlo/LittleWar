import { Player } from './Player.js';
import { Projectile } from './Projectile.js';
import { PowerUp } from './PowerUp.js';
import { Target } from './Target.js';
import { Building, generateBuildings } from './Building.js';
import { moveOnSphere } from '../shared/movement.js';
import {
  MAX_PLAYERS,
  TICK_INTERVAL,
  WEAPON_CONFIGS,
  MAX_WEAPON_LEVEL,
  BASE_SPEED,
  SPEED_REDUCTION_PER_LEVEL,
  MIN_SPEED,
  BOOST_MAX,
  BOOST_SPEED_MULT,
  BOOST_DRAIN_PER_SEC,
  BOOST_REGEN_PER_SEC,
  FORWARD_ACCEL,
  BACKWARD_ACCEL,
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
  BUILDING_COUNT,
} from '../shared/constants.js';

const TICK_DT = TICK_INTERVAL / 1000; // secondi per tick
const VALID_MODELS = new Set(['airplane', 'spaceship']);
const TAU = Math.PI * 2;

function wrapAngle01(a) {
  if (!Number.isFinite(a)) return 0;
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

function clampTheta(theta) {
  if (!Number.isFinite(theta)) return null;
  return Math.max(0, Math.min(Math.PI, theta));
}

export class Game {
  constructor(io) {
    this.io = io;
    this.players = new Map();   // socketId → Player
    this.projectiles = new Map();
    this.powerups = new Map();
    this.target = new Target(); // obiettivo condiviso unico
    this.bombs = [];

    this.buildings = generateBuildings(BUILDING_COUNT);

    this.lastPowerupSpawn = Date.now();

    setInterval(() => this.tick(), TICK_INTERVAL);
    setInterval(() => this.spawnRandomPowerup(), POWERUP_RANDOM_INTERVAL);
  }

  // ── Giocatori ──────────────────────────────────────────────────────────────

  getTakenColors() {
    return [...this.players.values()].map(p => p.color);
  }

  /** Invia lobby-info (colori occupati + contatore) a uno o tutti i socket */
  broadcastLobbyInfo(target = this.io) {
    target.emit('lobby-info', {
      takenColors: this.getTakenColors(),
      online: this.players.size,
    });
  }

  addPlayer(socket, nickname, color, model) {
    if (this.players.size >= MAX_PLAYERS) {
      socket.emit('server-full');
      return;
    }

    if (this.getTakenColors().includes(color)) {
      socket.emit('color-taken', { takenColors: this.getTakenColors() });
      return;
    }

    const safeModel = VALID_MODELS.has(model) ? model : 'airplane';
    const player = new Player(socket.id, nickname, color, safeModel);
    this.players.set(socket.id, player);

    const allPlayers = [...this.players.values()].map(p => p.toState());
    const allPowerups = [...this.powerups.values()].map(p => p.toState());

    socket.emit('joined', {
      playerId: player.id,
      players: allPlayers,
      powerups: allPowerups,
      target: this.target.toState(),
      buildings: [...this.buildings.values()].map(b => b.toState()),
    });

    socket.broadcast.emit('player-joined', player.toPublicInfo());

    // Aggiorna tutti i client in lobby con i colori ora occupati
    this.broadcastLobbyInfo();

    console.log(`[game] ${nickname} entrato (${this.players.size}/${MAX_PLAYERS})`);
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;

    this.players.delete(socketId);

    // Rimuovi i proiettili del giocatore
    for (const [id, proj] of this.projectiles) {
      if (proj.ownerId === player.id) this.projectiles.delete(id);
    }

    // Rilascia gli edifici posseduti dal giocatore
    for (const building of this.buildings.values()) {
      if (building.ownerId === player.id) {
        building.reset();
      }
    }

    this.io.emit('player-left', { id: player.id });

    // Aggiorna tutti i client in lobby: il colore è di nuovo disponibile
    this.broadcastLobbyInfo();

    console.log(`[game] ${player.nickname} uscito (${this.players.size}/${MAX_PLAYERS})`);
  }

  updatePlayerInput(socketId, input) {
    const player = this.players.get(socketId);
    if (!player || !player.alive) return;
    const prevTheta = player.theta;
    const prevPhi = player.phi;

    // Hardening input: evita NaN/Infinity o valori fuori range.
    const nextTheta = clampTheta(input?.theta);
    if (nextTheta === null) return;
    const nextPhi = wrapAngle01(input?.phi);
    const nextHeading = wrapAngle01(input?.heading);

    player.theta = nextTheta;
    player.phi = nextPhi;
    player.heading = nextHeading;
    player.boostPressed = !!input.boost;
    player.moveForward = !!input.forward;
    player.moveBackward = !!input.backward;
    player.lastInputTime = Date.now();
    // Controllo anti-tunneling su traiettoria reale tra due input:
    // evita pass-through dei powerup con polling lento/boost.
    this._checkPowerupCollectionAlongPath(player, prevTheta, prevPhi, nextTheta, nextPhi);
  }

  // ── Sparo ──────────────────────────────────────────────────────────────────

  playerShoot(socketId, data) {
    const player = this.players.get(socketId);
    if (!player || !player.alive) return;

    // Usa la posizione/heading inviati dal client — più accurati della
    // predizione server, soprattutto quando il giocatore sta girando.
    const theta = clampTheta(data?.theta);
    const phi = Number.isFinite(data?.phi) ? wrapAngle01(data.phi) : player.phi;
    const heading = Number.isFinite(data?.heading) ? wrapAngle01(data.heading) : player.heading;

    // Corregge anche la posizione predetta dal server
    player.theta   = theta ?? player.theta;
    player.phi     = phi;
    player.heading = heading;

    const config = WEAPON_CONFIGS[player.weaponLevel];

    // Genera N proiettili con spread
    for (let i = 0; i < config.bullets; i++) {
      const offset = config.bullets === 1
        ? 0
        : (i / (config.bullets - 1) - 0.5) * config.spread;
      const proj = new Projectile(player.id, player.theta, player.phi, heading + offset);
      this.projectiles.set(proj.id, proj);
    }
  }

  // ── Bomba ──────────────────────────────────────────────────────────────────

  playerDropBomb(socketId, data) {
    const player = this.players.get(socketId);
    if (!player || !player.alive) return;

    const theta = clampTheta(data?.theta);
    const phi = Number.isFinite(data?.phi) ? wrapAngle01(data.phi) : player.phi;
    player.theta = theta ?? player.theta;
    player.phi   = phi;

    this.bombs.push({
      id: String(Date.now()) + Math.random(),
      ownerId: player.id,
      theta,
      phi,
      altitude: FLY_ALTITUDE,
    });
  }

  // ── Tick principale ────────────────────────────────────────────────────────

  tick() {
    const now = Date.now();

    // Predizione movimento: il server muove ogni player nella direzione corrente
    // tra un input e l'altro, così il game-state contiene sempre posizioni fresche.
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      const wl = player.weaponLevel ?? 0;
      const baseSpeed = Math.max(MIN_SPEED, BASE_SPEED - wl * SPEED_REDUCTION_PER_LEVEL);
      const canBoost = player.boostPressed && player.boostEnergy > 0;
      if (canBoost) {
        player.boostEnergy = Math.max(0, player.boostEnergy - BOOST_DRAIN_PER_SEC * TICK_DT);
      } else {
        player.boostEnergy = Math.min(BOOST_MAX, player.boostEnergy + BOOST_REGEN_PER_SEC * TICK_DT);
      }
      const speedMult = canBoost ? BOOST_SPEED_MULT : 1;
      const accel = player.moveForward ? FORWARD_ACCEL : player.moveBackward ? BACKWARD_ACCEL : 1;
      const speed = baseSpeed * speedMult * accel;
      const moved = moveOnSphere(player.theta, player.phi, player.heading, speed * TICK_DT);
      player.theta = moved.theta;
      player.phi = moved.phi;
      player.heading = moved.heading;
    }

    // Aggiorna proiettili + controlla collisioni
    for (const [id, proj] of this.projectiles) {
      if (proj.isExpired()) { this.projectiles.delete(id); continue; }
      proj.update();

      for (const player of this.players.values()) {
        if (!player.alive) continue;
        if (player.id === proj.ownerId) continue;
        // Proiettili torretta non colpiscono il proprietario della torre
        if (proj.buildingOwnerId && player.id === proj.buildingOwnerId) continue;

        const dist = proj.distanceTo(player.theta, player.phi);
        if (dist < BULLET_HIT_RADIUS) {
          this.projectiles.delete(id);
          this.hitPlayer(proj.buildingOwnerId || proj.ownerId, player, !!proj.buildingOwnerId);
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

    // Raccolta powerup con posizione predetta (backup del check in updatePlayerInput)
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      this._checkPowerupCollection(player);
    }

    // Edifici: conquista + torrette
    for (const building of this.buildings.values()) {
      building.updateConquest(this.players);

      const proj = building.updateTurret(this.players);
      if (proj) {
        this.projectiles.set(proj.id, proj);
      }
    }

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
      buildings: [...this.buildings.values()].map(b => b.toState()),
    });
  }

  // ── Logica colpi ──────────────────────────────────────────────────────────

  hitPlayer(killerId, victim, isTurret = false) {
    if (victim.shieldInvincible) return;

    if (victim.hasShield) {
      victim.hasShield = false;
      victim.shieldInvincible = true;
      setTimeout(() => { victim.shieldInvincible = false; }, SHIELD_INVINCIBILITY);
      this.io.emit('shield-broken', { playerId: victim.id });
      return;
    }

    // Morte
    victim.alive = false;
    victim.respawnAt = Date.now() + RESPAWN_DELAY;
    victim.weaponLevel = 0;
    victim.hasShield = false;
    victim.boostPressed = false;
    victim.moveForward = false;
    victim.moveBackward = false;

    const killer = this.getPlayerById(killerId);
    if (killer) killer.kills++;

    this.io.emit('player-killed', {
      killerId,
      victimId: victim.id,
      theta: victim.theta,
      phi: victim.phi,
      byTurret: isTurret,
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
    player.boostEnergy = BOOST_MAX;
    player.boostPressed = false;
    player.moveForward = false;
    player.moveBackward = false;

    const socket = this.getSocketById(player.socketId);
    if (socket) socket.emit('respawned', player.toState());
  }

  // ── Bomba atterrata ───────────────────────────────────────────────────────

  bombLanded(bomb) {
    // Controlla collisione con edifici conquistati (non propri)
    for (const building of this.buildings.values()) {
      if (!building.ownerId) continue;
      const dist = this.distanceSphere(bomb.theta, bomb.phi, building.theta, building.phi, PLANET_RADIUS);
      if (dist < BOMB_HIT_RADIUS) {
        building.reset();
        const destroyer = this.getPlayerById(bomb.ownerId);
        if (destroyer) destroyer.kills++;
        this.io.emit('building-destroyed', {
          buildingId: building.id,
          theta: building.theta,
          phi: building.phi,
          destroyerId: bomb.ownerId,
          destroyerNickname: destroyer?.nickname ?? null,
        });
      }
    }

    const dist = this.distanceSphere(bomb.theta, bomb.phi, this.target.theta, this.target.phi, PLANET_RADIUS);
    const hit = dist < BOMB_HIT_RADIUS;

    this.io.emit('bomb-exploded', {
      theta: bomb.theta,
      phi: bomb.phi,
      ownerId: bomb.ownerId,
      hit,
    });

    if (hit) {
      const player = this.getPlayerById(bomb.ownerId);
      if (player) player.bombPoints++;

      // Nuovo obiettivo condiviso — visibile a tutti
      this.target = new Target();
      this.io.emit('new-target', this.target.toState());
    }
  }

  // ── Powerup ───────────────────────────────────────────────────────────────

  /**
   * Controlla se il giocatore è abbastanza vicino a un powerup per raccoglierlo.
   * Chiamato sia dal tick() (posizione predetta) sia da updatePlayerInput()
   * (posizione reale del client) per non perdere passaggi tra un tick e l'altro.
   */
  _checkPowerupCollection(player) {
    for (const [id, pu] of this.powerups) {
      const dist = this.distanceSphere(player.theta, player.phi, pu.theta, pu.phi, FLY_ALTITUDE);
      if (dist < POWERUP_COLLECT_RADIUS) {
        this.collectPowerup(player, pu);
        this.powerups.delete(id);
      }
    }
  }

  _checkPowerupCollectionAlongPath(player, t0, p0, t1, p1) {
    for (const [id, pu] of this.powerups) {
      const directDist = this.distanceSphere(t1, p1, pu.theta, pu.phi, FLY_ALTITUDE);
      if (directDist < POWERUP_COLLECT_RADIUS) {
        this.collectPowerup(player, pu);
        this.powerups.delete(id);
        continue;
      }
      const segDist = this.distancePointToSegmentOnSphere(t0, p0, t1, p1, pu.theta, pu.phi, FLY_ALTITUDE);
      if (segDist < POWERUP_COLLECT_RADIUS) {
        this.collectPowerup(player, pu);
        this.powerups.delete(id);
      }
    }
  }

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

  broadcastChat(socketId, text) {
    const player = this.players.get(socketId);
    if (!player) return;
    const safeText = String(text ?? '').trim().slice(0, 120);
    if (!safeText) return;
    this.io.emit('chat-message', { nickname: player.nickname, color: player.color, text: safeText });
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

  distancePointToSegmentOnSphere(t0, p0, t1, p1, tp, pp, r) {
    const a = this.sphericalToCartesian(t0, p0, r);
    const b = this.sphericalToCartesian(t1, p1, r);
    const p = this.sphericalToCartesian(tp, pp, r);

    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const apz = p.z - a.z;

    const ab2 = abx * abx + aby * aby + abz * abz;
    if (ab2 < 1e-8) {
      return Math.sqrt(apx * apx + apy * apy + apz * apz);
    }

    let t = (apx * abx + apy * aby + apz * abz) / ab2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t;
    const cy = a.y + aby * t;
    const cz = a.z + abz * t;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dz = p.z - cz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  sphericalToCartesian(theta, phi, r) {
    return {
      x: r * Math.sin(theta) * Math.cos(phi),
      y: r * Math.cos(theta),
      z: r * Math.sin(theta) * Math.sin(phi),
    };
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
