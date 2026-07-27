/**
 * Sonda A/B del costo di rendering, eseguita sulla macchina del giocatore.
 *
 * Serve perché il costo per-pixel non si può indovinare da lontano: dipende
 * dalla GPU, dalla risoluzione e dal fattore di scala del sistema operativo.
 * La sonda spegne un effetto alla volta, misura il tempo di frame e stampa
 * quanto si guadagnerebbe a rinunciarci — così si interviene su ciò che pesa
 * davvero invece che su ciò che sembra pesare.
 *
 * Due accorgimenti che sembrano dettagli e non lo sono:
 *
 * 1. **Il riferimento viene rimisurato prima di ogni scenario.** Una prima
 *    versione misurava il riferimento una volta sola all'inizio e confrontava
 *    tutto con quello: siccome l'intera sonda dura decine di secondi, qualsiasi
 *    deriva (throttling termico, altre finestre, il ciclo giorno/notte)
 *    finiva attribuita all'ultimo effetto misurato — alcuni risultavano
 *    addirittura "più lenti che accesi". Confrontando ogni scenario con il
 *    riferimento appena precedente la deriva lenta si annulla.
 *
 * 2. **Il ciclo giorno/notte va congelato** (`freeze`), altrimenti la nebulosa
 *    misurata a mezzogiorno non costa nulla e l'acqua misurata a notte fonda
 *    costa il doppio: si confronterebbero scene diverse.
 *
 * Si avvia con il tasto F9 in partita.
 */

/** Frame scartati dopo ogni cambio, per far assestare pipeline e cache. */
const WARMUP_FRAMES = 15;
/** Frame misurati per ogni configurazione. */
const SAMPLE_FRAMES = 40;

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) * 0.5;
}

export class PerfProbe {
  /**
   * @param {Array<{label: string, off: () => void, on: () => void}>} scenarios
   *        Ogni voce spegne (`off`) e riaccende (`on`) un singolo effetto.
   * @param {{freeze?: (frozen: boolean) => void}} [hooks]
   *        `freeze` mette in pausa le animazioni che cambierebbero la scena
   *        durante la misura (ciclo giorno/notte).
   */
  constructor(scenarios, hooks = {}) {
    this.scenarios = scenarios;
    this.hooks = hooks;
    this.running = false;
    this.progress = '';
    this._steps = [];
  }

  start(onFinish) {
    if (this.running) return;
    this.running = true;
    this._onFinish = onFinish ?? null;
    this._results = [];
    this.hooks.freeze?.(true);

    // Alterna riferimento e scenario: [rif, A, rif, B, rif, C, …]
    this._steps = [];
    for (const s of this.scenarios) {
      this._steps.push({ kind: 'base' });
      this._steps.push({ kind: 'test', scenario: s });
    }
    this._stepIndex = 0;
    this._enterStep();
  }

  _enterStep() {
    const step = this._steps[this._stepIndex];
    if (step.kind === 'test') step.scenario.off();
    this._warmup = WARMUP_FRAMES;
    this._samples = [];
    const n = this._steps.length;
    this.progress = `misurazione ${this._stepIndex + 1}/${n}…`;
  }

  _leaveStep() {
    const step = this._steps[this._stepIndex];
    const ms = median(this._samples);
    if (step.kind === 'test') {
      step.scenario.on();
      this._results.push({ label: step.scenario.label, ms, base: this._lastBase });
    } else {
      this._lastBase = ms;
      this._bases = this._bases ?? [];
      this._bases.push(ms);
    }
  }

  /** Da chiamare una volta per frame con il tempo di frame in millisecondi. */
  tick(frameMs) {
    if (!this.running) return;
    if (this._warmup > 0) { this._warmup--; return; }

    this._samples.push(frameMs);
    if (this._samples.length < SAMPLE_FRAMES) return;

    this._leaveStep();
    this._stepIndex++;

    if (this._stepIndex >= this._steps.length) {
      this.running = false;
      this.hooks.freeze?.(false);
      const report = this._format();
      console.log(report);
      this._onFinish?.(report, this._results);
      return;
    }
    this._enterStep();
  }

  _format() {
    const bases = this._bases ?? [];
    const baseMedian = median(bases);
    const spread = bases.length ? Math.max(...bases) - Math.min(...bases) : 0;

    const rows = this._results
      .map(r => ({ ...r, saved: r.base - r.ms }))
      .sort((a, b) => b.saved - a.saved);

    const L = [];
    L.push('── Costo di rendering su questa macchina ──');
    L.push(`riferimento ${baseMedian.toFixed(1)} ms/frame (${(1000 / baseMedian).toFixed(0)} FPS)`);
    L.push('');
    L.push('spegnendo…'.padEnd(30) + 'ms'.padStart(7) + 'risparmio'.padStart(11) + '   FPS');
    L.push('─'.repeat(56));
    for (const r of rows) {
      const pct = r.base > 0 ? (r.saved / r.base * 100) : 0;
      const savedTxt = `${r.saved >= 0 ? '−' : '+'}${Math.abs(r.saved).toFixed(1)} ms`;
      L.push(
        r.label.slice(0, 29).padEnd(30) +
        r.ms.toFixed(1).padStart(7) +
        savedTxt.padStart(11) +
        `  ${pct >= 0 ? ' ' : ''}${pct.toFixed(0)}%`.padStart(7) +
        `  ${(1000 / r.ms).toFixed(0)}`,
      );
    }
    L.push('');
    // Se il riferimento stesso oscilla molto, i singoli risparmi valgono poco.
    if (baseMedian > 0 && spread > baseMedian * 0.15) {
      L.push(`ATTENZIONE: il riferimento oscilla di ${spread.toFixed(1)} ms tra una`);
      L.push('misura e l\'altra. Chiudi le altre applicazioni e ripeti: sotto');
      L.push('questa soglia di rumore i risparmi piccoli non sono attendibili.');
    } else {
      L.push('Gli effetti non si sommano linearmente, ma la classifica dice');
      L.push('da dove conviene cominciare.');
    }
    return L.join('\n');
  }
}
