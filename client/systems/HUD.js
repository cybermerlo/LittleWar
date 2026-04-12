import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { WEAPON_CONFIGS, FLY_ALTITUDE } from '../../shared/constants.js';

export class HUD {
  constructor() {
    this.el = {
      hud:        document.getElementById('hud'),
      kills:      document.getElementById('hud-kills'),
      bombs:      document.getElementById('hud-bombs'),
      weapon:     document.getElementById('hud-weapon'),
      shield:     document.getElementById('hud-shield'),
      speed:      document.getElementById('hud-speed'),
      playerList: document.getElementById('player-list'),
      arrow:      document.getElementById('target-arrow'),
      playerArrows: document.getElementById('player-arrows'),
      bombToast:  document.getElementById('hud-bomb-toast'),
    };
    this._bombToastTimer = null;
    this._playerArrowMap = new Map();
    this._tmpRemote = new THREE.Vector3();
    this._tmpProj = new THREE.Vector3();
  }

  show() { this.el.hud.style.display = 'block'; }
  hide() { this.el.hud.style.display = 'none'; }

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

  update(localPlayer, allPlayers, target, camera) {
    if (!localPlayer) return;

    const wl = localPlayer.weaponLevel;
    const speedPct = Math.round(WEAPON_CONFIGS[wl].speedMult * 100);

    this.el.kills.textContent  = `Kill: ${localPlayer.kills}`;
    this.el.bombs.textContent  = `Bombe: ${localPlayer.bombPoints}`;
    this.el.weapon.textContent = `Arma: Lv.${wl}`;
    this.el.shield.textContent = localPlayer.hasShield ? 'Scudo: ✓' : 'Scudo: ✗';
    this.el.speed.textContent  = `Velocità: ${speedPct}%`;

    // Lista giocatori
    this.el.playerList.innerHTML = allPlayers
      .map(p => `<div class="player-entry" style="color:${p.color}">${p.nickname} — ${p.kills}k</div>`)
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
