import { Player } from './Player.js';
import { BotPlayer, BOT_NAMES } from './BotPlayer.js';
import { Projectile } from './Projectile.js';
import { PowerUp } from './PowerUp.js';
import { Target } from './Target.js';
import { Building, generateBuildings } from './Building.js';
import { moveOnSphere } from '../shared/movement.js';
import {
  MAX_PLAYERS,
  PLAYER_COLORS,
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
  RESPAWN_INVINCIBILITY,
  SHIELD_INVINCIBILITY,
  BULLET_HIT_RADIUS,
  BOMB_HIT_RADIUS,
  BOMB_FALL_SPEED,
  PLANET_RADIUS,
  FLY_ALTITUDE,
  BUILDING_COUNT,
  EXTREME_BOOST_MULT,
  EXTREME_BOOST_DURATION,
  PLANE_COLLISION_RADIUS,
  BOT_COUNT,
} from '../shared/constants.js';

const TICK_DT = TICK_INTERVAL / 1000; // secondi per tick
const VALID_MODELS = new Set(['spitfire']);
const VALID_PLAYER_COLORS = new Set(PLAYER_COLORS);
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
  constructor(io, roomId = 'default') {
    this.io = io;
    this.roomId = roomId;
    this.players = new Map();   // socketId → Player (umani) | bot.id → BotPlayer
    this.projectiles = new Map();
    this.powerups = new Map();
    this.target = new Target(); // obiettivo condiviso unico
    this.bombs = [];

    this.buildings = generateBuildings(BUILDING_COUNT);

    this.lastPowerupSpawn = Date.now();

    // Stato condiviso tra i bot (ultima posizione nota del player)
    this.botSharedState = { lastKnownTarget: null };

    this._tickInterval = setInterval(() => this.tick(), TICK_INTERVAL);
    this._powerupInterval = setInterval(() => this.spawnRandomPowerup(), POWERUP_RANDOM_INTERVAL);
  }

  destroy() {
    clearInterval(this._tickInterval);
    clearInterval(this._powerupInterval);
    this.players.clear();
    this.projectiles.clear();
    this.powerups.clear();
  }

  hasSocket(socketId) {
    return this.players.has(socketId);
  }

  // ── Giocatori ──────────────────────────────────────────────────────────────

  getTakenColors() {
    return [...this.players.values()].map(p => p.color);
  }

  /** Invia lobby-info (colori occupati + contatore) a uno o tutti i socket.
   *  Solo per la game multiplayer default — le sessioni solo non influenzano la lobby. */
  broadcastLobbyInfo(target = this.io) {
    if (this.roomId !== 'default') return;
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

    if (!VALID_PLAYER_COLORS.has(color)) {
      socket.emit('color-taken', { takenColors: this.getTakenColors(), invalidColor: true });
      return;
    }

    if (this.getTakenColors().includes(color)) {
      socket.emit('color-taken', { takenColors: this.getTakenColors() });
      return;
    }

    const safeModel = VALID_MODELS.has(model) ? model : 'airplane';
    const player = new Player(socket.id, nickname, color, safeModel);
    this.players.set(socket.id, player);

    // Entra nella room Socket.IO di questa istanza di gioco
    socket.join(this.roomId);

    const allPlayers = [...this.players.values()].map(p => p.toState());
    const allPowerups = [...this.powerups.values()].map(p => p.toState());

    socket.emit('joined', {
      playerId: player.id,
      players: allPlayers,
      powerups: allPowerups,
      target: this.target.toState(),
      buildings: [...this.buildings.values()].map(b => b.toState()),
    });

    socket.to(this.roomId).emit('player-joined', player.toPublicInfo());

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

    this.io.to(this.roomId).emit('player-left', { id: player.id });

    // Aggiorna tutti i client in lobby: il colore è di nuovo disponibile
    this.broadcastLobbyInfo();

    console.log(`[game] ${player.nickname} uscito (${this.players.size}/${MAX_PLAYERS})`);
  }

  updatePlayerInput(socketId, input) {
    const player = this.players.get(socketId);
    if (!player || !player.alive) return;

    // Hardening input: evita NaN/Infinity o valori fuori range.
    const nextTheta = clampTheta(input?.theta);
    if (nextTheta === null) return;
    const nextPhi = wrapAngle01(input?.phi);
    const nextHeading = wrapAngle01(input?.heading);

    // Tra due messaggi il server muove il player con tick(); prevTheta/phi del server
    // non coincidono con l'ultimo punto client. Usiamo l'ultima posizione client
    // confermata per allineare lo sweep al percorso reale (C0 → C1).
    const pathFromTheta = player.lastClientTheta ?? player.theta;
    const pathFromPhi = player.lastClientPhi ?? player.phi;

    player.theta = nextTheta;
    player.phi = nextPhi;
    player.heading = nextHeading;
    player.boostPressed = !!input.boost;
    player.moveForward = !!input.forward;
    player.moveBackward = !!input.backward;
    player.lastInputTime = Date.now();
    player.lastClientTheta = nextTheta;
    player.lastClientPhi = nextPhi;

    // Sweep lungo l'arco di grande cerchio (slerp), non la corda 3D — evita falsi negativi
    // con passi angolari grandi (boost / rete lenta).
    this._checkPowerupCollectionAlongPath(player, pathFromTheta, pathFromPhi, nextTheta, nextPhi);
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

    this.createProjectile(player, heading);
  }

  // Crea proiettili per un player a partire dal suo heading (usato anche dai bot).
  createProjectile(player, heading) {
    const wl = Math.min(player.weaponLevel, WEAPON_CONFIGS.length - 1);
    const config = WEAPON_CONFIGS[wl];
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

    // Bot AI: aggiorna heading e flags prima del calcolo del movimento
    for (const player of this.players.values()) {
      if (player.isBot && player.alive) player.tickAI(this, TICK_DT);
    }

    // Predizione movimento: il server muove ogni player nella direzione corrente
    // tra un input e l'altro, così il game-state contiene sempre posizioni fresche.
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      const wl = player.weaponLevel ?? 0;
      const baseSpeed = Math.max(MIN_SPEED, BASE_SPEED - wl * SPEED_REDUCTION_PER_LEVEL);
      // Extreme boost: countdown incontrollabile
      if (player.extremeBoostActive) {
        player.extremeBoostTimer -= TICK_DT;
        if (player.extremeBoostTimer <= 0) {
          player.extremeBoostActive = false;
          player.extremeBoostTimer = 0;
        }
      }
      const canBoost = !player.extremeBoostActive && player.boostPressed && player.boostEnergy > 0;
      if (canBoost) {
        player.boostEnergy = Math.max(0, player.boostEnergy - BOOST_DRAIN_PER_SEC * TICK_DT);
      } else if (!player.extremeBoostActive) {
        player.boostEnergy = Math.min(BOOST_MAX, player.boostEnergy + BOOST_REGEN_PER_SEC * TICK_DT);
      }
      const speedMult = player.extremeBoostActive ? EXTREME_BOOST_MULT : (canBoost ? BOOST_SPEED_MULT : 1);
      const accel = player.moveForward ? FORWARD_ACCEL : player.moveBackward ? BACKWARD_ACCEL : 1;
      const speed = baseSpeed * speedMult * accel;
      const moved = moveOnSphere(player.theta, player.phi, player.heading, speed * TICK_DT);
      player.theta = moved.theta;
      player.phi = moved.phi;
      player.heading = moved.heading;
    }

    // Collisioni tra aerei
    this._checkPlaneCollisions();

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
    this.io.to(this.roomId).emit('game-state', {
      players: [...this.players.values()].map(p => p.toState()),
      projectiles: [...this.projectiles.values()].map(p => p.toState()),
      powerups: [...this.powerups.values()].map(p => p.toState()),
      bombs: this.bombs.map(b => ({
        id: b.id,
        ownerId: b.ownerId,
        theta: b.theta,
        phi: b.phi,
        altitude: b.altitude,
      })),
      buildings: [...this.buildings.values()].map(b => b.toState()),
    });
  }

  // ── Logica colpi ──────────────────────────────────────────────────────────

  hitPlayer(killerId, victim, isTurret = false) {
    if (victim.respawnInvincibleUntil && Date.now() < victim.respawnInvincibleUntil) return;
    if (victim.shieldInvincible) return;

    if (victim.hasShield) {
      victim.hasShield = false;
      victim.shieldInvincible = true;
      setTimeout(() => { victim.shieldInvincible = false; }, SHIELD_INVINCIBILITY);
      this.io.to(this.roomId).emit('shield-broken', { playerId: victim.id });
      return;
    }

    // Morte
    victim.alive = false;
    victim.respawnAt = Date.now() + RESPAWN_DELAY;
    victim.respawnInvincibleUntil = 0;
    victim.weaponLevel = 0;
    victim.hasShield = false;
    victim.boostPressed = false;
    victim.moveForward = false;
    victim.moveBackward = false;
    victim.hasExtremeBoost = false;
    victim.extremeBoostActive = false;
    victim.extremeBoostTimer = 0;

    const killer = this.getPlayerById(killerId);
    if (killer) killer.kills++;

    this.io.to(this.roomId).emit('player-killed', {
      killerId,
      victimId: victim.id,
      theta: victim.theta,
      phi: victim.phi,
      byTurret: isTurret,
    });
    const killerLabel = killer?.nickname ?? 'Sconosciuto';
    const sourceLabel = isTurret ? `${killerLabel} [Torretta]` : killerLabel;
    this.emitKillFeedMessage(`${sourceLabel} ha abbattuto ${victim.nickname}`, {
      kind: 'player-kill',
      killer: {
        nickname: killerLabel,
        color: killer?.color ?? '#ffb86b',
        byTurret: isTurret,
      },
      victim: {
        nickname: victim.nickname ?? 'Sconosciuto',
        color: victim.color ?? '#adc6ff',
      },
    });

    // Drop powerup
    if (Math.random() < POWERUP_DROP_CHANCE) {
      const pu = new PowerUp('weapon', victim.theta, victim.phi);
      this.powerups.set(pu.id, pu);
      this.io.to(this.roomId).emit('powerup-spawned', pu.toState());
    }
  }

  respawnPlayer(player) {
    player.alive = true;
    player.respawnAt = null;
    player.respawnInvincibleUntil = Date.now() + RESPAWN_INVINCIBILITY;
    player.theta = Math.acos(2 * Math.random() - 1);
    player.phi = Math.random() * Math.PI * 2;
    player.heading = Math.random() * Math.PI * 2;
    player.weaponLevel = 0;
    player.hasShield = false;
    player.boostEnergy = BOOST_MAX;
    player.boostPressed = false;
    player.moveForward = false;
    player.moveBackward = false;
    player.hasExtremeBoost = false;
    player.extremeBoostActive = false;
    player.extremeBoostTimer = 0;
    player.lastClientTheta = null;
    player.lastClientPhi = null;

    const socket = this.getSocketById(player.socketId);
    if (socket) socket.emit('respawned', player.toState());
  }

  // ── Bomba atterrata ───────────────────────────────────────────────────────

  bombLanded(bomb) {
    // Edifici conquistati: reset se colpiti; kill solo se la torretta non è tua
    for (const building of this.buildings.values()) {
      if (!building.ownerId) continue;
      const dist = this.distanceSphere(bomb.theta, bomb.phi, building.theta, building.phi, PLANET_RADIUS);
      if (dist < BOMB_HIT_RADIUS) {
        const turretOwnerId = building.ownerId;
        building.reset();
        const destroyer = this.getPlayerById(bomb.ownerId);
        const awardedKill = !!(destroyer && bomb.ownerId !== turretOwnerId);
        if (awardedKill) destroyer.kills++;
        this.io.to(this.roomId).emit('building-destroyed', {
          buildingId: building.id,
          theta: building.theta,
          phi: building.phi,
          destroyerId: bomb.ownerId,
          destroyerNickname: destroyer?.nickname ?? null,
          turretOwnerId,
          awardedKill,
        });
      }
    }

    const dist = this.distanceSphere(bomb.theta, bomb.phi, this.target.theta, this.target.phi, PLANET_RADIUS);
    const hit = dist < BOMB_HIT_RADIUS;

    this.io.to(this.roomId).emit('bomb-exploded', {
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
      this.io.to(this.roomId).emit('new-target', this.target.toState());
      this.emitKillFeedMessage(`${player?.nickname ?? 'Sconosciuto'} ha distrutto l'obiettivo principale!`, {
        kind: 'main-objective-destroyed',
        actor: {
          nickname: player?.nickname ?? 'Sconosciuto',
          color: player?.color ?? '#ffb86b',
        },
      });
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
    const r = FLY_ALTITUDE;
    const a = this.sphericalToCartesian(t0, p0, r);
    const b = this.sphericalToCartesian(t1, p1, r);
    const alen = Math.hypot(a.x, a.y, a.z);
    const blen = Math.hypot(b.x, b.y, b.z);
    const ax = a.x / alen;
    const ay = a.y / alen;
    const az = a.z / alen;
    const bx = b.x / blen;
    const by = b.y / blen;
    const bz = b.z / blen;

    const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
    const omega = Math.acos(dot);

    const toRemove = [];
    for (const [id, pu] of this.powerups) {
      if (this._powerupHitByArc(ax, ay, az, bx, by, bz, omega, pu, r)) {
        this.collectPowerup(player, pu);
        toRemove.push(id);
      }
    }
    for (const id of toRemove) this.powerups.delete(id);
  }

  /**
   * Distanza minima dal powerup al percorso lungo l'arco di grande cerchio tra A e B (slerp).
   */
  _powerupHitByArc(ax, ay, az, bx, by, bz, omega, pu, r) {
    const puCart = this.sphericalToCartesian(pu.theta, pu.phi, r);
    const px = puCart.x;
    const py = puCart.y;
    const pz = puCart.z;

    const distA = Math.hypot(r * ax - px, r * ay - py, r * az - pz);
    if (distA < POWERUP_COLLECT_RADIUS) return true;
    const distB = Math.hypot(r * bx - px, r * by - py, r * bz - pz);
    if (distB < POWERUP_COLLECT_RADIUS) return true;

    const sinOmega = Math.sin(omega);
    const samples = 12;
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      let sx;
      let sy;
      let sz;
      if (omega < 1e-6) {
        sx = r * ax;
        sy = r * ay;
        sz = r * az;
      } else {
        const s0 = Math.sin((1 - t) * omega) / sinOmega;
        const s1 = Math.sin(t * omega) / sinOmega;
        sx = r * (s0 * ax + s1 * bx);
        sy = r * (s0 * ay + s1 * by);
        sz = r * (s0 * az + s1 * bz);
      }
      if (Math.hypot(sx - px, sy - py, sz - pz) < POWERUP_COLLECT_RADIUS) return true;
    }
    return false;
  }

  collectPowerup(player, pu) {
    if (pu.type === 'weapon' && player.weaponLevel < MAX_WEAPON_LEVEL) {
      player.weaponLevel++;
    } else if (pu.type === 'shield') {
      player.hasShield = true;
    } else if (pu.type === 'extreme_boost' && !player.hasExtremeBoost && !player.extremeBoostActive) {
      player.hasExtremeBoost = true;
    }

    this.io.to(this.roomId).emit('powerup-collected', {
      playerId: player.id,
      powerupId: pu.id,
      type: pu.type,
    });
  }

  tryCollectPowerup(socketId, powerupId) {
    const player = this.players.get(socketId);
    if (!player || !player.alive) return;
    const id = String(powerupId);
    const pu = this.powerups.get(id);
    if (!pu) return;
    this.collectPowerup(player, pu);
    this.powerups.delete(id);
  }

  broadcastChat(socketId, text) {
    const player = this.players.get(socketId);
    if (!player) return;
    const safeText = String(text ?? '').trim().slice(0, 120);
    if (!safeText) return;
    this.io.to(this.roomId).emit('chat-message', { nickname: player.nickname, color: player.color, text: safeText });
  }

  emitKillFeedMessage(text, meta = null) {
    const safeText = String(text ?? '').trim().slice(0, 160);
    if (!safeText) return;
    this.io.to(this.roomId).emit('chat-message', {
      nickname: 'KILL FEED',
      color: '#ffb86b',
      text: safeText,
      variant: 'kill-feed',
      meta,
    });
  }

  _checkPlaneCollisions() {
    const alive = [...this.players.values()].filter(p => p.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (!a.alive || !b.alive) continue; // già uccisi in questa passata
        const dist = this.distanceSphere(a.theta, a.phi, b.theta, b.phi, FLY_ALTITUDE);
        if (dist < PLANE_COLLISION_RADIUS) this._killByCollision(a, b);
      }
    }
  }

  _killByCollision(a, b) {
    const now = Date.now();
    let anyDied = false;

    for (const victim of [a, b]) {
      if (!victim.alive) continue;
      if (victim.respawnInvincibleUntil && now < victim.respawnInvincibleUntil) continue;
      if (victim.shieldInvincible) continue;

      if (victim.hasShield) {
        victim.hasShield = false;
        victim.shieldInvincible = true;
        setTimeout(() => { victim.shieldInvincible = false; }, SHIELD_INVINCIBILITY);
        this.io.to(this.roomId).emit('shield-broken', { playerId: victim.id });
        continue;
      }

      victim.alive = false;
      victim.respawnAt = now + RESPAWN_DELAY;
      victim.respawnInvincibleUntil = 0;
      victim.weaponLevel = 0;
      victim.hasShield = false;
      victim.boostPressed = false;
      victim.moveForward = false;
      victim.moveBackward = false;
      victim.hasExtremeBoost = false;
      victim.extremeBoostActive = false;
      victim.extremeBoostTimer = 0;
      anyDied = true;

      this.io.to(this.roomId).emit('player-killed', {
        killerId: null,
        victimId: victim.id,
        theta: victim.theta,
        phi: victim.phi,
        byCollision: true,
      });

      if (Math.random() < POWERUP_DROP_CHANCE) {
        const pu = new PowerUp('weapon', victim.theta, victim.phi);
        this.powerups.set(pu.id, pu);
        this.io.to(this.roomId).emit('powerup-spawned', pu.toState());
      }
    }

    if (anyDied) {
      this.emitKillFeedMessage(`💥 ${a.nickname} e ${b.nickname} si sono scontrati!`, {
        kind: 'collision',
        players: [
          { nickname: a.nickname, color: a.color },
          { nickname: b.nickname, color: b.color },
        ],
      });
    }
  }

  activateExtremeBoost(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.alive || !player.hasExtremeBoost || player.extremeBoostActive) return;
    player.hasExtremeBoost = false;
    player.extremeBoostActive = true;
    player.extremeBoostTimer = EXTREME_BOOST_DURATION;
  }

  spawnRandomPowerup() {
    if (this.players.size === 0) return;
    const r = Math.random();
    const type = r < 0.56 ? 'weapon' : r < 0.80 ? 'shield' : 'extreme_boost';
    const pu = new PowerUp(type);
    this.powerups.set(pu.id, pu);
    this.io.to(this.roomId).emit('powerup-spawned', pu.toState());
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

  // ── Bot (solo sessions) ────────────────────────────────────────────────────

  addBot(sectorMin, sectorMax, humanPlayer, nickname, color) {
    const bot = new BotPlayer(nickname, color, sectorMin, sectorMax);

    // Spawn lontano dal player umano: prova 8 punti, sceglie il più distante
    if (humanPlayer) {
      let bestTheta = sectorMin + Math.random() * (sectorMax - sectorMin);
      let bestPhi = Math.random() * Math.PI * 2;
      let bestDist = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const t = sectorMin + Math.random() * (sectorMax - sectorMin);
        const p = Math.random() * Math.PI * 2;
        const dist = this.distanceSphere(t, p, humanPlayer.theta, humanPlayer.phi, FLY_ALTITUDE);
        if (dist > bestDist) { bestDist = dist; bestTheta = t; bestPhi = p; }
      }
      bot.theta = bestTheta;
      bot.phi = bestPhi;
      bot.heading = Math.random() * Math.PI * 2;
    }

    // Chiave = bot.id (non socketId, che è null per i bot)
    this.players.set(bot.id, bot);

    // Notifica il client: il bot appare come un aereo normale
    this.io.to(this.roomId).emit('player-joined', bot.toPublicInfo());

    return bot;
  }

  addBotsForSoloSession(humanSocketId) {
    const human = this.players.get(humanSocketId);
    if (!human) return;

    const botColors = ['#ff4444', '#ffdd22', '#44dd44'];
    const botNames = BOT_NAMES.slice().sort(() => Math.random() - 0.5);

    for (let i = 0; i < BOT_COUNT; i++) {
      const sectorMin = (i / BOT_COUNT) * Math.PI;
      const sectorMax = ((i + 1) / BOT_COUNT) * Math.PI;
      this.addBot(sectorMin, sectorMax, human, botNames[i], botColors[i]);
    }
  }

  botDropBomb(bot) {
    this.bombs.push({
      id: String(Date.now()) + Math.random(),
      ownerId: bot.id,
      theta: bot.theta,
      phi: bot.phi,
      altitude: FLY_ALTITUDE,
    });
  }
}
