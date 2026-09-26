/**
 * Scala automatica della risoluzione di rendering.
 *
 * Perché serve: la stessa macchina rende in modo molto diverso a seconda
 * dell'alimentazione. Misurato con la sonda F9 su Intel Iris Xe, il tempo di
 * frame passa da 18.8 ms a corrente a 37.6 ms a batteria — e il caricabatterie
 * si può staccare a metà partita, quando un selettore manuale in lobby non
 * serve più a niente. Solo una regolazione continua può reggere quel caso.
 *
 * Perché tocca **solo la risoluzione**: nel progetto una modalità automatica
 * era già esistita ed era stata rimossa. Il difetto delle regolazioni
 * automatiche è il "pop" — elementi che appaiono e spariscono mentre giochi,
 * che è molto più fastidioso di qualche frame in meno. Un cambio di
 * risoluzione invece non fa apparire né sparire nulla: cambia solo la
 * nitidezza, e in movimento è quasi impercettibile. Qui quindi non si spegne
 * mai nulla di visibile.
 *
 * Contro le oscillazioni ci sono tre difese:
 *  - una **zona morta larga** fra la soglia di discesa e quella di risalita,
 *    così un tempo di frame intermedio non fa fare avanti e indietro;
 *  - un **periodo di quiete** dopo ogni cambio, perché la nuova risoluzione si
 *    assesti prima di rimisurare;
 *  - un **blocco per livello**: se da un livello si è già dovuti scendere due
 *    volte, quel livello viene dichiarato irraggiungibile e non ci si torna.
 *    Senza questo, una macchina al limite salirebbe e scenderebbe per sempre.
 *
 * Si misura la **mediana** della finestra, non la media: un singolo picco (una
 * raccolta della memoria, una compilazione di shader) non deve far degradare
 * la risoluzione di tutta la partita.
 *
 * Ogni gradino porta con sé anche i campioni MSAA. Il primo a cedere è metà
 * dell'MSAA (4x → 2x): a parità di pixel costa parecchia banda e si vede
 * poco. Poi scende la risoluzione, e solo all'ultimo gradino l'MSAA sparisce
 * del tutto (il GradePass lo sostituisce con un FXAA). Cambiare i campioni
 * rialloca il render target ma non ricompila nulla: non entrano nella chiave
 * dei programmi.
 */

/** Sopra questo tempo di frame si scende di un gradino (~48 FPS). */
const SLOW_MS = 21;
/** Sotto questo si risale (~80 FPS). Fra i due c'è la zona morta. */
const FAST_MS = 12.5;
/** Frame per campione. A 60 FPS è circa mezzo secondo. */
const WINDOW_FRAMES = 40;
/** Frame di quiete dopo un cambio, prima di rimisurare. */
const SETTLE_FRAMES = 90;
/** Frame ignorati all'avvio: caricamenti e prime compilazioni non contano. */
const STARTUP_FRAMES = 150;
/** Quante discese da uno stesso livello prima di dichiararlo irraggiungibile. */
const MAX_FAILURES = 2;

/** Mediana; ordina l'array sul posto (la finestra viene svuotata subito dopo). */
function median(values) {
  const s = values.sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) * 0.5;
}

export class AdaptiveResolution {
  /**
   * @param {object}   opts
   * @param {number}   opts.baseDpr        risoluzione scelta dal profilo qualità
   * @param {(step: {dpr: number, msaa: number}) => void} opts.apply
   *        applica risoluzione e campioni MSAA al renderer
   * @param {number}   [opts.floor]        risoluzione minima assoluta
   * @param {number}   [opts.maxSamples]   campioni MSAA al gradino più alto (0 = niente MSAA)
   */
  constructor({ baseDpr, apply, floor = 0.7, maxSamples = 0 }) {
    const mid = Math.min(maxSamples, 2);
    const raw = [
      ...(maxSamples > mid ? [{ f: 1, msaa: maxSamples }] : []),
      { f: 1, msaa: mid },
      { f: 0.85, msaa: mid },
      { f: 0.72, msaa: mid },
      { f: 0.6, msaa: 0 },
    ].map(s => ({ dpr: Math.max(floor, baseDpr * s.f), msaa: s.msaa }));
    // Gradini decrescenti, senza duplicati e mai sotto il minimo.
    this.steps = raw.filter((v, i) => i === 0
      || Math.abs(v.dpr - raw[i - 1].dpr) > 0.02 || v.msaa !== raw[i - 1].msaa);

    this.apply = apply;
    this.level = 0;
    this.minLevel = 0;             // non si risale sopra questo livello
    this.failures = new Array(this.steps.length).fill(0);
    this.enabled = true;

    this._samples = [];
    this._settle = STARTUP_FRAMES;
    this._changes = 0;
  }

  /** Gradino attualmente applicato: `{ dpr, msaa }`. */
  get step() {
    return this.steps[this.level];
  }

  /** Risoluzione attualmente applicata. */
  get dpr() {
    return this.steps[this.level].dpr;
  }

  /** Campioni MSAA attualmente applicati. */
  get msaa() {
    return this.steps[this.level].msaa;
  }

  /** Descrizione breve per l'overlay diagnostico. */
  get label() {
    const pct = Math.round(this.dpr / this.steps[0].dpr * 100);
    const aa = this.msaa > 0 ? ` · MSAA ${this.msaa}x` : (this.steps[0].msaa > 0 ? ' · FXAA' : '');
    return (pct === 100 ? `${this.dpr.toFixed(2)}x` : `${this.dpr.toFixed(2)}x (${pct}%)`) + aa;
  }

  /** Sospende la regolazione, ad esempio mentre la sonda F9 misura. */
  setEnabled(on) {
    this.enabled = on;
    if (!on) this._samples.length = 0;
    this._settle = SETTLE_FRAMES;
  }

  _goTo(level) {
    if (level === this.level) return;
    this.level = level;
    this._changes++;
    this._samples.length = 0;
    this._settle = SETTLE_FRAMES;
    this.apply(this.step);
  }

  /** Da chiamare una volta per frame con il tempo di frame in millisecondi. */
  tick(frameMs) {
    if (!this.enabled) return;
    if (this._settle > 0) { this._settle--; return; }
    if (!Number.isFinite(frameMs) || frameMs <= 0) return;

    this._samples.push(frameMs);
    if (this._samples.length < WINDOW_FRAMES) return;

    const ms = median(this._samples);
    this._samples.length = 0;

    if (ms > SLOW_MS && this.level < this.steps.length - 1) {
      // Il livello attuale non regge: annotalo e scendi.
      this.failures[this.level]++;
      if (this.failures[this.level] >= MAX_FAILURES) {
        this.minLevel = Math.max(this.minLevel, this.level + 1);
      }
      this._goTo(this.level + 1);
      return;
    }

    if (ms < FAST_MS && this.level > this.minLevel) {
      this._goTo(this.level - 1);
    }
  }
}
