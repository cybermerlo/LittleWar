import * as THREE from 'three';
import { createPlanet } from './scene/Planet.js';
import { createTerrain } from './scene/Terrain.js';
import { createSky } from './scene/Sky.js';
import { setupLighting } from './scene/Lighting.js';
import { Airplane } from './entities/Airplane.js';
import { ProjectileEntity } from './entities/Projectile.js';
import { BombEntity, spawnExplosion } from './entities/Bomb.js';
import { PowerUpEntity } from './entities/PowerUp.js';
import { TargetEntity } from './entities/Target.js';
import { InputManager } from './systems/InputManager.js';
import { CameraController } from './systems/CameraController.js';
import { NetworkManager } from './systems/NetworkManager.js';
import { HUD } from './systems/HUD.js';
import { AudioManager } from './systems/AudioManager.js';
import { LobbyScreen } from './ui/LobbyScreen.js';
import { DeathScreen } from './ui/DeathScreen.js';
import { moveOnSphere } from './utils/SphereUtils.js';
import {
  BASE_SPEED, SPEED_REDUCTION_PER_LEVEL, MIN_SPEED,
  WEAPON_CONFIGS, FLY_ALTITUDE, MAX_PLAYERS,
} from '../shared/constants.js';

// ── Renderer + Scena ──────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 80, 0);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ── Costruzione mondo ─────────────────────────────────────────────────────────

createSky(scene);
setupLighting(scene);
const { heightData, posAttr } = createPlanet(scene);
createTerrain(scene, heightData, posAttr);

// ── Stato gioco ───────────────────────────────────────────────────────────────

const input    = new InputManager();
const camCtrl  = new CameraController(camera);
const hud      = new HUD();
const death    = new DeathScreen();

let localPlayerId = null;
let localState    = null;        // stato locale del nostro giocatore
let isAlive       = true;
let inGame        = false;

// Theta/phi/heading locali (aggiornati ogni frame)
let theta   = Math.PI / 2;
let phi     = 0;
let heading = 0;

// Mappe entità remote
const remoteAirplanes  = new Map(); // playerId → Airplane
const projectileEntities = new Map();
const bombEntities       = new Map();
const powerupEntities    = new Map();
let   targetEntity       = null;
let   currentTarget      = null;
let   allPlayerStates    = [];

// Throttle invio input (20 Hz)
let lastInputSend = 0;

// Shoot cooldown
let lastShootTime = 0;
const SHOOT_COOLDOWN = 200; // ms

// Bomb cooldown
let lastBombTime = 0;
const BOMB_COOLDOWN = 1500; // ms

// ── Lobby + Network ───────────────────────────────────────────────────────────

const lobby = new LobbyScreen((nickname, color, model) => {
  net.join(nickname, color, model);
  lobby.setMessage('Connessione…');
});

const net = new NetworkManager({
  onConnect() {
    lobby.setMessage('');
    lobby.setOnlineCount(0, MAX_PLAYERS);
  },

  onDisconnect() {
    lobby.show();
    lobby.setMessage('Disconnesso. Ricarica la pagina.');
    inGame = false;
    hud.hide();
  },

  onServerFull() {
    lobby.setFull(true);
    lobby.setMessage('Server pieno, riprova tra poco.');
  },

  onJoined({ playerId, players, powerups, target }) {
    localPlayerId = playerId;
    localState = players.find(p => p.id === playerId) ?? null;

    if (localState) {
      theta   = localState.theta;
      phi     = localState.phi;
      heading = localState.heading;
    }

    // Crea aerei degli altri giocatori già presenti
    players.forEach(p => {
      if (p.id !== localPlayerId) {
        const plane = new Airplane(scene, THREE, p.color, p.model, false);
        plane.update(p.theta, p.phi, p.heading, p.weaponLevel, p.hasShield, 0);
        remoteAirplanes.set(p.id, plane);
      }
    });

    // Powerup già presenti
    powerups.forEach(pu => {
      const e = new PowerUpEntity(scene, pu.id, pu.type, pu.theta, pu.phi);
      powerupEntities.set(pu.id, e);
    });

    // Obiettivo bombardamento
    if (target) {
      currentTarget = target;
      targetEntity?.dispose(scene);
      targetEntity = new TargetEntity(scene, target.theta, target.phi);
    }

    allPlayerStates = players;
    lobby.hide();
    hud.show();
    inGame = true;
  },

  onPlayerJoined(info) {
    if (info.id === localPlayerId) return;
    const plane = new Airplane(scene, THREE, info.color, info.model, false);
    remoteAirplanes.set(info.id, plane);
    allPlayerStates.push({ ...info, kills: 0, bombPoints: 0, weaponLevel: 0 });
    lobby.setOnlineCount(allPlayerStates.length, MAX_PLAYERS);
  },

  onPlayerLeft({ id }) {
    remoteAirplanes.get(id)?.dispose(scene);
    remoteAirplanes.delete(id);
    allPlayerStates = allPlayerStates.filter(p => p.id !== id);
    lobby.setOnlineCount(allPlayerStates.length, MAX_PLAYERS);
  },

  onGameState(state) {
    allPlayerStates = state.players;

    // Aggiorna aerei remoti
    state.players.forEach(p => {
      if (p.id === localPlayerId) {
        localState = p;
        return;
      }
      if (!remoteAirplanes.has(p.id)) {
        // Giocatore che non avevamo ancora
        const plane = new Airplane(scene, THREE, p.color ?? '#aaaaaa', p.model, false);
        remoteAirplanes.set(p.id, plane);
      }
      if (p.alive) {
        remoteAirplanes.get(p.id)?.update(p.theta, p.phi, p.heading, p.weaponLevel, p.hasShield, lastAnimDelta);
      }
    });

    // Proiettili
    const serverProjIds = new Set(state.projectiles.map(p => p.id));
    for (const [id, e] of projectileEntities) {
      if (!serverProjIds.has(id)) { e.dispose(scene); projectileEntities.delete(id); }
    }
    state.projectiles.forEach(p => {
      if (!projectileEntities.has(p.id)) {
        projectileEntities.set(p.id, new ProjectileEntity(scene, p.id, p.theta, p.phi));
      } else {
        projectileEntities.get(p.id).update(p.theta, p.phi);
      }
    });

    // Bombe
    const serverBombIds = new Set(state.bombs.map(b => b.id));
    for (const [id, e] of bombEntities) {
      if (!serverBombIds.has(id)) { e.dispose(scene); bombEntities.delete(id); }
    }
    state.bombs.forEach(b => {
      if (!bombEntities.has(b.id)) {
        bombEntities.set(b.id, new BombEntity(scene, b.id, b.theta, b.phi, b.altitude));
      } else {
        bombEntities.get(b.id).update(b.theta, b.phi, b.altitude);
      }
    });

    // Powerup
    const serverPuIds = new Set(state.powerups.map(p => p.id));
    for (const [id, e] of powerupEntities) {
      if (!serverPuIds.has(id)) { e.dispose(scene); powerupEntities.delete(id); }
    }
    state.powerups.forEach(p => {
      if (!powerupEntities.has(p.id)) {
        powerupEntities.set(p.id, new PowerUpEntity(scene, p.id, p.type, p.theta, p.phi));
      }
    });
  },

  onPlayerKilled({ killerId, victimId, theta: t, phi: p }) {
    spawnExplosion(scene, t, p, FLY_ALTITUDE);
    AudioManager.playExplosion();

    if (victimId === localPlayerId) {
      isAlive = false;
      const killer = allPlayerStates.find(pl => pl.id === killerId);
      death.show(killer?.nickname ?? null, () => {
        // Il respawn arriva dal server via onRespawned
      });
    }
  },

  onShieldBroken({ playerId }) {
    // L'effetto visivo è gestito dall'aggiornamento dello stato nel game-state
  },

  onPowerupSpawned(pu) {
    if (!powerupEntities.has(pu.id)) {
      powerupEntities.set(pu.id, new PowerUpEntity(scene, pu.id, pu.type, pu.theta, pu.phi));
    }
  },

  onPowerupCollected({ playerId, powerupId }) {
    powerupEntities.get(powerupId)?.dispose(scene);
    powerupEntities.delete(powerupId);
    if (playerId === localPlayerId) AudioManager.playPowerup();
  },

  onBombExploded({ theta: t, phi: p, hit }) {
    spawnExplosion(scene, t, p, 50, hit ? 0xffcc00 : 0x884400);
    AudioManager.playBomb();
  },

  onNewTarget(target) {
    currentTarget = target;
    targetEntity?.dispose(scene);
    targetEntity = new TargetEntity(scene, target.theta, target.phi);
  },

  onRespawned(state) {
    isAlive = true;
    theta   = state.theta;
    phi     = state.phi;
    heading = state.heading;
    death.hide();
  },
});

// ── Aereo locale ──────────────────────────────────────────────────────────────
// Creato quando riceviamo onJoined, ma ci serve il colore — lo creiamo dopo.
// Usiamo un riferimento lazy.
let localAirplane = null;

function ensureLocalAirplane(color, model) {
  if (!localAirplane) {
    localAirplane = new Airplane(scene, THREE, color, model, true);
  }
}

// ── Game Loop ─────────────────────────────────────────────────────────────────

const clock = new THREE.Clock();
/** Ultimo delta del game loop — usato per banking sugli aerei remoti (callback di rete) */
let lastAnimDelta = 1 / 60;

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  lastAnimDelta = delta;
  const now = performance.now();

  if (inGame && isAlive && localState) {
    ensureLocalAirplane(localState.color ?? '#ff4444', localState.model ?? 'airplane');

    // Velocità in base al livello arma (radianti/secondo * delta)
    const wl = localState.weaponLevel ?? 0;
    const speed = Math.max(MIN_SPEED, BASE_SPEED - wl * SPEED_REDUCTION_PER_LEVEL);

    // Input → aggiorna heading e posizione (tutto * delta)
    const turnSpeed = 1.8; // rad/s
    if (input.isLeft())  heading -= turnSpeed * delta;
    if (input.isRight()) heading += turnSpeed * delta;

    // Movimento in avanti sempre attivo
    const accel = input.isForward() ? 1.3 : input.isBackward() ? 0.4 : 1.0;
    const moved = moveOnSphere(theta, phi, heading, speed * accel * delta);
    theta = moved.theta;
    phi   = moved.phi;
    heading = moved.heading;

    localAirplane.update(theta, phi, heading, wl, localState.hasShield ?? false, delta);
    camCtrl.update(localAirplane.mesh, localAirplane.sphereQuaternion);

    // Invia input al server (throttled)
    if (now - lastInputSend > 50) {
      net.sendInput(theta, phi, heading);
      lastInputSend = now;
    }

    // Sparo
    if (input.consumeShoot() && now - lastShootTime > SHOOT_COOLDOWN) {
      net.sendShoot();
      AudioManager.playShoot();
      lastShootTime = now;
    }

    // Bomba
    if (input.consumeBomb() && now - lastBombTime > BOMB_COOLDOWN) {
      net.sendBomb();
      lastBombTime = now;
    }
  }

  // Anima powerup
  for (const pu of powerupEntities.values()) pu.tick(delta);

  // Anima target
  targetEntity?.tick();

  // HUD
  if (inGame) {
    hud.update(localState, allPlayerStates, currentTarget, camera);
  }

  renderer.render(scene, camera);
}

animate();
