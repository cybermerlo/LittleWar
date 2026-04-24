import { Game } from './Game.js';
import { WaveManager } from './WaveManager.js';
import { SFIDA_WAVES } from '../shared/sfida-waves.js';
import { BotPlayer, BOT_NAMES } from './BotPlayer.js';
import { FLY_ALTITUDE, TICK_INTERVAL, RESPAWN_DELAY } from '../shared/constants.js';

const TICK_DT = TICK_INTERVAL / 1000;

export class ChallengeGame extends Game {
  constructor(io, roomId, humanSocketId) {
    super(io, roomId);
    this.humanSocketId = humanSocketId;
    this.humanPlayerId = null;       // Player.id (number string), set after join
    this.currentWaveIdx = -1;
    this.waveManager = null;
    this.challengePlayerLives = 3;   // loaded from first wave
    this.challengeTimer = 0;         // secondi totali in gioco
    this.wavePhase = 'idle';         // 'idle' | 'countdown' | 'active' | 'complete'
    this._activeCountdown = null;    // interval ID countdown
    this._namePool = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    this._nameIdx = 0;
  }

  /** Deve essere chiamato dopo addPlayer(). Avvia la prima wave. */
  startChallenge() {
    const human = this.players.get(this.humanSocketId);
    if (!human) return;
    this.humanPlayerId = human.id;
    this.challengePlayerLives = SFIDA_WAVES[0].playerLives ?? 3;
    this._startWave(0);
  }

  // ── Override destroy ──────────────────────────────────────────────────────

  destroy() {
    if (this._activeCountdown) {
      clearInterval(this._activeCountdown);
      this._activeCountdown = null;
    }
    super.destroy();
  }

  // ── Wave management ───────────────────────────────────────────────────────

  _nextBotName() {
    const name = this._namePool[this._nameIdx % this._namePool.length];
    this._nameIdx++;
    return name;
  }

  _startWave(waveIdx) {
    if (this._activeCountdown) {
      clearInterval(this._activeCountdown);
      this._activeCountdown = null;
    }

    const waveCfg = SFIDA_WAVES[waveIdx];
    this.currentWaveIdx = waveIdx;
    this.wavePhase = 'countdown';
    this.waveManager = new WaveManager(waveCfg, this);

    // Rimuovi tutti i bot della wave precedente
    for (const [id, player] of this.players) {
      if (player.isBot) {
        this.players.delete(id);
        this.io.to(this.roomId).emit('player-left', { id });
      }
    }

    // Reset edifici
    for (const b of this.buildings.values()) b.reset();

    this.io.to(this.roomId).emit('wave-start', {
      wave: waveCfg.id,
      title: waveCfg.title,
      objective: waveCfg.objective,
      countdown: 5,
    });

    let seconds = 5;
    this._activeCountdown = setInterval(() => {
      seconds--;
      this.io.to(this.roomId).emit('wave-countdown', { seconds });
      if (seconds <= 0) {
        clearInterval(this._activeCountdown);
        this._activeCountdown = null;
        this._activateWave(waveCfg);
      }
    }, 1000);
  }

  _activateWave(waveCfg) {
    this.wavePhase = 'active';
    const human = this.players.get(this.humanSocketId);

    // Spawna bot nemici
    for (const enemyCfg of (waveCfg.enemies ?? [])) {
      const bot = this.addBot(0, Math.PI, human, this._nextBotName(), enemyCfg.color);
      bot.role = enemyCfg.role;
      bot.faction = 'enemy';
    }

    // Spawna boss
    if (waveCfg.boss) {
      const boss = this.addBot(0, Math.PI, human, waveCfg.boss.nickname, waveCfg.boss.color);
      boss.role = 'aggressor';
      boss.faction = 'enemy';
      boss.isBoss = true;
      boss.livesRemaining = waveCfg.boss.lives;
      boss.weaponLevel = waveCfg.boss.weaponLevel ?? 0;
      this.waveManager.bossId = boss.id;
      this.waveManager.bossLives = waveCfg.boss.lives;
    }

    // Spawna bot alleati
    for (const allyCfg of (waveCfg.allies ?? [])) {
      const bot = this.addBot(0, Math.PI, human, allyCfg.nickname ?? this._nextBotName(), allyCfg.color);
      bot.role = allyCfg.role;
      bot.faction = 'ally';
    }

    // Dai al player un edificio conquistato (wave 2)
    if (waveCfg.playerStartBuilding && human) {
      let nearestBuilding = null;
      let nearestDist = Infinity;
      for (const b of this.buildings.values()) {
        const dist = this.distanceSphere(human.theta, human.phi, b.theta, b.phi, FLY_ALTITUDE);
        if (dist < nearestDist) { nearestDist = dist; nearestBuilding = b; }
      }
      if (nearestBuilding) {
        nearestBuilding.ownerId = human.id;
        nearestBuilding.ownerColor = human.color;
        nearestBuilding.conquestProgress = 1;
      }
    }

    // Dai a un bot nemico un edificio già conquistato (wave 4)
    if (waveCfg.enemyStartBuilding) {
      const enemyBots = [...this.players.values()].filter(p => p.isBot && p.faction === 'enemy');
      if (enemyBots.length > 0) {
        const bot = enemyBots[Math.floor(Math.random() * enemyBots.length)];
        // Scegli l'edificio più lontano dal player
        let farthestBuilding = null;
        let farthestDist = 0;
        for (const b of this.buildings.values()) {
          const dist = human
            ? this.distanceSphere(human.theta, human.phi, b.theta, b.phi, FLY_ALTITUDE)
            : 0;
          if (dist > farthestDist) { farthestDist = dist; farthestBuilding = b; }
        }
        if (farthestBuilding) {
          farthestBuilding.ownerId = bot.id;
          farthestBuilding.ownerColor = bot.color;
          farthestBuilding.conquestProgress = 1;
        }
      }
    }

    this.io.to(this.roomId).emit('wave-active', { wave: waveCfg.id });
    this._broadcastChallengeState();
  }

  _onWaveComplete() {
    if (this.wavePhase !== 'active') return;
    this.wavePhase = 'complete';
    const waveId = this.waveManager.cfg.id;
    const nextWaveIdx = this.currentWaveIdx + 1;

    if (nextWaveIdx >= SFIDA_WAVES.length) {
      this.io.to(this.roomId).emit('challenge-complete', {
        timeSeconds: Math.round(this.challengeTimer),
        kills: this.waveManager.kills,
      });
    } else {
      this.io.to(this.roomId).emit('wave-complete', {
        wave: waveId,
        nextWave: SFIDA_WAVES[nextWaveIdx].id,
      });
      setTimeout(() => {
        // Verifica che il game sia ancora attivo (non distrutto)
        if (this.players.size > 0) this._startWave(nextWaveIdx);
      }, 3000);
    }
  }

  _broadcastChallengeState() {
    const wm = this.waveManager;
    this.io.to(this.roomId).emit('challenge-state', {
      lives: this.challengePlayerLives,
      kills: wm?.kills ?? 0,
      killGoal: wm?.cfg?.killGoal ?? null,
      bossLives: wm?.bossLives ?? 0,
      bossMaxLives: wm?.cfg?.boss?.lives ?? 0,
      timer: Math.round(this.challengeTimer),
      wave: wm?.cfg?.id ?? 1,
    });
  }

  // ── Override hitPlayer ────────────────────────────────────────────────────

  hitPlayer(killerId, victim, isTurret = false) {
    const waveCfg = this.waveManager?.cfg;

    // Niente fuoco amico (a meno che friendlyFire sia abilitato)
    if (waveCfg && !waveCfg.friendlyFire) {
      const killer = this.getPlayerById(killerId);
      if (killer) {
        const victimIsHuman = victim.socketId === this.humanSocketId;
        const killerIsAlly = killer.isBot && killer.faction === 'ally';
        const victimIsAlly = victim.isBot && victim.faction === 'ally';
        // Bot alleati non colpiscono il player umano e viceversa; ally-vs-ally protetto
        if ((killerIsAlly && (victimIsHuman || victimIsAlly))) return;
        if (!killer.isBot && killer.socketId === this.humanSocketId && victimIsAlly) return;
      }
      // Torrette di bot alleati non colpiscono il player
      if (isTurret) {
        const turretOwner = this.getPlayerById(killerId);
        if (turretOwner?.faction === 'ally' && victim.socketId === this.humanSocketId) return;
      }
    }

    // Boss multi-vite: decrementa prima di uccidere davvero
    if (victim.isBoss && this.waveManager) {
      const livesLeft = this.waveManager.onBossHit();
      this.io.to(this.roomId).emit('boss-hit', {
        bossId: victim.id,
        livesLeft,
        maxLives: this.waveManager.cfg.boss.lives,
      });
      this._broadcastChallengeState();
      if (livesLeft > 0) return; // ancora vivo
      // Vite a 0: cade nel kill normale sotto
    }

    // Kill normale (usa base class)
    super.hitPlayer(killerId, victim, isTurret);

    // Traccia kill nel WaveManager
    if (this.waveManager) {
      this.waveManager.onKill(killerId, victim.id);
    }

    // Se il player umano muore: scala le vite sfida
    if (victim.socketId === this.humanSocketId) {
      this.challengePlayerLives--;
      this._broadcastChallengeState();
      if (this.challengePlayerLives <= 0) {
        // Game over: blocca il respawn e segnala la sconfitta
        victim.respawnAt = null;
        this.io.to(this.roomId).emit('challenge-failed', {
          wave: this.waveManager?.cfg?.id ?? 1,
        });
        return;
      }
    }

    // Controlla se la wave è completata dopo il kill
    if (this.wavePhase === 'active' && this.waveManager?.isComplete()) {
      this._onWaveComplete();
    }

    this._broadcastChallengeState();
  }

  // ── Override respawnPlayer ────────────────────────────────────────────────

  respawnPlayer(player) {
    if (player.isBot) {
      // Il boss non rispawna mai via questo meccanismo (ha multi-vite)
      if (player.isBoss) {
        player.respawnAt = null;
        return;
      }
      // I bot nemici rispawnano solo se il WaveManager lo permette
      if (player.faction === 'enemy' && !this.waveManager?.shouldRespawn(player.id)) {
        player.respawnAt = null;
        // Potrebbe essere la condizione di completamento wave
        if (this.wavePhase === 'active' && this.waveManager?.isComplete()) {
          this._onWaveComplete();
        }
        return;
      }
      // Bot alleati rispawnano sempre (non soggetti a respawnMode)
    }
    super.respawnPlayer(player);
  }

  // ── Override bombLanded ───────────────────────────────────────────────────

  bombLanded(bomb) {
    const oldTargetId = this.target.id;
    super.bombLanded(bomb);
    // Rileva se il target è stato distrutto (base class crea un nuovo Target)
    if (this.target.id !== oldTargetId && this.waveManager) {
      this.waveManager.onTargetDestroyed();
      this.io.to(this.roomId).emit('challenge-target-destroyed', {
        wave: this.waveManager.cfg.id,
      });
      // Dopo la distruzione del target, controlla se la wave è già completata
      if (this.wavePhase === 'active' && this.waveManager.isComplete()) {
        this._onWaveComplete();
      }
    }
  }

  // ── Override tick ─────────────────────────────────────────────────────────

  tick() {
    super.tick();

    if (this.wavePhase === 'active') {
      this.challengeTimer += TICK_DT;

      // Broadcast challenge state ogni ~2 secondi (80 tick a 40 Hz)
      if (Math.round(this.challengeTimer * 40) % 80 === 0) {
        this._broadcastChallengeState();
      }

      // Controlla completamento wave (per casi non catturati in hitPlayer)
      if (this.waveManager?.isComplete()) {
        this._onWaveComplete();
      }
    }
  }
}
