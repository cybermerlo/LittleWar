import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { createPlanet } from './scene/Planet.js';
import { createTerrain, loadTreeTemplates, loadBuildingTemplates, loadHospitalTemplates } from './scene/Terrain.js';
import { createSky } from './scene/Sky.js';
import { setupLighting } from './scene/Lighting.js';
import { Airplane } from './entities/Airplane.js';
import { ProjectileEntity } from './entities/Projectile.js';
import { BombEntity, spawnExplosion } from './entities/Bomb.js';
import { PowerUpEntity } from './entities/PowerUp.js';
import { TargetEntity } from './entities/Target.js';
import { BuildingEntity, spawnTurretDestruction } from './entities/Building.js';
import { InputManager } from './systems/InputManager.js';
import { CameraController } from './systems/CameraController.js';
import { NetworkManager } from './systems/NetworkManager.js';
import { HUD } from './systems/HUD.js';
import { AudioManager } from './systems/AudioManager.js';
import { ChatManager } from './systems/ChatManager.js';
import { LobbyScreen } from './ui/LobbyScreen.js';
import { DeathScreen } from './ui/DeathScreen.js';
import { moveOnSphere } from './utils/SphereUtils.js';
import {
  BASE_SPEED, SPEED_REDUCTION_PER_LEVEL, MIN_SPEED,
  BOOST_MAX, BOOST_SPEED_MULT, BOOST_DRAIN_PER_SEC, BOOST_REGEN_PER_SEC,
  FORWARD_ACCEL, BACKWARD_ACCEL,
  WEAPON_CONFIGS, FLY_ALTITUDE, MAX_PLAYERS, CLIENT_INPUT_SEND_MS,
  POWERUP_COLLECT_RADIUS,
} from '../shared/constants.js';

/** Distanza 3D tra due punti sferici allo stesso raggio — stessa formula del server. */
function sphereDist(t1, p1, t2, p2, r) {
  const dx = r * Math.sin(t1) * Math.cos(p1) - r * Math.sin(t2) * Math.cos(p2);
  const dy = r * Math.cos(t1) - r * Math.cos(t2);
  const dz = r * Math.sin(t1) * Math.sin(p1) - r * Math.sin(t2) * Math.sin(p2);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Intensità visiva turbo per aerei remoti (0..1) dal game-state. */
function remoteBoostAmount(p) {
  if (!p?.boosting) return 0;
  const e = p.boostEnergy;
  if (typeof e !== 'number' || !Number.isFinite(e)) return 1;
  return Math.max(0, Math.min(1, e / BOOST_MAX));
}

// ── Renderer + Scena ──────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.03;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 80, 0);

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomScale = window.devicePixelRatio > 1.5 ? 0.65 : 1.0;
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth * bloomScale, window.innerHeight * bloomScale),
  0.34,
  0.72,
  0.84,
);
composer.addPass(bloomPass);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.resolution.set(window.innerWidth * bloomScale, window.innerHeight * bloomScale);
});

// Tasti chat (T, L, P) — delegati al ChatManager
window.addEventListener('keydown', (e) => chat.handleKey(e));

// ── Costruzione mondo ─────────────────────────────────────────────────────────

const lights = setupLighting(scene);
const sky = createSky(scene, lights);
const { mesh: planetMesh, heightData, posAttr } = createPlanet(scene);
Promise.all([loadTreeTemplates(), loadBuildingTemplates(), loadHospitalTemplates()]).then(([treeTemplates, buildingTemplates, hospitalTemplates]) => {
  createTerrain(scene, heightData, posAttr, planetMesh, treeTemplates, buildingTemplates, hospitalTemplates);
});

// ── Stato gioco ───────────────────────────────────────────────────────────────

const input    = new InputManager();
const camCtrl  = new CameraController(camera);
const hud      = new HUD();
const death    = new DeathScreen();
const chat     = new ChatManager(
  (text) => net.sendChat(text),
  ()     => AudioManager.playChatPop(),
);

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
const remoteWasDead    = new Map(); // playerId → boolean
const projectileEntities = new Map();
const bombEntities       = new Map();
const powerupEntities    = new Map();
/** Chiavi Map allineate a stringa (evita mismatch con eventi socket). */
function powerupKey(id) {
  return String(id);
}
function removePowerupEntity(scene, rawId) {
  const id = powerupKey(rawId);
  const e = powerupEntities.get(id);
  if (!e) return;
  e.dispose(scene);
  powerupEntities.delete(id);
}
const buildingEntities   = new Map(); // buildingId → BuildingEntity
let   targetEntity       = null;
let   currentTarget      = null;
let   allPlayerStates    = [];

// Powerup: posizioni note (da game-state) + timestamp ultimo try-collect per ID.
// Non marchiamo più i powerup come "tentati una volta" — se la prima richiesta
// viene persa (packet drop con polling, disconnect transiente, player morto per
// un istante sul server) i retry garantiscono che la collection venga confermata
// appena possibile. Il server è idempotente (`if (!pu) return`) quindi retry
// multipli sono sicuri.
const powerupPositions   = new Map(); // powerupId → {theta, phi}
const powerupLastTryAt   = new Map(); // powerupId → ms dell'ultimo try-collect inviato
const TRY_COLLECT_RETRY_MS = 300;     // ~3 retry/s finché in range e powerup presente

// Throttle invio input (allineato al tick server)
let lastInputSend = 0;

// Shoot cooldown
let lastShootTime = 0;
const SHOOT_COOLDOWN = 200; // ms

// Bomb cooldown
let lastBombTime = 0;
const BOMB_COOLDOWN = 1500; // ms

// Boost locale
let boostEnergy = BOOST_MAX;

// ── Lobby + Network ───────────────────────────────────────────────────────────

const lobby = new LobbyScreen((nickname, color, model) => {
  AudioManager.startMusic();
  AudioManager.startEngine();
  net.join(nickname, color, model);
  lobby.setMessage('Connessione…');
});

const net = new NetworkManager({
  onConnect() {
    lobby.setMessage('');
    lobby.setOnlineCount(0, MAX_PLAYERS);
  },

  onDisconnect() {
    AudioManager.stopMusic();
    AudioManager.stopEngine();
    lobby.show();
    lobby.setMessage('Disconnesso. Ricarica la pagina.');
    inGame = false;
    hud.hide();
    chat.disable();
  },

  onServerFull() {
    lobby.setFull(true);
    lobby.setMessage('Server pieno, riprova tra poco.');
  },

  onLobbyInfo({ takenColors, online }) {
    lobby.setTakenColors(takenColors);
    lobby.setOnlineCount(online, MAX_PLAYERS);
  },

  onColorTaken({ takenColors }) {
    lobby.setTakenColors(takenColors);
    lobby.setMessage('Quel colore è già in uso! Scegline un altro.');
  },

  onJoined({ playerId, players, powerups, target, buildings }) {
    localPlayerId = playerId;
    localState = players.find(p => p.id === playerId) ?? null;

    if (localState) {
      theta   = localState.theta;
      phi     = localState.phi;
      heading = localState.heading;
      boostEnergy = typeof localState.boostEnergy === 'number' ? localState.boostEnergy : BOOST_MAX;
    }

    // Crea aerei degli altri giocatori già presenti
    players.forEach(p => {
      if (p.id !== localPlayerId) {
        const plane = new Airplane(scene, THREE, p.color, p.model, false);
        plane.update(p.theta, p.phi, p.heading, p.weaponLevel, p.hasShield, 0, remoteBoostAmount(p));
        remoteAirplanes.set(p.id, plane);
      }
    });

    // Powerup già presenti
    powerupPositions.clear();
    powerupLastTryAt.clear();
    powerups.forEach(pu => {
      const id = powerupKey(pu.id);
      const e = new PowerUpEntity(scene, id, pu.type, pu.theta, pu.phi);
      powerupEntities.set(id, e);
      powerupPositions.set(id, { theta: pu.theta, phi: pu.phi });
    });

    // Obiettivo bombardamento
    if (target) {
      currentTarget = target;
      targetEntity?.dispose(scene);
      targetEntity = new TargetEntity(scene, target.theta, target.phi);
    }

    // Edifici conquistabili
    if (buildings) {
      for (const [id, e] of buildingEntities) { e.dispose(scene); }
      buildingEntities.clear();
      buildings.forEach(b => {
        buildingEntities.set(b.id, new BuildingEntity(scene, b.id, b.theta, b.phi));
      });
    }

    allPlayerStates = players;
    lobby.hide();
    hud.show();
    chat.enable();
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
    remoteWasDead.delete(id);
    allPlayerStates = allPlayerStates.filter(p => p.id !== id);
    lobby.setOnlineCount(allPlayerStates.length, MAX_PLAYERS);
  },

  onGameState(state) {
    allPlayerStates = state.players;

    // Rimuovi aerei remoti non più presenti nel game-state
    const serverPlayerIds = new Set(state.players.map(p => p.id));
    for (const [id, plane] of remoteAirplanes) {
      if (!serverPlayerIds.has(id)) {
        plane.dispose(scene);
        remoteAirplanes.delete(id);
        remoteWasDead.delete(id);
      }
    }

    // Aggiorna aerei remoti
    state.players.forEach(p => {
      if (p.id === localPlayerId) {
        localState = p;
        return;
      }
      if (!remoteAirplanes.has(p.id)) {
        const plane = new Airplane(scene, THREE, p.color ?? '#aaaaaa', p.model, false);
        remoteAirplanes.set(p.id, plane);
      }
      const plane = remoteAirplanes.get(p.id);
      if (!plane) return;

      if (p.alive) {
        const wasDead = remoteWasDead.get(p.id) ?? true;
        if (wasDead) {
          plane.resetRemote(p.theta, p.phi, p.heading);
        }
        plane.mesh.visible = true;
        plane.setBoostParticlesVisible(true);
        plane.setNetworkTarget(
          p.theta, p.phi, p.heading, p.weaponLevel, p.hasShield,
          remoteBoostAmount(p),
        );
        remoteWasDead.set(p.id, false);
      } else {
        plane.mesh.visible = false;
        plane.setBoostParticlesVisible(false);
        remoteWasDead.set(p.id, true);
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

    // Powerup (stato server = fonte di verità: spariscono se non sono più nella lista)
    const serverPuIds = new Set(state.powerups.map(p => powerupKey(p.id)));
    for (const [id, e] of powerupEntities) {
      if (!serverPuIds.has(id)) {
        e.dispose(scene);
        powerupEntities.delete(id);
        powerupPositions.delete(id);
        powerupLastTryAt.delete(id);
      }
    }
    state.powerups.forEach(p => {
      const id = powerupKey(p.id);
      if (!powerupEntities.has(id)) {
        powerupEntities.set(id, new PowerUpEntity(scene, id, p.type, p.theta, p.phi));
      } else {
        powerupEntities.get(id).update(p.theta, p.phi);
      }
      powerupPositions.set(id, { theta: p.theta, phi: p.phi });
    });

    // Edifici conquistabili
    if (state.buildings) {
      state.buildings.forEach(b => {
        if (!buildingEntities.has(b.id)) {
          const entity = new BuildingEntity(scene, b.id, b.theta, b.phi);
          buildingEntities.set(b.id, entity);
        }
        buildingEntities.get(b.id).update(b, allPlayerStates, camera);
      });
    }
  },

  onPlayerKilled({ killerId, victimId, theta: t, phi: p, byTurret }) {
    spawnExplosion(scene, t, p, FLY_ALTITUDE);
    AudioManager.playExplosion();

    if (victimId === localPlayerId) {
      isAlive = false;
      const killer = allPlayerStates.find(pl => pl.id === killerId);
      death.show(killer?.nickname ?? null, byTurret ?? false, () => {
        // Il respawn arriva dal server via onRespawned
      });
    }

    if (killerId === localPlayerId) {
      const victim = allPlayerStates.find(pl => pl.id === victimId);
      hud.showKillNotice(victim?.nickname ?? null, byTurret ?? false);
    }
  },

  onShieldBroken({ playerId }) {
    // L'effetto visivo è gestito dall'aggiornamento dello stato nel game-state
  },

  onPowerupSpawned(pu) {
    const id = powerupKey(pu.id);
    if (!powerupEntities.has(id)) {
      powerupEntities.set(id, new PowerUpEntity(scene, id, pu.type, pu.theta, pu.phi));
    }
    powerupPositions.set(id, { theta: pu.theta, phi: pu.phi });
  },

  onPowerupCollected({ playerId, powerupId }) {
    const id = powerupKey(powerupId);
    removePowerupEntity(scene, powerupId);
    powerupPositions.delete(id);
    powerupLastTryAt.delete(id);
    if (playerId === localPlayerId) AudioManager.playPowerup();
  },

  onBombExploded({ theta: t, phi: p, hit, ownerId }) {
    spawnExplosion(scene, t, p, 50, hit ? 0xffcc00 : 0x884400);
    AudioManager.playBomb();
    if (hit && ownerId === localPlayerId) {
      hud.showBombHitNotice();
    }
  },

  onNewTarget(target) {
    currentTarget = target;
    targetEntity?.dispose(scene);
    targetEntity = new TargetEntity(scene, target.theta, target.phi);
  },

  onBuildingDestroyed({
    buildingId,
    theta,
    phi,
    destroyerId,
    destroyerNickname,
    turretOwnerId,
    awardedKill = true,
  }) {
    spawnTurretDestruction(scene, theta, phi);
    AudioManager.playBomb();
    if (destroyerId === localPlayerId) {
      if (awardedKill) hud.showTowerDestroyedNotice();
      else hud.showOwnTowerDestroyedNotice();
    } else if (turretOwnerId === localPlayerId) {
      hud.showMyTurretDestroyedNotice(destroyerNickname);
    }
  },

  onRespawned(state) {
    isAlive = true;
    theta   = state.theta;
    phi     = state.phi;
    heading = state.heading;
    boostEnergy = typeof state.boostEnergy === 'number' ? state.boostEnergy : BOOST_MAX;
    death.hide();
  },

  onChatMessage(msg) {
    chat.receive(msg);
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

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const now = performance.now();

  sky.update(delta);

  if (inGame && isAlive && localState) {
    ensureLocalAirplane(localState.color ?? '#ff4444', localState.model ?? 'airplane');

    // Velocità in base al livello arma (radianti/secondo * delta)
    const wl = localState.weaponLevel ?? 0;
    const baseSpeed = Math.max(MIN_SPEED, BASE_SPEED - wl * SPEED_REDUCTION_PER_LEVEL);

    const wantsBoost = input.isBoost();
    const boostActive = wantsBoost && boostEnergy > 0.01;
    if (boostActive) {
      boostEnergy = Math.max(0, boostEnergy - BOOST_DRAIN_PER_SEC * delta);
    } else {
      boostEnergy = Math.min(BOOST_MAX, boostEnergy + BOOST_REGEN_PER_SEC * delta);
    }
    const speedMult = boostActive ? BOOST_SPEED_MULT : 1;
    const speed = baseSpeed * speedMult;

    // Input → aggiorna heading e posizione (tutto * delta)
    const turnSpeed = 1.8; // rad/s
    if (input.isLeft())  heading -= turnSpeed * delta;
    if (input.isRight()) heading += turnSpeed * delta;

    // Movimento in avanti sempre attivo
    const movingForward = input.isForward();
    const movingBackward = input.isBackward();

    // Aggiorna volume motore
    AudioManager.updateEngine(movingForward, boostActive, delta);
    if (boostActive) { AudioManager.startBoost(); } else { AudioManager.stopBoost(); }
    const accel = movingForward ? FORWARD_ACCEL : movingBackward ? BACKWARD_ACCEL : 1;
    const moved = moveOnSphere(theta, phi, heading, speed * accel * delta);
    theta = moved.theta;
    phi   = moved.phi;
    heading = moved.heading;

    localAirplane.update(
      theta,
      phi,
      heading,
      wl,
      localState.hasShield ?? false,
      delta,
      boostActive ? (boostEnergy / BOOST_MAX) : 0,
    );
    camCtrl.update(localAirplane.mesh, localAirplane.sphereQuaternion);

    // Invia input al server (throttled)
    if (now - lastInputSend >= CLIENT_INPUT_SEND_MS) {
      net.sendInput(theta, phi, heading, boostActive, movingForward, movingBackward);
      lastInputSend = now;
    }

    // Sparo
    if (input.consumeShoot() && now - lastShootTime > SHOOT_COOLDOWN) {
      net.sendShoot(theta, phi, heading);
      AudioManager.playShoot();
      lastShootTime = now;
    }

    // Bomba
    if (input.consumeBomb() && now - lastBombTime > BOMB_COOLDOWN) {
      net.sendBomb(theta, phi);
      lastBombTime = now;
    }

    // Rilevamento powerup lato client — fix per ritardo HTTP polling.
    // Con WebSocket il server lo rileva già via arc-check; con polling la posizione
    // predetta diverge e il server manca la collisione. Il client, che conosce la
    // posizione esatta, avvisa il server con try-collect.
    //
    // IMPORTANTE: riproviamo ogni TRY_COLLECT_RETRY_MS finché siamo in range e il
    // powerup esiste ancora. Una singola richiesta può perdersi (packet drop con
    // polling, disconnect transiente) oppure essere rifiutata temporaneamente
    // (es. giocatore morto per un istante sul server). Il retry garantisce che
    // appena le condizioni sono valide la collection venga confermata.
    for (const [id, pos] of powerupPositions) {
      if (sphereDist(theta, phi, pos.theta, pos.phi, FLY_ALTITUDE) >= POWERUP_COLLECT_RADIUS) continue;
      const last = powerupLastTryAt.get(id) ?? 0;
      if (now - last < TRY_COLLECT_RETRY_MS) continue;
      net.sendTryCollect(id);
      powerupLastTryAt.set(id, now);
    }
  }

  // Aerei remoti: interpolazione ogni frame verso lo stato rete
  if (inGame) {
    for (const p of allPlayerStates) {
      if (p.id === localPlayerId) continue;
      const plane = remoteAirplanes.get(p.id);
      if (!plane) continue;
      if (p.alive) {
        plane.mesh.visible = true;
        plane.tickRemote(delta);
      } else {
        plane.mesh.visible = false;
      }
    }
  }

  // Anima powerup
  for (const pu of powerupEntities.values()) pu.tick(delta);

  // Anima target
  targetEntity?.tick();

  // Aggiorna edifici (billboard barra progresso)
  for (const be of buildingEntities.values()) {
    if (be.progressGroup.visible) {
      be.progressGroup.lookAt(camera.position);
    }
  }

  // HUD
  if (inGame) {
    hud.update(localState, allPlayerStates, currentTarget, camera, boostEnergy / BOOST_MAX, input.isBoost());
  }

  composer.render();
}

animate();
