/**
 * Sonda A/B del costo di rendering, eseguita sulla macchina del giocatore.
 *
 * Serve perché il costo per-pixel non si può indovinare da lontano: dipende
 * dalla GPU, dalla risoluzione e dal fattore di scala del sistema operativo.
 * La sonda spegne un effetto alla volta, misura il tempo di frame e stampa
 * quanto si guadagnerebbe a rinunciarci — così si interviene su ciò che pesa
 * davvero invece che su ciò che sembra pesare.
 *
 * Tre accorgimenti che sembrano dettagli e non lo sono. Nascono tutti da una
 * prima versione che dava risultati assurdi, con effetti che risultavano *più
 * lenti da spenti*:
 *
 * 1. **Ogni scenario è racchiuso fra due riferimenti** e confrontato con la
 *    loro media. Misurare il riferimento una volta sola all'inizio significa
 *    attribuire all'ultimo effetto misurato tutta la deriva accumulata in
 *    decine di secondi (throttling termico, altre finestre, ciclo giorno e
 *    notte). Con la media dei due riferimenti che lo racchiudono si annulla
 *    anche la deriva lineare, non solo quella lenta.
 *
 * 2. **Il ciclo giorno/notte va congelato** (`freeze`), altrimenti la nebulosa
 *    misurata a mezzogiorno non costa nulla e l'acqua misurata a notte fonda
 *    costa il doppio: si confronterebbero scene diverse.
 *
 * 3. **Il rumore si misura con la differenza seconda**, non con lo scarto
 *    max−min. Una GPU che scala la frequenza mentre si scalda fa esplodere lo
 *    scarto pur restando perfettamente correggibile: avvisare lì è un falso
 *    allarme che porta a diffidare di dati buoni.
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
   * @param {{freeze?: (frozen: boolean) => void, context?: () => string[]}} [hooks]
   *        `freeze` mette in pausa le animazioni che cambierebbero la scena
   *        durante la misura (ciclo giorno/notte); `context` descrive le
   *        condizioni in cui la misura è avvenuta, così due referti presi in
   *        momenti diversi si possono confrontare.
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
    this._bases = [];
    this.hooks.freeze?.(true);

    // Alterna riferimento e scenario e chiude con un riferimento:
    // [rif, A, rif, B, rif, C, rif]. La misura finale serve perché anche
    // l'ultimo scenario sia racchiuso fra due riferimenti come tutti gli altri.
    this._steps = [];
    for (const s of this.scenarios) {
      this._steps.push({ kind: 'base' });
      this._steps.push({ kind: 'test', scenario: s });
    }
    this._steps.push({ kind: 'base' });
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
      // Il riferimento a cui confrontarsi è quello *appena prima*; in fase di
      // referto si userà la media con quello subito dopo, che a quel punto è
      // già stato misurato (vedi _format).
      this._results.push({ label: step.scenario.label, ms, baseIndex: this._bases.length - 1 });
    } else {
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
    const bases = this._bases;
    const baseMedian = median(bases);

    /**
     * Rumore residuo del riferimento, come differenza seconda mediana.
     *
     * Non si usa lo scarto max−min: una deriva *regolare* (la GPU che scala la
     * frequenza mentre si scalda) lo fa esplodere, ma è proprio ciò che la
     * media fra i due riferimenti che racchiudono ogni scenario già corregge —
     * segnalarla sarebbe un falso allarme che porta a diffidare di dati buoni.
     * La differenza seconda vale zero su qualunque andamento lineare e cresce
     * solo quando il riferimento sobbalza in modo imprevedibile: è quello che
     * rende inattendibile un singolo confronto.
     */
    const secondDiffs = [];
    for (let i = 0; i + 2 < bases.length; i++) {
      secondDiffs.push(Math.abs(bases[i + 2] - 2 * bases[i + 1] + bases[i]));
    }
    const noise = median(secondDiffs);

    // Ogni scenario è misurato fra due riferimenti: la loro media cancella
    // anche la deriva *lineare* dentro la singola coppia, non solo quella
    // lenta sull'intera sonda. I dati c'erano già, bastava usarli.
    const rows = this._results
      .map(r => {
        const before = bases[r.baseIndex] ?? baseMedian;
        const after = bases[r.baseIndex + 1] ?? before;
        const base = (before + after) * 0.5;
        return { ...r, base, saved: base - r.ms };
      })
      .sort((a, b) => b.saved - a.saved);

    const L = [];
    L.push('── Costo di rendering su questa macchina ──');
    L.push(`riferimento ${baseMedian.toFixed(1)} ms/frame (${(1000 / baseMedian).toFixed(0)} FPS)`);
    // Senza queste righe due referti non sono confrontabili: la stessa scena
    // in una finestra più piccola, o con meno oggetti in vista, costa tutt'altro.
    for (const line of this.hooks.context?.() ?? []) L.push(line);
    L.push('');
    L.push('spegnendo…'.padEnd(30) + 'ms'.padStart(7) + 'risparmio'.padStart(11) + '%'.padStart(7) + '  FPS');
    L.push('─'.repeat(57));
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
    // Se il riferimento sobbalza, i singoli risparmi valgono poco.
    if (baseMedian > 0 && noise > baseMedian * 0.12) {
      L.push(`ATTENZIONE: il riferimento è instabile (rumore ~${noise.toFixed(1)} ms).`);
      L.push('Chiudi le altre applicazioni e ripeti: sotto questa soglia i');
      L.push('risparmi piccoli non sono attendibili.');
    } else {
      L.push('Gli effetti non si sommano linearmente, ma la classifica dice');
      L.push('da dove conviene cominciare.');
    }
    return L.join('\n');
  }
}
