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
    this.el.speed.textContent  = `Vel: ${speedPct}%`;

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

    // Proietta sullo schermo
    const projected = targetVec.clone().project(camera);
    const angle = Math.atan2(projected.y, projected.x);

    // Se il target è "davanti" mostra la freccia puntata verso di esso
    // Ruotiamo l'emoji freccia con CSS
    const deg = -angle * (180 / Math.PI) + 90;
    this.el.arrow.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;

    // Se è molto vicino al centro dello schermo, nascondi la freccia
    const dist2d = Math.sqrt(projected.x ** 2 + projected.y ** 2);
    this.el.arrow.style.opacity = dist2d < 0.15 ? '0.2' : '1';
  }
}
