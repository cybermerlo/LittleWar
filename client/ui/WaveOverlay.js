/**
 * Gestisce tutta la UI specifica della modalità Sfida:
 * - Overlay wave (titolo, obiettivo, countdown)
 * - Schermata vittoria / sconfitta
 * - HUD sfida (vite, timer, boss lives)
 */
export class WaveOverlay {
  constructor(onRetry) {
    this._onRetry = onRetry;

    this._overlayEl       = document.getElementById('wave-overlay');
    this._wTitleEl        = document.getElementById('wave-title');
    this._wObjEl          = document.getElementById('wave-objective');
    this._wCountdownEl    = document.getElementById('wave-countdown');

    this._failedEl        = document.getElementById('challenge-failed-screen');
    this._failedWaveEl    = document.getElementById('challenge-failed-wave');
    this._retryBtn        = document.getElementById('challenge-retry-btn');

    this._completeEl      = document.getElementById('challenge-complete-screen');
    this._completeTimeEl  = document.getElementById('challenge-complete-time');
    this._completeKillsEl = document.getElementById('challenge-complete-kills');
    this._completeBackBtn = document.getElementById('challenge-complete-back-btn');

    this._hudChallengeEl  = document.getElementById('hud-challenge');
    this._hudLivesEl      = document.getElementById('hud-lives');
    this._hudTimerEl      = document.getElementById('hud-timer');
    this._hudBossEl       = document.getElementById('hud-boss-lives');
    this._hudKillGoalEl   = document.getElementById('hud-kill-goal');

    this._retryBtn?.addEventListener('click', () => this._onRetry?.());
    this._completeBackBtn?.addEventListener('click', () => this._onRetry?.());
  }

  /** Mostra il pannello HUD specifico della sfida. */
  showHUD() {
    if (this._hudChallengeEl) this._hudChallengeEl.style.display = 'flex';
  }

  /** Nasconde il pannello HUD e tutti gli overlay sfida. */
  hideAll() {
    if (this._overlayEl)   this._overlayEl.style.display = 'none';
    if (this._failedEl)    this._failedEl.style.display = 'none';
    if (this._completeEl)  this._completeEl.style.display = 'none';
    if (this._hudChallengeEl) this._hudChallengeEl.style.display = 'none';
  }

  // ── Eventi dal server ─────────────────────────────────────────────────────

  onWaveStart({ wave, title, objective, countdown }) {
    if (!this._overlayEl) return;
    if (this._wTitleEl)    this._wTitleEl.textContent = title;
    if (this._wObjEl)      this._wObjEl.textContent = objective;
    if (this._wCountdownEl) this._wCountdownEl.textContent = countdown;
    this._overlayEl.style.display = 'flex';
    this._overlayEl.classList.remove('wave-overlay--active');
  }

  onWaveCountdown({ seconds }) {
    if (this._wCountdownEl) this._wCountdownEl.textContent = seconds > 0 ? seconds : 'VIA!';
  }

  onWaveActive({ wave }) {
    // Breve flash "VIA!" poi nascondi overlay
    if (this._wCountdownEl) this._wCountdownEl.textContent = 'VIA!';
    setTimeout(() => {
      if (this._overlayEl) this._overlayEl.style.display = 'none';
    }, 800);
  }

  onWaveComplete({ wave, nextWave }) {
    if (!this._overlayEl) return;
    if (this._wTitleEl)    this._wTitleEl.textContent = `WAVE ${wave} COMPLETATA!`;
    if (this._wObjEl)      this._wObjEl.textContent = nextWave ? `Preparati per la WAVE ${nextWave}…` : '';
    if (this._wCountdownEl) this._wCountdownEl.textContent = '';
    this._overlayEl.style.display = 'flex';
    // Si nasconderà autonomamente al prossimo wave-start
  }

  onChallengeState({ lives, kills, killGoal, bossLives, bossMaxLives, timer }) {
    if (this._hudLivesEl) {
      const hearts = '❤️'.repeat(Math.max(0, lives)) + '🖤'.repeat(Math.max(0, 3 - lives));
      this._hudLivesEl.textContent = hearts;
    }
    if (this._hudTimerEl) {
      const m = Math.floor(timer / 60).toString().padStart(2, '0');
      const s = (timer % 60).toString().padStart(2, '0');
      this._hudTimerEl.textContent = `${m}:${s}`;
    }
    if (this._hudBossEl) {
      if (bossMaxLives > 0) {
        const filled = Math.max(0, bossLives);
        const empty  = Math.max(0, bossMaxLives - filled);
        this._hudBossEl.textContent = '💜'.repeat(filled) + '🖤'.repeat(empty);
        this._hudBossEl.style.display = 'block';
      } else {
        this._hudBossEl.style.display = 'none';
      }
    }
    if (this._hudKillGoalEl) {
      if (killGoal !== null && killGoal !== undefined) {
        this._hudKillGoalEl.textContent = `Kill: ${kills}/${killGoal}`;
        this._hudKillGoalEl.style.display = 'block';
      } else {
        this._hudKillGoalEl.style.display = 'none';
      }
    }
  }

  onBossHit({ bossId, livesLeft, maxLives }) {
    // Aggiornamento immediato del contatore boss (lo challenge-state arriva subito dopo)
    if (this._hudBossEl && maxLives > 0) {
      const filled = Math.max(0, livesLeft);
      const empty  = Math.max(0, maxLives - filled);
      this._hudBossEl.textContent = '💜'.repeat(filled) + '🖤'.repeat(empty);
      this._hudBossEl.style.display = 'block';
    }
  }

  onChallengeFailed({ wave }) {
    if (this._overlayEl) this._overlayEl.style.display = 'none';
    if (this._failedWaveEl) this._failedWaveEl.textContent = `Wave ${wave}`;
    if (this._failedEl) this._failedEl.style.display = 'flex';
  }

  onChallengeComplete({ timeSeconds, kills }) {
    if (this._overlayEl) this._overlayEl.style.display = 'none';
    const m = Math.floor(timeSeconds / 60).toString().padStart(2, '0');
    const s = (timeSeconds % 60).toString().padStart(2, '0');
    if (this._completeTimeEl)  this._completeTimeEl.textContent = `${m}:${s}`;
    if (this._completeKillsEl) this._completeKillsEl.textContent = kills;
    if (this._completeEl) this._completeEl.style.display = 'flex';
  }
}
