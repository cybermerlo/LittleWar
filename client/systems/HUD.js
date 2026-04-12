import * as THREE from 'three';
import { sphericalToCartesian } from '../utils/SphereUtils.js';
import { WEAPON_CONFIGS } from '../../shared/constants.js';

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
    };
  }

  show() { this.el.hud.style.display = 'block'; }
  hide() { this.el.hud.style.display = 'none'; }

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
}
