import { Player } from './Player.js';
import { BotPlayer, BOT_NAMES } from './BotPlayer.js';
import { Projectile } from './Projectile.js';
import { PowerUp } from './PowerUp.js';
import { Target } from './Target.js';
import { generateBuildings } from './Building.js';
import { advanceOnSphere } from '../shared/movement.js';
import { shotHeadingOffsets, segmentPointDistSq } from '../shared/projectile.js';
import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  TICK_INTERVAL,
  SHOOT_COOLDOWN_MS,
  MAX_ACTIVE_PROJECTILES,
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
  BULLET_SPEED,
  BULLET_LIFETIME,
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
  HIT_CLAIM_BASE_TOLERANCE,
  HIT_CLAIM_TIME_WINDOW,
  HIT_CLAIM_GRACE_MS,
  MAX_LAG_COMPENSATION_MS,
} from '../shared/constants.js';

const TICK_DT = TICK_INTERVAL / 1000; // secondi per tick
const VALID_MODELS = new Set(['spitfire']);
const VALID_PLAYER_COLORS = new Set(PLAYER_COLORS);
const TAU = Math.PI * 2;
/** Velocità massima plausibile di un aereo (rad/s), con un margine. */
const MAX_PLANE_SPEED = BASE_SPEED * EXTREME_BOOST_MULT * FORWARD_ACCEL * 1.1;
const MAX_TURN_RATE = 4; // rad/s
/** Oltre questo silenzio la predizione smette di seguire la virata dichiarata. */
const INPUT_FRESH_MS = 400;

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

function wrapAngle01(a) {
  if (!Number.isFinite(a)) return 0;
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

function wrapAnglePi(a) {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x < -Math.PI) x += TAU;
  return x;
}

function clampTheta(theta) {
  if (!Number.isFinite(theta)) return null;
  return Math.max(0, Math.min(Math.PI, theta));
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Velocità "di crociera" calcolata dal server: bot, o giocatori silenziosi. */
function computedSpeed(player, canBoost) {
  const wl = player.weaponLevel ?? 0;
  const base = Math.max(MIN_SPEED, BASE_SPEED - wl * SPEED_REDUCTION_PER_LEVEL);
  const mult = player.extremeBoostActive ? EXTREME_BOOST_MULT : (canBoost ? BOOST_SPEED_MULT : 1);
  const accel = player.moveForward ? FORWARD_ACCEL : player.moveBackward ? BACKWARD_ACCEL : 1;
  return base * mult * accel;
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
    this._nextBombId = 1;

    this.buildings = generateBuildings(BUILDING_COUNT);
    /** Ultimo stato edifici trasmesso: si ritrasmette solo quando cambia. */
    this._lastBuildingsJson = '';

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

    const safeModel = VALID_MODELS.has(model) ? model : 'spitfire';
    const player = new Player(socket.id, nickname, color, safeModel);
    this.players.set(socket.id, player);

    // Entra nella room Socket.IO di questa istanza di gioco
    socket.join(this.roomId);

    socket.emit('joined', {
      playerId: player.id,
      players: [...this.players.values()].map(p => p.toFullState()),
      powerups: [...this.powerups.values()].map(p => p.toState()),
      target: this.target.toState(),
      buildings: [...this.buildings.values()].map(b => b.toState()),
    });

    socket.to(this.roomId).emit('player-joined', player.toPublicInfo());

    // Aggiorna tutti i client in lobby con i colori ora occupati
    this.broadcastLobbyInfo();

    console.log(`[game] ${player.nickname} entrato (${this.players.size}/${MAX_PLAYERS})`);
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

    player.boostPressed = !!input.boost;
    player.moveForward = !!input.forward;
    player.moveBackward = !!input.backward;
    player.lastInputTime = Date.now();
    player.lastClientTheta = nextTheta;
    player.lastClientPhi = nextPhi;

    const sp = Number(input.sp);
    player.clientSpeed = Number.isFinite(sp) ? clamp(sp, 0, MAX_PLANE_SPEED) : null;
    const tr = Number(input.tr);
    player.clientTurnRate = Number.isFinite(tr) ? clamp(tr, -MAX_TURN_RATE, MAX_TURN_RATE) : 0;
    const lat = Number(input.lat);
    player.latencyMs = Number.isFinite(lat) ? clamp(lat, 0, MAX_LAG_COMPENSATION_MS) : 0;

    // La posizione ricevuta è vecchia di una latenza di sola andata: la si
    // porta avanti di altrettanto, così il server (e chi riceve il game-state)
    // vede l'aereo dove è davvero adesso e non dove era quando è partito il
    // pacchetto.
    const speed = player.clientSpeed ?? computedSpeed(player, false);
    const now = advanceOnSphere(
      nextTheta, nextPhi, nextHeading,
      speed, player.clientTurnRate, player.latencyMs / 1000,
    );
    player.theta = now.theta;
    player.phi = wrapAngle01(now.phi);
    player.heading = wrapAngle01(now.heading);
    player.speed = speed;
    player.turnRate = player.clientTurnRate;

    // Sweep lungo l'arco di grande cerchio (slerp), non la corda 3D — evita falsi negativi
    // con passi angolari grandi (boost / rete lenta).
    this._checkPowerupCollectionAlongPath(player, pathFromTheta, pathFromPhi, nextTheta, nextPhi);
  }

  // ── Sparo ──────────────────────────────────────────────────────────────────

  /**
   * Sparo di un giocatore. Il client ha già mostrato i proiettili (id
   * deterministico `${playerId}.${seq}:${i}`); qui si creano le copie server e
   * si annuncia la salva a tutti. Se lo sparo non è valido lo si dice al solo
   * tiratore, che toglie i proiettili mostrati in anticipo.
   */
  playerShoot(socketId, data) {
    const player = this.players.get(socketId);
    const seq = Number.isInteger(data?.seq) && data.seq >= 0 && data.seq < 2 ** 31 ? data.seq : null;
    const reject = () => {
      if (seq !== null) this.getSocketById(socketId)?.emit('shot-rejected', { seq });
    };
    if (!player || !player.alive || seq === null) return reject();

    const now = Date.now();
    player.shotTokens = Math.min(2, player.shotTokens + (now - player.shotTokensAt) / SHOOT_COOLDOWN_MS);
    player.shotTokensAt = now;
    if (player.shotTokens < 1) return reject();

    // Usa la posizione/heading inviati dal client: sono quelli da cui il
    // giocatore ha visto partire i colpi.
    const theta = clampTheta(data.theta);
    if (theta === null || !Number.isFinite(data.phi) || !Number.isFinite(data.heading)) return reject();
    const phi = wrapAngle01(data.phi);
    const heading = wrapAngle01(data.heading);

    const shotId = `${player.id}.${seq}`;
    if (this.projectiles.has(`${shotId}:0`)) return reject();
    const offsets = shotHeadingOffsets(player.weaponLevel);
    if (this.projectiles.size + offsets.length > MAX_ACTIVE_PROJECTILES) return reject();
    player.shotTokens -= 1;

    // Il tiratore ha sparato una latenza fa: la salva parte da allora.
    this._spawnSalvo(shotId, player.id, theta, phi, heading, offsets, {
      spawnAt: now - player.latencyMs,
      serverHits: false,
    });
  }

  /** Salva di un bot: nessun client la possiede, quindi i colpi li decide il server. */
  createProjectile(bot, heading) {
    const offsets = shotHeadingOffsets(bot.weaponLevel);
    if (this.projectiles.size + offsets.length > MAX_ACTIVE_PROJECTILES) return;
    bot._shotSeq = (bot._shotSeq ?? 0) + 1;
    this._spawnSalvo(`${bot.id}.${bot._shotSeq}`, bot.id, bot.theta, bot.phi, wrapAngle01(heading), offsets, {
      spawnAt: Date.now(),
      serverHits: true,
    });
  }

  _spawnSalvo(shotId, ownerId, theta, phi, heading, offsets, { spawnAt, serverHits }) {
    const headings = offsets.map((o) => heading + o);
    headings.forEach((h, i) => {
      const id = `${shotId}:${i}`;
      this.projectiles.set(id, new Projectile({
        id, ownerId, theta, phi, heading: h,
        speed: BULLET_SPEED, lifetime: BULLET_LIFETIME, spawnAt, serverHits,
      }));
    });
    this._emitShots(shotId, ownerId, theta, phi, headings, BULLET_SPEED, BULLET_LIFETIME, spawnAt);
  }

  /**
   * Annuncio di una salva: l'unico messaggio che un proiettile genera finché
   * non colpisce qualcosa. `ag` è l'età della salva all'invio: ogni client ci
   * somma la propria latenza per mostrarla dove si trova davvero.
   */
  _emitShots(shotId, ownerId, theta, phi, headings, speed, lifetime, spawnAt) {
    this.io.to(this.roomId).emit('shots', {
      id: shotId,
      o: ownerId,
      th: r5(theta),
      ph: r5(phi),
      hd: headings.map(r5),
      sp: speed,
      lt: lifetime,
      ag: Math.max(0, Date.now() - spawnAt),
    });
  }

  /**
   * Il client di chi ha sparato ha visto un proprio proiettile toccare un
   * aereo. Il colpo viene accettato se è plausibile: il proiettile esiste, è
   * suo, e la sua traiettoria recente passa abbastanza vicino alla posizione
   * che il server conosce del bersaglio.
   */
  claimHit(socketId, data) {
    const shooter = this.players.get(socketId);
    if (!shooter) return;
    const id = String(data?.id ?? '');
    const proj = this.projectiles.get(id);
    if (!proj || proj.serverHits || proj.ownerId !== shooter.id) return;
    const victim = this.getPlayerById(String(data?.v ?? ''));
    if (!victim || !victim.alive || victim.id === shooter.id) return;

    if (!this._claimPlausible(proj, victim, Date.now(), Number(data?.a))) {
      console.warn(`[hit] claim rifiutato: ${shooter.nickname} → ${victim.nickname} (${id})`);
      return;
    }

    this.projectiles.delete(id);
    this.io.to(this.roomId).emit('projectile-hit', { id, v: victim.id });
    this.hitPlayer(shooter.id, victim, false);
  }

  /**
   * Il colpo è plausibile se, all'età dichiarata dal tiratore (`claimedAge`,
   * ms), il proiettile passava vicino a dove il server sapeva che fosse il
   * bersaglio in quello stesso istante (storico posizioni). Rivedere il
   * passato rende la verifica indipendente dalla latenza di chi spara.
   */
  _claimPlausible(proj, victim, now, claimedAge) {
    const ageNow = proj.ageMs(now);
    if (ageNow < 0 || ageNow > proj.lifetime + HIT_CLAIM_GRACE_MS) return false;

    let impactAge = Number.isFinite(claimedAge) ? clamp(claimedAge, 0, proj.lifetime) : ageNow;
    if (impactAge > ageNow + 150) impactAge = Math.min(ageNow, proj.lifetime); // niente colpi "dal futuro"

    const v = victim.positionAt(proj.spawnAt + impactAge, { x: 0, y: 0, z: 0 });
    const R = FLY_ALTITUDE;
    const victimSpeed = (victim.speed ?? BASE_SPEED) * R; // unità/s
    const tol = BULLET_HIT_RADIUS + HIT_CLAIM_BASE_TOLERANCE + victimSpeed * HIT_CLAIM_TIME_WINDOW;

    // Un po' di margine sull'istante: gli orologi di client e server non
    // coincidono al millisecondo (la latenza è una stima).
    const from = Math.max(0, impactAge - 150);
    const to = Math.min(proj.lifetime, impactAge + 150);
    const a = proj.pointAt(from, { x: 0, y: 0, z: 0 });
    const b = { x: 0, y: 0, z: 0 };
    let best = Infinity;
    for (let t = from + 20; t <= to + 19.999; t += 20) {
      proj.pointAt(Math.min(t, to), b);
      const d2 = segmentPointDistSq(a.x * R, a.y * R, a.z * R, b.x * R, b.y * R, b.z * R, v.x * R, v.y * R, v.z * R);
      if (d2 < best) best = d2;
      a.x = b.x; a.y = b.y; a.z = b.z;
    }
    return best <= tol * tol;
  }

  // ── Bomba ──────────────────────────────────────────────────────────────────

  playerDropBomb(socketId, data) {
    const player = this.players.get(socketId);
    if (!player || !player.alive) return;

    const theta = clampTheta(data?.theta) ?? player.theta;
    const phi = Number.isFinite(data?.phi) ? wrapAngle01(data.phi) : player.phi;
    this._addBomb(player.id, theta, phi);
  }

  _addBomb(ownerId, theta, phi) {
    this.bombs.push({
      id: `B${this._nextBombId++}`,
      ownerId,
      theta,
      phi,
      altitude: FLY_ALTITUDE,
    });
  }

  // ── Tick principale ────────────────────────────────────────────────────────

  tick() {
    const now = Date.now();

    // Bot AI: aggiorna heading e flags prima del calcolo del movimento.
    // La virata risultante serve ai client per estrapolare il volo.
    for (const player of this.players.values()) {
      if (!player.isBot || !player.alive) continue;
      const before = player.heading;
      player.tickAI(this, TICK_DT);
      player.turnRate = wrapAnglePi(player.heading - before) / TICK_DT;
    }

    // Predizione movimento: il server muove ogni player nella direzione corrente
    // tra un input e l'altro, così il game-state contiene sempre posizioni fresche.
    for (const player of this.players.values()) {
      if (!player.alive) continue;
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

      let speed;
      let turn;
      if (player.isBot) {
        speed = computedSpeed(player, canBoost);
        turn = 0; // l'IA ha già girato l'heading in questo tick
      } else if (now - player.lastInputTime < INPUT_FRESH_MS && player.clientSpeed != null) {
        // Il client dichiara velocità e virata effettive (tiene conto anche del
        // freno e del rallentamento in curva su mobile, che il server non vede).
        speed = player.clientSpeed;
        turn = player.clientTurnRate ?? 0;
      } else {
        speed = computedSpeed(player, canBoost);
        turn = 0;
      }
      player.speed = speed;
      if (!player.isBot) player.turnRate = turn;

      const moved = advanceOnSphere(player.theta, player.phi, player.heading, speed, turn, TICK_DT);
      player.theta = moved.theta;
      player.phi = wrapAngle01(moved.phi);
      player.heading = wrapAngle01(moved.heading);
    }

    // Storico posizioni per la verifica dei colpi nel passato
    for (const player of this.players.values()) {
      if (player.alive) player.recordPosition(now);
    }

    // Collisioni tra aerei
    this._checkPlaneCollisions();

    // Proiettili: scadenza + impatti di bot e torrette (quelli dei giocatori
    // li decide chi spara, vedi claimHit).
    this._updateProjectiles(now);

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

    // Edifici: conquista + torrette
    for (const building of this.buildings.values()) {
      building.updateConquest(this.players);

      const proj = building.updateTurret(this.players);
      if (proj && this.projectiles.size < MAX_ACTIVE_PROJECTILES) {
        this.projectiles.set(proj.id, proj);
        this._emitShots(
          proj.id.slice(0, -2), proj.ownerId, proj.theta, proj.phi,
          [proj.heading], proj.speed, proj.lifetime, proj.spawnAt,
        );
      }
    }

    // Respawn
    for (const player of this.players.values()) {
      if (!player.alive && player.respawnAt && now >= player.respawnAt) {
        this.respawnPlayer(player);
      }
    }

    // Broadcast stato. `volatile`: se il client non è pronto a ricevere (rete
    // lenta, long-polling tra una richiesta e l'altra) lo stato viene scartato
    // invece di accodarsi. Uno stato vecchio non serve a nessuno, e una coda
    // di stati vecchi è esattamente il "lag che si accumula".
    this.io.to(this.roomId).volatile.emit('game-state', {
      players: [...this.players.values()].map(p => p.toState()),
      powerups: [...this.powerups.values()].map(p => p.toState()),
      bombs: this.bombs.map(b => ({
        id: b.id,
        ownerId: b.ownerId,
        theta: r4(b.theta),
        phi: r4(b.phi),
        altitude: Math.round(b.altitude * 100) / 100,
      })),
    });

    // Edifici: cambiano di rado, quindi viaggiano solo quando cambiano (e in
    // modo affidabile, non volatile).
    const buildings = [...this.buildings.values()].map(b => b.toState());
    const json = JSON.stringify(buildings);
    if (json !== this._lastBuildingsJson) {
      this._lastBuildingsJson = json;
      this.io.to(this.roomId).emit('buildings', buildings);
    }
  }

  _updateProjectiles(now) {
    const r2 = BULLET_HIT_RADIUS * BULLET_HIT_RADIUS;
    for (const [id, proj] of this.projectiles) {
      const age = proj.ageMs(now);
      // I proiettili dei giocatori restano un po' oltre la scadenza per
      // accettare i claim che arrivano in ritardo.
      if (age > proj.lifetime + (proj.serverHits ? 0 : HIT_CLAIM_GRACE_MS)) {
        this.projectiles.delete(id);
        continue;
      }
      if (!proj.serverHits) continue;

      proj.advance(now);
      const a = proj.prev, b = proj.cur, R = FLY_ALTITUDE;
      for (const player of this.players.values()) {
        if (!player.alive) continue;
        if (player.id === proj.ownerId) continue;
        // Proiettili torretta non colpiscono il proprietario della torre
        if (proj.buildingOwnerId && player.id === proj.buildingOwnerId) continue;

        const st = Math.sin(player.theta);
        const d2 = segmentPointDistSq(
          a.x * R, a.y * R, a.z * R,
          b.x * R, b.y * R, b.z * R,
          R * st * Math.cos(player.phi), R * Math.cos(player.theta), R * st * Math.sin(player.phi),
        );
        if (d2 < r2) {
          this.projectiles.delete(id);
          this.io.to(this.roomId).emit('projectile-hit', { id, v: player.id });
          this.hitPlayer(proj.buildingOwnerId || proj.ownerId, player, !!proj.buildingOwnerId);
          break;
        }
      }
    }
  }

  // ── Logica colpi ──────────────────────────────────────────────────────────

  /** Invulnerabile adesso (respawn recente o scudo appena perso)? */
  _isInvulnerable(victim, now) {
    return (victim.respawnInvincibleUntil && now < victim.respawnInvincibleUntil) || victim.shieldInvincible;
  }

  /** Se il bersaglio ha lo scudo lo consuma e restituisce true. */
  _absorbWithShield(victim) {
    if (!victim.hasShield) return false;
    victim.hasShield = false;
    victim.shieldInvincible = true;
    setTimeout(() => { victim.shieldInvincible = false; }, SHIELD_INVINCIBILITY);
    this.io.to(this.roomId).emit('shield-broken', { playerId: victim.id });
    return true;
  }

  /** Morte: azzera lo stato, programma il respawn e lascia forse un powerup. */
  _applyDeath(victim, now, killEvent) {
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

    this.io.to(this.roomId).emit('player-killed', {
      victimId: victim.id,
      theta: victim.theta,
      phi: victim.phi,
      ...killEvent,
    });

    if (Math.random() < POWERUP_DROP_CHANCE) {
      const pu = new PowerUp('weapon', victim.theta, victim.phi);
      this.powerups.set(pu.id, pu);
      this.io.to(this.roomId).emit('powerup-spawned', pu.toState());
    }
  }

  hitPlayer(killerId, victim, isTurret = false) {
    const now = Date.now();
    if (this._isInvulnerable(victim, now)) return;
    if (this._absorbWithShield(victim)) return;

    const killer = this.getPlayerById(killerId);
    if (killer) killer.kills++;

    this._applyDeath(victim, now, { killerId, byTurret: isTurret });

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
    player.turnRate = 0;
    player.clientSpeed = null;
    player.clientTurnRate = 0;
    player.lastClientTheta = null;
    player.lastClientPhi = null;
    player.clearHistory();

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
   * Raccolta lungo il percorso reale dichiarato dal client (da un input al
   * successivo). La raccolta su posizione *predetta* dal server è stata tolta:
   * in virata la predizione diverge e regalava powerup mai toccati.
   * Il client, che conosce la posizione esatta, manda anche `try-collect`.
   */
  _checkPowerupCollectionAlongPath(player, t0, p0, t1, p1) {
    if (this.powerups.size === 0) return;
    const r = FLY_ALTITUDE;
    const a = this.sphericalToCartesian(t0, p0, 1);
    const b = this.sphericalToCartesian(t1, p1, 1);
    const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
    const omega = Math.acos(dot);

    const toRemove = [];
    for (const [id, pu] of this.powerups) {
      if (this._powerupHitByArc(a, b, omega, pu, r)) {
        this.collectPowerup(player, pu);
        toRemove.push(id);
      }
    }
    for (const id of toRemove) this.powerups.delete(id);
  }

  /** Distanza minima dal powerup all'arco di grande cerchio tra A e B (unitari). */
  _powerupHitByArc(a, b, omega, pu, r) {
    const p = this.sphericalToCartesian(pu.theta, pu.phi, r);
    const sinOmega = Math.sin(omega);
    const samples = omega < 1e-6 ? 1 : 12;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      let s0 = 1 - t, s1 = t;
      if (omega >= 1e-6) {
        s0 = Math.sin((1 - t) * omega) / sinOmega;
        s1 = Math.sin(t * omega) / sinOmega;
      }
      const dx = r * (s0 * a.x + s1 * b.x) - p.x;
      const dy = r * (s0 * a.y + s1 * b.y) - p.y;
      const dz = r * (s0 * a.z + s1 * b.z) - p.z;
      if (dx * dx + dy * dy + dz * dz < POWERUP_COLLECT_RADIUS * POWERUP_COLLECT_RADIUS) return true;
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
      if (this._isInvulnerable(victim, now)) continue;
      if (this._absorbWithShield(victim)) continue;
      this._applyDeath(victim, now, { killerId: null, byCollision: true });
      anyDied = true;
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
    this._addBomb(bot.id, bot.theta, bot.phi);
  }
}
