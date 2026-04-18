import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { getWeaponMoveSpeedPercent, WEAPON_HUD_BAR_FULL_LEVEL, FLY_ALTITUDE } from '../../shared/constants.js';

export class HUD {
  constructor() {
    this.el = {
      hud:         document.getElementById('hud'),
      kills:       document.getElementById('hud-kills'),
      turrets:     document.getElementById('hud-turrets'),
      weapon:      document.getElementById('hud-weapon'),
      speed:       document.getElementById('hud-speed'),
      weaponFill:  document.getElementById('hud-weapon-fill'),
      speedFill:   document.getElementById('hud-speed-fill'),
      boost:       document.getElementById('hud-boost'),
      boostFill:   document.getElementById('hud-boost-fill'),
      playerList:  document.getElementById('player-list'),
      arrow:       document.getElementById('target-arrow'),
      playerArrows: document.getElementById('player-arrows'),
      bombToast:   document.getElementById('hud-bomb-toast'),
      killToast:   document.getElementById('hud-kill-toast'),
      towerToast:  document.getElementById('hud-tower-toast'),
      radioToast:  document.getElementById('hud-radio-toast'),
    };
    this._bombToastTimer  = null;
    this._killToastTimer  = null;
    this._towerToastTimer = null;
    this._radioToastTimer = null;
    this._playerArrowMap = new Map();
    this._tmpRemote = new THREE.Vector3();
    this._tmpProj = new THREE.Vector3();
  }

  show() { this.el.hud.style.display = 'block'; }
  hide() { this.el.hud.style.display = 'none'; }

  /** Avviso quando elimini un avversario (diretto o via torretta tua) */
  showKillNotice(nickname, byTurret = false) {
    const el = this.el.killToast;
    if (!el) return;
    if (byTurret) {
      el.textContent = nickname ? `La tua torretta ha abbattuto ${nickname}!` : 'La tua torretta ha abbattuto un nemico!';
    } else {
      el.textContent = nickname ? `Eliminato ${nickname}!` : 'Eliminazione!';
    }
    el.classList.add('hud-toast--visible');
    if (this._killToastTimer) clearTimeout(this._killToastTimer);
    this._killToastTimer = setTimeout(() => {
      el.classList.remove('hud-toast--visible');
      this._killToastTimer = null;
    }, 3200);
  }

  /** Avviso quando distruggi una torretta nemica */
  showTowerDestroyedNotice() {
    const el = this.el.towerToast;
    if (!el) return;
    el.textContent = 'Torretta nemica distrutta! +1';
    el.classList.add('hud-toast--visible');
    if (this._towerToastTimer) clearTimeout(this._towerToastTimer);
    this._towerToastTimer = setTimeout(() => {
      el.classList.remove('hud-toast--visible');
      this._towerToastTimer = null;
    }, 3200);
  }

  /** Avviso quando distruggi la tua stessa torretta (nessun punto) */
  showOwnTowerDestroyedNotice() {
    const el = this.el.towerToast;
    if (!el) return;
    el.textContent = 'Hai distrutto la tua torretta — Coglione!';
    el.classList.add('hud-toast--visible');
    if (this._towerToastTimer) clearTimeout(this._towerToastTimer);
    this._towerToastTimer = setTimeout(() => {
      el.classList.remove('hud-toast--visible');
      this._towerToastTimer = null;
    }, 3200);
  }

  /** Avviso al proprietario quando un altro giocatore distrugge la sua torretta */
  showMyTurretDestroyedNotice(destroyerNickname) {
    const el = this.el.towerToast;
    if (!el) return;
    el.textContent = destroyerNickname
      ? `La tua torretta è stata distrutta da ${destroyerNickname}!`
      : 'La tua torretta è stata distrutta!';
    el.classList.add('hud-toast--visible');
    if (this._towerToastTimer) clearTimeout(this._towerToastTimer);
    this._towerToastTimer = setTimeout(() => {
      el.classList.remove('hud-toast--visible');
      this._towerToastTimer = null;
    }, 3200);
  }

  /** Avviso quando la tua bomba colpisce il bersaglio bombardamento */
  showBombHitNotice() {
    const el = this.el.bombToast;
    if (!el) return;
    el.textContent = 'Bersaglio colpito!';
    el.classList.add('hud-toast--visible');
    if (this._bombToastTimer) clearTimeout(this._bombToastTimer);
    this._bombToastTimer = setTimeout(() => {
      el.classList.remove('hud-toast--visible');
      this._bombToastTimer = null;
    }, 3200);
  }

  showRadioToast(stationName) {
    const el = this.el.radioToast;
    if (!el) return;
    el.textContent = `📻 ${stationName}`;
    el.classList.add('hud-toast--visible');
    if (this._radioToastTimer) clearTimeout(this._radioToastTimer);
    this._radioToastTimer = setTimeout(() => {
      el.classList.remove('hud-toast--visible');
      this._radioToastTimer = null;
    }, 2500);
  }

  update(localPlayer, allPlayers, target, camera, boostRatio = 1, boostPressed = false, buildings = []) {
    if (!localPlayer) return;

    const wl = Math.max(0, Math.floor(localPlayer.weaponLevel ?? 0));
    const speedPct = getWeaponMoveSpeedPercent(wl);

    const isMobile = document.body.classList.contains('is-mobile');
    this.el.kills.textContent  = isMobile ? `⚔️ ${localPlayer.kills}` : `Kill: ${localPlayer.kills}`;
    const turretCount = (buildings || []).filter((b) => b.ownerId === localPlayer.id).length;
    if (this.el.turrets) this.el.turrets.textContent = isMobile ? `🏠 ${turretCount}` : `Torrette: ${turretCount}`;
    this.el.weapon.textContent = `🔫 Lv.${wl}`;
    if (this.el.speed) this.el.speed.textContent = `🚀 ${speedPct}%`;
    const weaponBar = Math.max(0.1, Math.min(1, wl / WEAPON_HUD_BAR_FULL_LEVEL));
    const speedBar = Math.max(0.06, Math.min(1, speedPct / 100));
    if (this.el.weaponFill) this.el.weaponFill.style.transform = `scaleX(${weaponBar})`;
    if (this.el.speedFill) this.el.speedFill.style.transform = `scaleX(${speedBar})`;
    const r = Math.max(0, Math.min(1, boostRatio));
    const boostPct = Math.round(r * 100);
    if (this.el.boostFill) {
      this.el.boostFill.style.transform = `scaleX(${r})`;
    }
    const boostPill = this.el.boost;
    if (boostPill) {
      boostPill.classList.toggle('hud-boost--active', boostPressed && r > 0.01);
      boostPill.classList.toggle('hud-boost--empty', r < 0.04);
      boostPill.setAttribute('aria-valuenow', String(boostPct));
    }

    // Lista giocatori: ordine per punteggio totale (kill + bombe), decrescente
    const byScore = [...allPlayers].sort((a, b) => {
      const sa = (a.kills || 0) + (a.bombPoints || 0);
      const sb = (b.kills || 0) + (b.bombPoints || 0);
      if (sb !== sa) return sb - sa;
      return (a.nickname || '').localeCompare(b.nickname || '', undefined, { sensitivity: 'base' });
    });
    this.el.playerList.innerHTML = byScore
      .map((p) => {
        const pts = (p.kills || 0) + (p.bombPoints || 0);
        return `<div class="player-entry" style="color:${p.color}">${p.nickname} — ${pts}</div>`;
      })
      .join('');

    // Freccia obiettivo
    if (target && camera) {
      this._updateArrow(localPlayer, target, camera);
    }
    if (camera) {
      this._updateNearestPlayerArrows(localPlayer, allPlayers, camera);
    }
  }

  _updateArrow(localPlayer, target, camera) {
    const tPos = sphericalToCartesian(target.theta, target.phi, 50);
    const targetVec = new THREE.Vector3(tPos.x, tPos.y, tPos.z);

    const projected = targetVec.clone().project(camera);
    const el = this.el.arrow;

    const W = window.innerWidth;
    const H = window.innerHeight;

    // Bersaglio in campo visivo e sullo schermo
    const onScreen = projected.z < 1
      && Math.abs(projected.x) < 0.88
      && Math.abs(projected.y) < 0.88;

    if (onScreen) {
      // Posiziona l'icona 🎯 esattamente sul target proiettato
      const sx = ( projected.x * 0.5 + 0.5) * W;
      const sy = (-projected.y * 0.5 + 0.5) * H;
      el.textContent = '🎯';
      el.style.left      = `${sx}px`;
      el.style.top       = `${sy}px`;
      el.style.transform = 'translate(-50%, -50%)';
      el.style.fontSize  = '1.8rem';
      el.style.opacity   = '0.9';
    } else {
      // Fuori campo: freccia al bordo dello schermo che punta verso il bersaglio
      const angle = Math.atan2(-projected.y, projected.x); // angolo schermo
      const deg   = -angle * (180 / Math.PI) + 90;

      const margin = 60; // px dal bordo
      const cx = W / 2;
      const cy = H / 2;
      const r  = Math.min(cx, cy) - margin;

      const ex = cx + Math.cos(angle) * r;
      const ey = cy - Math.sin(angle) * r;

      el.textContent = '▲';
      el.style.left      = `${ex}px`;
      el.style.top       = `${ey}px`;
      el.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
      el.style.fontSize  = '1.4rem';
      el.style.opacity   = '1';
    }
  }

  _distanceBetweenPlayers(a, b) {
    const ar = sphericalToCartesian(a.theta, a.phi, FLY_ALTITUDE);
    const br = sphericalToCartesian(b.theta, b.phi, FLY_ALTITUDE);
    const dx = ar.x - br.x;
    const dy = ar.y - br.y;
    const dz = ar.z - br.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _getOrCreatePlayerArrow(playerId) {
    let entry = this._playerArrowMap.get(playerId);
    if (entry) return entry;
    const el = document.createElement('div');
    el.className = 'player-arrow';
    this.el.playerArrows?.appendChild(el);
    entry = { el };
    this._playerArrowMap.set(playerId, entry);
    return entry;
  }

  _updateNearestPlayerArrows(localPlayer, allPlayers, camera) {
    const enemies = allPlayers
      .filter((p) => p.id !== localPlayer.id && p.alive)
      .map((p) => ({ player: p, dist: this._distanceBetweenPlayers(localPlayer, p) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3)
      .map((x) => x.player);

    const activeIds = new Set(enemies.map((p) => p.id));
    for (const [id, entry] of this._playerArrowMap) {
      if (!activeIds.has(id)) {
        entry.el.remove();
        this._playerArrowMap.delete(id);
      }
    }

    const W = window.innerWidth;
    const H = window.innerHeight;
    const margin = 72;
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(cx, cy) - margin;

    for (const p of enemies) {
      const entry = this._getOrCreatePlayerArrow(p.id);
      const marker = entry.el;
      marker.style.setProperty('--arrow-color', p.color ?? '#8ec5ff');

      const world = sphericalToCartesian(p.theta, p.phi, FLY_ALTITUDE);
      this._tmpRemote.set(world.x, world.y, world.z);
      this._tmpProj.copy(this._tmpRemote).project(camera);

      const onScreen = this._tmpProj.z < 1
        && Math.abs(this._tmpProj.x) < 0.9
        && Math.abs(this._tmpProj.y) < 0.9;

      if (onScreen) {
        const sx = (this._tmpProj.x * 0.5 + 0.5) * W;
        const sy = (-this._tmpProj.y * 0.5 + 0.5) * H;
        marker.classList.remove('player-arrow--offscreen');
        marker.textContent = (p.nickname?.[0] ?? '?').toUpperCase();
        marker.style.left = `${sx}px`;
        marker.style.top = `${sy}px`;
        marker.style.transform = 'translate(-50%, -50%)';
      } else {
        const angle = Math.atan2(-this._tmpProj.y, this._tmpProj.x);
        const ex = cx + Math.cos(angle) * r;
        const ey = cy - Math.sin(angle) * r;
        const deg = -angle * (180 / Math.PI) + 90;
        marker.classList.add('player-arrow--offscreen');
        marker.textContent = '▲';
        marker.style.left = `${ex}px`;
        marker.style.top = `${ey}px`;
        marker.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
      }
    }
  }
}
