import { getWeaponMoveSpeedPercent, WEAPON_HUD_BAR_FULL_LEVEL } from '../../shared/constants.js';
import { isLowPowerQuality } from '../utils/performanceProfile.js';
import { HudReticle } from './hud/HudReticle.js';
import { HudMarkers } from './hud/HudMarkers.js';
import { HudRadar } from './hud/HudRadar.js';

/**
 * HUD di partita: pillole (abbattimenti, torrette, arma, scudo, boost),
 * classifica, notifiche, kill feed, mirino, indicatori e radar.
 *
 * Regole che valgono per tutto il modulo, perché gira a ogni frame sopra un
 * canvas WebGL che è già il collo di bottiglia:
 * - si scrive nel DOM solo quando un valore cambia (testi, classi, transform);
 * - posizioni con `transform`, mai left/top (niente layout);
 * - niente backdrop-filter;
 * - i nickname degli altri passano sempre da textContent, mai da innerHTML.
 */

const TOAST_MAX = 3;
const KILLFEED_MS = 5500;
const STREAK_WINDOW_MS = 4000;
const STREAK_LABELS = ['', '', 'DOPPIO!', 'TRIPLO!', 'QUADRUPLO!'];
/** Entro quanto uno `shield-broken` si attribuisce a un nostro colpo appena segnato. */
const SHIELD_HIT_WINDOW_MS = 700;
const SCOREBOARD_MS = 250;

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgIcon(id, cls = 'lw-ico') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

function span(cls, text, parent) {
  const s = document.createElement('span');
  s.className = cls;
  if (text != null) s.textContent = text;
  parent?.appendChild(s);
  return s;
}

function scoreOf(p) {
  return (p.kills || 0) + (p.bombPoints || 0);
}

function byScore(a, b) {
  const d = scoreOf(b) - scoreOf(a);
  if (d !== 0) return d;
  return (a.nickname || '').localeCompare(b.nickname || '', undefined, { sensitivity: 'base' });
}

export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud:          $('hud'),
      kills:        $('hud-kills'),
      turrets:      $('hud-turrets'),
      rank:         $('hud-rank'),
      rankText:     $('hud-rank-text'),
      weapon:       $('hud-weapon'),
      speed:        $('hud-speed'),
      weaponFill:   $('hud-weapon-fill'),
      shield:       $('hud-shield'),
      boost:        $('hud-boost'),
      boostFill:    $('hud-boost-fill'),
      extremeBoost: $('hud-extreme-boost'),
      extremeLabel: $('hud-extreme-label'),
      players:      $('hud-players'),
      playerList:   $('player-list'),
      killfeed:     $('hud-killfeed'),
      toasts:       $('hud-toasts'),
      radioToast:   $('hud-radio-toast'),
    };

    this._reticle = new HudReticle();
    this._markers = new HudMarkers();
    this._radar = new HudRadar({ lowQuality: isLowPowerQuality() });

    /** Ultimo valore scritto per ogni elemento: si riscrive solo se cambia. */
    this._last = new Map();
    this._boostShown = -1;
    this._weaponBarShown = -1;
    this._boostActive = null;
    this._boostEmpty = null;
    this._extremeState = null;
    this._shieldOn = null;

    this._toasts = [];
    this._radioTimer = null;
    this._radioText = null;
    this._lastHit = { victimId: null, at: -Infinity };
    this._streak = { n: 0, at: -Infinity };
    this._localNick = null;
    this._localId = null;

    this._sorted = [];
    this._scoreboardKey = '';
    this._scoreboardAt = -Infinity;
    this._playersOpenTimer = null;

    this._W = window.innerWidth;
    this._H = window.innerHeight;
    window.addEventListener('resize', () => {
      this._W = window.innerWidth;
      this._H = window.innerHeight;
    });

    // Su telefono la classifica è chiusa: la pillola della posizione la apre.
    this.el.rank?.addEventListener('click', () => this._toggleScoreboard());

    this._buildRadioToast();
  }

  show() {
    this.el.hud.style.display = 'block';
    this._radar.invalidate();
  }

  hide() {
    this.el.hud.style.display = 'none';
    for (const t of [...this._toasts]) this._dropToast(t, true);
    this.el.killfeed?.replaceChildren();
    this._markers.hideAll();
    this._reticle.hide();
  }

  // ── Notifiche ──────────────────────────────────────────────────────────────

  /**
   * Notifica nella pila in alto al centro. Usabile anche da altri moduli
   * (es. conquista di una torretta): kind = kill | bomb | tower | bad | shield | info.
   */
  notify(kind, text, { icon = null, ms = 3200 } = {}) {
    const root = this.el.toasts;
    if (!root || !text) return;
    const now = performance.now();
    const last = this._toasts[this._toasts.length - 1];
    if (last && last.text === text && now - last.at < 400) return;
    while (this._toasts.length >= TOAST_MAX) this._dropToast(this._toasts[0], true);

    const node = document.createElement('div');
    node.className = `hud-toast hud-toast--${kind}`;
    if (icon) span('hud-toast-ico', null, node).appendChild(svgIcon(icon));
    span('hud-toast-text', text, node);
    root.appendChild(node);

    const entry = { node, text, at: now, timer: 0 };
    entry.timer = setTimeout(() => this._dropToast(entry, false), ms);
    this._toasts.push(entry);
  }

  _dropToast(entry, immediate) {
    const i = this._toasts.indexOf(entry);
    if (i < 0) return;
    this._toasts.splice(i, 1);
    clearTimeout(entry.timer);
    if (immediate) { entry.node.remove(); return; }
    entry.node.classList.add('is-leaving');
    setTimeout(() => entry.node.remove(), 320);
  }

  /** Hai abbattuto qualcuno (direttamente o con una tua torretta). */
  showKillNotice(nickname, byTurret = false) {
    if (byTurret) {
      this.notify('kill', nickname ? `La tua torretta ha abbattuto ${nickname}!` : 'La tua torretta ha abbattuto un nemico!', { icon: 'i-turret' });
      return;
    }
    this.notify('kill', nickname ? `Eliminato ${nickname}!` : 'Eliminazione!', { icon: 'i-crosshair' });
    // Conferma sul mirino: crocetta rossa, e la serie se gli abbattimenti
    // arrivano ravvicinati.
    this._reticle.flashHit('kill');
    const now = performance.now();
    this._streak.n = now - this._streak.at < STREAK_WINDOW_MS ? this._streak.n + 1 : 1;
    this._streak.at = now;
    if (this._streak.n >= 2) {
      this._reticle.showStreak(STREAK_LABELS[this._streak.n] ?? `SERIE ×${this._streak.n}`);
    }
  }

  showTowerDestroyedNotice() {
    this.notify('tower', 'Torretta nemica distrutta! +1', { icon: 'i-turret' });
  }

  showOwnTowerDestroyedNotice() {
    this.notify('bad', 'Hai distrutto la tua torretta — Coglione!', { icon: 'i-turret' });
  }

  showMyTurretDestroyedNotice(destroyerNickname) {
    this.notify('bad', destroyerNickname
      ? `La tua torretta è stata distrutta da ${destroyerNickname}!`
      : 'La tua torretta è stata distrutta!', { icon: 'i-turret' });
  }

  showBombHitNotice() {
    this.notify('bomb', 'Bersaglio colpito!', { icon: 'i-target' });
  }

  /**
   * Uno scudo si è rotto (evento `shield-broken`).
   * @param {object} o
   * @param {boolean} o.victimIsLocal  era il nostro scudo
   * @param {string}  [o.victimName]   nickname di chi l'ha perso
   * @param {boolean} [o.byLocal]      l'abbiamo rotto noi; se manca lo si deduce
   *                                   da `victimId` e dall'ultimo nostro colpo a segno
   * @param {string}  [o.victimId]
   */
  showShieldNotice({ victimIsLocal = false, victimName = null, byLocal, victimId = null } = {}) {
    if (victimIsLocal) {
      this.notify('shield', 'Scudo perso! Il prossimo colpo è fatale', { icon: 'i-shield', ms: 2600 });
      const pill = this.el.shield;
      if (pill && typeof pill.animate === 'function') {
        pill.animate(
          [
            { transform: 'scale(1.35) rotate(0deg)', color: '#ffffff' },
            { transform: 'scale(1.1) rotate(-14deg)', offset: 0.3 },
            { transform: 'scale(1.05) rotate(10deg)', offset: 0.6 },
            { transform: 'scale(1) rotate(0deg)' },
          ],
          { duration: 500, easing: 'ease-out' },
        );
      }
      return;
    }
    const mine = byLocal ?? (victimId != null
      && this._lastHit.victimId === victimId
      && performance.now() - this._lastHit.at < SHIELD_HIT_WINDOW_MS);
    if (!mine) return;
    this._reticle.flashHit('shield');
    this.notify('shield', victimName ? `Scudo di ${victimName} distrutto!` : 'Scudo distrutto!', { icon: 'i-shield', ms: 1800 });
  }

  /** Un nostro proiettile ha toccato un aereo sul nostro schermo. */
  registerLocalHit(victimId) {
    this._lastHit.victimId = victimId;
    this._lastHit.at = performance.now();
    this._reticle.flashHit('hit');
  }

  showRadioToast(stationName) {
    const el = this.el.radioToast;
    if (!el) return;
    this._radioText.textContent = stationName;
    el.classList.add('hud-toast--visible');
    if (this._radioTimer) clearTimeout(this._radioTimer);
    this._radioTimer = setTimeout(() => {
      el.classList.remove('hud-toast--visible');
      this._radioTimer = null;
    }, 2500);
  }

  _buildRadioToast() {
    const el = this.el.radioToast;
    if (!el) return;
    el.appendChild(svgIcon('i-music'));
    this._radioText = span('', '', el);
  }

  // ── Kill feed ──────────────────────────────────────────────────────────────

  /**
   * Riga del kill feed (messaggio `chat-message` con variant 'kill-feed'):
   * fuori dalla chat, in alto a destra. `meta` porta nomi e colori; senza
   * `meta` (o con un tipo sconosciuto) si mostra il testo semplice.
   */
  pushKillFeed({ text, meta } = {}) {
    const root = this.el.killfeed;
    if (!root) return;
    const row = document.createElement('div');
    row.className = 'kf-row';
    let involvesLocal = false;
    const who = (p) => {
      const d = span('kf-dot', null, row);
      d.style.setProperty('--c', p?.color ?? '#888');
      span('kf-name', p?.nickname ?? 'Sconosciuto', row);
      if (p?.nickname && p.nickname === this._localNick) involvesLocal = true;
    };

    if (meta?.kind === 'player-kill' && meta.killer && meta.victim) {
      who(meta.killer);
      row.appendChild(meta.killer.byTurret
        ? svgIcon('i-turret', 'lw-ico kf-ico kf-ico--turret')
        : svgIcon('i-crosshair', 'lw-ico kf-ico'));
      who(meta.victim);
    } else if (meta?.kind === 'collision' && Array.isArray(meta.players) && meta.players.length >= 2) {
      who(meta.players[0]);
      row.appendChild(svgIcon('i-boom', 'lw-ico kf-ico kf-ico--boom'));
      who(meta.players[1]);
    } else if (meta?.kind === 'main-objective-destroyed' && meta.actor) {
      who(meta.actor);
      row.appendChild(svgIcon('i-target', 'lw-ico kf-ico kf-ico--target'));
      span('kf-text', 'bersaglio distrutto', row);
    } else {
      span('kf-text', String(text ?? ''), row);
    }
    if (involvesLocal) row.classList.add('is-local');

    root.appendChild(row);
    const max = document.body.classList.contains('is-mobile') ? 3 : 4;
    while (root.children.length > max) root.firstElementChild.remove();
    setTimeout(() => {
      row.classList.add('is-leaving');
      setTimeout(() => row.remove(), 420);
    }, KILLFEED_MS);
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /**
   * @param {object} frame  stato del frame, riusato da main.js (niente allocazioni):
   *   alive, theta, phi, heading (predetti, non il game-state), weaponLevel,
   *   localPos (posizione disegnata), localId, localColor, remotes (Map degli
   *   aerei remoti), targets (bersagli dei proiettili), powerups, delta.
   *   La camera deve avere matrixWorld già aggiornata in questo frame.
   */
  update(localPlayer, allPlayers, target, camera, boostRatio = 1, boostPressed = false, buildings = [], hasExtremeBoost = false, extremeBoostTimer = 0, frame = null) {
    if (!localPlayer) return;
    this._localNick = localPlayer.nickname ?? this._localNick;
    this._localId = localPlayer.id;

    const wl = Math.max(0, Math.floor(localPlayer.weaponLevel ?? 0));
    this._setVal(this.el.kills, localPlayer.kills ?? 0);
    let turrets = 0;
    if (buildings) for (const b of buildings) if (b.ownerId === localPlayer.id) turrets++;
    this._setVal(this.el.turrets, turrets);
    this._setVal(this.el.weapon, wl);
    this._setVal(this.el.speed, getWeaponMoveSpeedPercent(wl), '%');

    const weaponBar = Math.max(0.1, Math.min(1, wl / WEAPON_HUD_BAR_FULL_LEVEL));
    if (weaponBar !== this._weaponBarShown && this.el.weaponFill) {
      this._weaponBarShown = weaponBar;
      this.el.weaponFill.style.transform = `scaleX(${weaponBar})`;
    }

    const r = Math.max(0, Math.min(1, boostRatio));
    if (Math.abs(r - this._boostShown) >= 0.004 && this.el.boostFill) {
      this._boostShown = r;
      this.el.boostFill.style.transform = `scaleX(${r.toFixed(3)})`;
      this.el.boost?.setAttribute('aria-valuenow', String(Math.round(r * 100)));
    }
    const active = boostPressed && r > 0.01;
    if (active !== this._boostActive) {
      this._boostActive = active;
      this.el.boost?.classList.toggle('hud-boost--active', active);
    }
    const empty = r < 0.04;
    if (empty !== this._boostEmpty) {
      this._boostEmpty = empty;
      this.el.boost?.classList.toggle('hud-boost--empty', empty);
    }

    const shieldOn = !!localPlayer.hasShield;
    if (shieldOn !== this._shieldOn) {
      this._shieldOn = shieldOn;
      this.el.shield?.classList.toggle('is-on', shieldOn);
    }

    this._updateExtreme(hasExtremeBoost, extremeBoostTimer);
    this._updateScoreboard(allPlayers, localPlayer.id);

    if (!frame || !camera) return;
    const now = performance.now();
    this._reticle.update(frame, camera, this._W, this._H);
    this._markers.update(frame, allPlayers, target, camera, this._W, this._H, now);
    this._radar.update(frame.delta ?? 0, frame, allPlayers, target, buildings, localPlayer.id, localPlayer.color);
  }

  _updateExtreme(hasExtremeBoost, timer) {
    const el = this.el.extremeBoost;
    if (!el) return;
    const activeNow = timer > 0;
    // Secondi rimasti se attivo, -1 se pronto, 0 se assente: un numero, non una stringa per frame.
    const state = activeNow ? Math.ceil(timer) : (hasExtremeBoost ? -1 : 0);
    if (state === this._extremeState) return;
    this._extremeState = state;
    el.style.display = state !== 0 ? '' : 'none';
    el.classList.toggle('hud-extreme--active', activeNow);
    el.classList.toggle('hud-extreme--ready', hasExtremeBoost && !activeNow);
    if (this.el.extremeLabel) this.el.extremeLabel.textContent = activeNow ? `${Math.ceil(timer)}s` : 'Boost+';
  }

  /** Scrive un numero (con suffisso) solo se è cambiato: niente stringhe nuove a ogni frame. */
  _setVal(el, value, suffix = '') {
    if (!el) return;
    if (this._last.get(el) === value) return;
    this._last.set(el, value);
    el.textContent = suffix ? `${value}${suffix}` : String(value);
  }

  // ── Classifica ─────────────────────────────────────────────────────────────

  _updateScoreboard(allPlayers, localId) {
    const now = performance.now();
    if (now - this._scoreboardAt < SCOREBOARD_MS) return;
    this._scoreboardAt = now;

    const sorted = this._sorted;
    sorted.length = 0;
    for (const p of allPlayers) sorted.push(p);
    sorted.sort(byScore);

    // Chiave di confronto invece di HTML: il nickname arriva dagli altri
    // giocatori e non deve mai essere interpretato come markup.
    let key = `${localId}\n`;
    for (const p of sorted) key += `${p.id}|${p.color}|${p.nickname}|${scoreOf(p)}|${p.alive === false ? 0 : 1}\n`;
    if (key === this._scoreboardKey) return;
    this._scoreboardKey = key;

    const frag = document.createDocumentFragment();
    let localRank = 0;
    sorted.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'sb-row';
      if (p.id === localId) { row.classList.add('is-local'); localRank = i + 1; }
      if (p.alive === false) row.classList.add('is-dead');
      const rank = span('sb-rank', i === 0 && scoreOf(p) > 0 ? null : String(i + 1), row);
      if (i === 0 && scoreOf(p) > 0) rank.appendChild(svgIcon('i-crown'));
      span('sb-dot', null, row).style.setProperty('--c', p.color ?? '#888');
      span('sb-name', p.nickname ?? '?', row);
      span('sb-pts', String(scoreOf(p)), row);
      frag.appendChild(row);
    });
    this.el.playerList?.replaceChildren(frag);

    if (this.el.rankText) {
      const me = sorted[localRank - 1];
      this.el.rankText.textContent = localRank
        ? `#${localRank}/${sorted.length} · ${scoreOf(me)}`
        : `${sorted.length}`;
    }
  }

  _toggleScoreboard() {
    const el = this.el.players;
    if (!el) return;
    const open = !el.classList.contains('is-open');
    el.classList.toggle('is-open', open);
    if (this._playersOpenTimer) clearTimeout(this._playersOpenTimer);
    this._playersOpenTimer = open
      ? setTimeout(() => el.classList.remove('is-open'), 4000)
      : null;
  }
}
