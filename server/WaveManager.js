/**
 * Traccia lo stato degli obiettivi di una singola wave della modalità Sfida.
 * Non contiene logica di gioco — riceve notifiche da ChallengeGame e risponde
 * con decisioni (isComplete, shouldRespawn).
 */
export class WaveManager {
  constructor(waveCfg, game) {
    this.cfg = waveCfg;
    this.game = game;
    this.kills = 0;
    this.targetDestroyed = false;
    this.bossId = null;
    this.bossLives = waveCfg.boss?.lives ?? 0;
  }

  /** Ritorna true quando l'obiettivo della wave è raggiunto. */
  isComplete() {
    const { cfg, game } = this;

    // Wave boss: il boss deve essere eliminato (bossLives = 0)
    if (cfg.boss) {
      return this.bossLives <= 0;
    }

    // Wave con target: prima distruggi il target, poi elimina tutti i bot nemici
    if (cfg.hasTarget) {
      if (!this.targetDestroyed) return false;
      for (const player of game.players.values()) {
        if (player.isBot && player.faction === 'enemy') {
          if (player.alive || player.respawnAt !== null) return false;
        }
      }
      return true;
    }

    // Wave con kill goal
    if (cfg.killGoal !== null && cfg.killGoal !== undefined) {
      return this.kills >= cfg.killGoal;
    }

    return false;
  }

  /**
   * Notifica un kill. Conta solo i kill del player umano e dei bot alleati.
   * @param {string} killerId - Player.id dell'attaccante (o buildingOwnerId)
   * @param {string} victimId - Player.id della vittima
   */
  onKill(killerId, victimId) {
    const killer = this.game.getPlayerById(killerId);
    if (!killer) return;
    const isHuman = killer.socketId === this.game.humanSocketId;
    const isAlly = killer.isBot && killer.faction === 'ally';
    if (isHuman || isAlly) {
      this.kills++;
    }
  }

  /** Chiamato quando la bomba distrugge il target della wave. */
  onTargetDestroyed() {
    this.targetDestroyed = true;
  }

  /**
   * Chiamato quando il boss viene colpito. Decrementa le vite e ritorna il valore aggiornato.
   * @returns {number} vite rimanenti del boss
   */
  onBossHit() {
    this.bossLives = Math.max(0, this.bossLives - 1);
    return this.bossLives;
  }

  /**
   * Decide se un bot nemico deve rispawnare in base alla respawnMode della wave.
   * @param {string} botId - Player.id del bot
   */
  shouldRespawn(botId) {
    const mode = this.cfg.respawnMode;
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    if (mode === 'until_target') return !this.targetDestroyed;
    return false;
  }

  /** Stato corrente per broadcast al client. */
  getStatus() {
    return {
      kills: this.kills,
      killGoal: this.cfg.killGoal,
      targetDestroyed: this.targetDestroyed,
      bossLives: this.bossLives,
      bossMaxLives: this.cfg.boss?.lives ?? 0,
    };
  }
}
