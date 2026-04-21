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
import { BuildingEntity, spawnTurretDestruction, preloadTurretBuildingModels } from './entities/Building.js';
import { InputManager } from './systems/InputManager.js';
import { MobileControls, isTouchDevice } from './systems/MobileControls.js';
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
  EXTREME_BOOST_MULT, EXTREME_BOOST_DURATION,
  WEAPON_CONFIGS, FLY_ALTITUDE, MAX_PLAYERS, CLIENT_INPUT_SEND_MS,
  POWERUP_COLLECT_RADIUS,
  RESPAWN_INVINCIBILITY,
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
// Disabilita auto-reset: EffectComposer chiama render() più volte per frame (uno per
// pass), e ogni call resetterebbe renderer.info.render azzerando il conteggio totale.
// Resettiamo manualmente una volta per frame in animate().
renderer.info.autoReset = false;
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
const { mesh: planetMesh, water: waterMesh, heightData, posAttr, update: updatePlanet } = createPlanet(scene);

// ── DEBUG: rete di superficie locale (tasto G per toggle) ─────────────────────
// Shader che scarta i segmenti oltre DBG_RADIUS unità dalla camera, con fade.
// Così si vede solo la rete vicina senza il caos dell'intero pianeta.
const DBG_RADIUS = 30;
const _dbgMat = new THREE.ShaderMaterial({
  uniforms: { uCam: { value: new THREE.Vector3() }, uR: { value: DBG_RADIUS } },
  vertexShader: `
    uniform vec3  uCam;
    varying float vDist;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vDist = length(wp.xyz - uCam);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: `
    uniform float uR;
    varying float vDist;
    void main() {
      if (vDist > uR) discard;
      float fade = 1.0 - smoothstep(uR * 0.55, uR, vDist);
      gl_FragColor = vec4(1.0, 0.1, 0.1, fade);
    }`,
  transparent: true,
  depthWrite: false,
  depthTest: false,
});
const _dbgPlanet = new THREE.LineSegments(new THREE.WireframeGeometry(planetMesh.geometry), _dbgMat);
const _dbgWater  = new THREE.LineSegments(new THREE.WireframeGeometry(waterMesh.geometry),  _dbgMat);
_dbgPlanet.renderOrder = _dbgWater.renderOrder = 999;
let _dbgVisible = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyG' && !e.repeat) {
    _dbgVisible = !_dbgVisible;
    _dbgVisible ? scene.add(_dbgPlanet, _dbgWater) : scene.remove(_dbgPlanet, _dbgWater);
  }
  if (e.code === 'KeyH' && !e.repeat) {
    _perfVisible = !_perfVisible;
    document.getElementById('perf-overlay').classList.toggle('visible', _perfVisible);
  }
});
Promise.all([
  loadTreeTemplates(),
  loadBuildingTemplates(),
  loadHospitalTemplates(),
  preloadTurretBuildingModels(),
]).then(([treeTemplates, buildingTemplates, hospitalTemplates]) => {
  createTerrain(scene, heightData, posAttr, planetMesh, treeTemplates, buildingTemplates, hospitalTemplates);
});

// ── Stato gioco ───────────────────────────────────────────────────────────────

AudioManager.init(); // carica stazioni in background

const input    = new InputManager();
document.getElementById('mc-radio')?.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  input.triggerTouchRadio();
});

document.getElementById('hud-back')?.addEventListener('click', () => {
  if (!inGame) return;
  net.disconnectVoluntary();
});
const mobile   = isTouchDevice() ? new MobileControls(input) : null;
if (mobile) document.body.classList.add('is-mobile');

// iOS non supporta requestFullscreen — mostra il banner "Aggiungi a schermata Home" se non già standalone
const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
if (_isIOS && !window.navigator.standalone) {
  const tip = document.getElementById('ios-home-tip');
  if (tip) {
    tip.style.display = 'flex';
    document.getElementById('ios-home-tip-close')?.addEventListener('click', () => {
      tip.style.display = 'none';
    });
  }
}

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
/** Ultimo nightFactor campionato (aggiornato ogni frame): serve al beacon torrette in onGameState. */
let   currentNightFactor = 0;

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
const SPIN_TURN_BOOST_MULT = 1.35;

// Boost locale
let boostEnergy = BOOST_MAX;

// Extreme Boost locale (ottimistico — sincronizzato dal game-state)
let localHasExtremeBoost = false;
let extremeBoostTimer = 0; // secondi rimanenti; > 0 = attivo
// True dal momento in cui il client attiva il boost fino alla conferma del server.
// Finché è true, i game-state con extremeBoosting:false non azzerano il timer
// (evita che il polling lento cancelli l'effetto ottimistico prima della conferma).
let _extremeBoostPendingConfirm = false;

// ── Lobby + Network ───────────────────────────────────────────────────────────

function _enterGame(nickname, color, model, solo = false) {
  if (!_isIOS) {
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
  AudioManager.startMusic();
  AudioManager.startEngine();
  if (solo) {
    net.joinSolo(nickname, color, model);
  } else {
    net.join(nickname, color, model);
  }
  lobby.setMessage('Connessione…');
}

const lobby = new LobbyScreen(
  (nickname, color, model) => _enterGame(nickname, color, model, false),
  (nickname, color, model) => _enterGame(nickname, color, model, true),
);

const net = new NetworkManager({
  onConnect() {
    lobby.setMessage('');
    lobby.setOnlineCount(0, MAX_PLAYERS);
  },

  onDisconnect({ voluntary } = {}) {
    AudioManager.stopMusic();
    AudioManager.stopEngine();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    death.hide();
    lobby.show();
    lobby.setMessage(voluntary ? '' : 'Disconnesso. Ricarica la pagina.');
    inGame = false;
    hud.hide();
    mobile?.hide();
    chat.disable();
    document.body.classList.remove('in-game');
  },

  onServerFull() {
    lobby.setFull(true);
    lobby.setMessage('Server pieno, riprova tra poco.');
  },

  onLobbyInfo({ takenColors, online }) {
    lobby.setTakenColors(takenColors);
    lobby.setOnlineCount(online, MAX_PLAYERS);
  },

  onColorTaken({ takenColors, invalidColor }) {
    lobby.setTakenColors(takenColors);
    lobby.setMessage(
      invalidColor
        ? 'Scegli uno dei colori della lista.'
        : 'Quel colore è già in uso! Scegline un altro.',
    );
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

    // Cleanup di entità eventualmente già create da game-state ricevuti prima
    // di 'joined'. Il server broadcasta game-state a TUTTI i socket connessi,
    // anche quelli ancora in lobby: al refresh il client crea entità via
    // onGameState, poi onJoined le ricreerebbe lasciando le vecchie orfane
    // nella scena (stelle freezate non raccoglibili).
    for (const [, plane] of remoteAirplanes) plane.dispose(scene);
    remoteAirplanes.clear();
    remoteWasDead.clear();
    for (const [, e] of projectileEntities) e.dispose(scene);
    projectileEntities.clear();
    for (const [, e] of powerupEntities) e.dispose(scene);
    powerupEntities.clear();
    powerupPositions.clear();
    powerupLastTryAt.clear();

    // Crea aerei degli altri giocatori già presenti
    players.forEach(p => {
      if (p.id !== localPlayerId) {
        const plane = new Airplane(scene, THREE, p.color, p.model, false);
        plane.update(p.theta, p.phi, p.heading, p.weaponLevel, p.hasShield, 0, remoteBoostAmount(p));
        remoteAirplanes.set(p.id, plane);
      }
    });

    // Powerup già presenti
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
    mobile?.show();
    chat.enable();
    inGame = true;
    document.body.classList.add('in-game');
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
    _perfGsCount++;
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
        // Bug fix: se il powerup viene appena raccolto (transizione false→true),
        // consuma eventuali double-tap pendenti per evitare l'attivazione automatica
        // involontaria che si verificava quando il giocatore aveva premuto Spazio
        // due volte di fila per volare verso il powerup.
        if (_extremeBoostPendingConfirm && extremeBoostTimer <= 0 && !p.extremeBoosting) {
          _extremeBoostPendingConfirm = false;
        }
        if (!localHasExtremeBoost && p.hasExtremeBoost) {
          input.boostDoubleTap = false;
          input.touch.boostDoubleTap = false;
        }
        // Non risincronizzare "ready" se il server non ha ancora processato activate-extreme-boost:
        // per un tick il server può avere ancora hasExtremeBoost:true mentre il client ha già
        // consumato il powerup in modo ottimistico — altrimenti localHas torna true e il boost
        // può riattivarsi / duplicare input.
        if (!(_extremeBoostPendingConfirm && extremeBoostTimer > 0 && !p.extremeBoosting)) {
          localHasExtremeBoost = !!p.hasExtremeBoost;
        }
        if (p.extremeBoosting) {
          // Server conferma boost attivo: rimuovi il flag pendente e assicura
          // che il timer sia positivo (per l'effetto visivo lato client).
          _extremeBoostPendingConfirm = false;
          if (extremeBoostTimer <= 0) extremeBoostTimer = EXTREME_BOOST_DURATION;
        } else if (!_extremeBoostPendingConfirm) {
          // Reset solo se non stiamo aspettando la conferma del server:
          // evita che il polling lento azzeri il timer ottimistico subito dopo
          // l'attivazione, prima che il server abbia processato l'evento.
          extremeBoostTimer = 0;
        }
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
        // Se è un proiettile da torretta, lo renderizziamo alla quota del tip
        // del cannone (~53.2 dal centro del pianeta) anziché FLY_ALTITUDE (56):
        // altrimenti il proiettile appare 2-3 unità sopra la bocca del cannone.
        // Il server continua a tracciare la collisione a FLY_ALTITUDE.
        let altitude; // undefined → default del ProjectileEntity
        if (typeof p.ownerId === 'string' && p.ownerId.startsWith('turret-')) {
          const buildingId = p.ownerId.slice('turret-'.length);
          const be = buildingEntities.get(buildingId);
          if (be) {
            const tip = be.getCannonTipWorld();
            if (tip) altitude = tip.length();
            be.spawnMuzzleFlash();
          }
        }
        projectileEntities.set(p.id, new ProjectileEntity(scene, p.id, p.theta, p.phi, altitude));
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
        buildingEntities.get(b.id).update(b, allPlayerStates, camera, currentNightFactor);
      });
    }
  },

  onPlayerKilled({ killerId, victimId, theta: t, phi: p, byTurret }) {
    spawnExplosion(scene, t, p, FLY_ALTITUDE);
    AudioManager.playExplosion();

    if (victimId === localPlayerId) {
      isAlive = false;
      // Ferma motore e boost: il game loop non li aggiorna più quando !isAlive
      AudioManager.stopEngine();
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
    _invincibleUntil = Date.now() + RESPAWN_INVINCIBILITY;
    death.hide();
    AudioManager.startEngine();
  },

  onChatMessage(msg) {
    chat.receive(msg);
  },
});

// ── Aereo locale ──────────────────────────────────────────────────────────────
// Creato quando riceviamo onJoined, ma ci serve il colore — lo creiamo dopo.
// Usiamo un riferimento lazy.
let localAirplane = null;
let _invincibleUntil = 0;

function ensureLocalAirplane(color, model) {
  if (!localAirplane) {
    localAirplane = new Airplane(scene, THREE, color, model, true);
  }
}

// ── Performance Overlay ───────────────────────────────────────────────────────

let _perfVisible = false;
let _perfFrameCount = 0;
let _perfLastFpsTime = performance.now();
let _perfFps = 0;
let _perfFrameMs = 0;
let _perfPingMs = -1;
let _perfLastPingTime = 0;
let _perfGsCount = 0;
let _perfLastGsTime = performance.now();
let _perfGsRate = 0;

// ── Game Loop ─────────────────────────────────────────────────────────────────

const clock = new THREE.Clock();

// Cache posizione camera per throttle su billboard lookAt (vedi aggiornamento edifici).
// Soglia conservativa: 0.25 unità di movimento (distanceSq > 0.0625) produce un
// cambio angolare < 1° su barre conquista a ~30 unità → impercettibile.
const _prevCamPos = new THREE.Vector3(Infinity, Infinity, Infinity);
const CAM_MOVE_THRESHOLD_SQ = 0.0625;

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const now = performance.now();

  // ── Perf overlay ────────────────────────────────────────────────────────────
  _perfFrameCount++;
  _perfFrameMs = delta * 1000;
  if (now - _perfLastFpsTime >= 500) {
    _perfFps = Math.round(_perfFrameCount * 1000 / (now - _perfLastFpsTime));
    _perfGsRate = _perfGsCount * 1000 / (now - _perfLastGsTime);
    _perfFrameCount = 0;
    _perfGsCount = 0;
    _perfLastFpsTime = now;
    _perfLastGsTime = now;
  }
  if (_perfVisible && now - _perfLastPingTime > 2000) {
    _perfLastPingTime = now;
    net.measurePing(ms => { _perfPingMs = ms; });
  }

  sky.update(delta);
  updatePlanet(delta, camera.position);
  if (_dbgVisible) _dbgMat.uniforms.uCam.value.copy(camera.position);
  const nightFactor = typeof sky.getNightFactor === 'function' ? sky.getNightFactor() : 0;
  currentNightFactor = nightFactor;

  if (inGame && isAlive && localState) {
    ensureLocalAirplane(localState.color ?? '#ff4444', localState.model ?? 'airplane');

    // Velocità in base al livello arma (radianti/secondo * delta)
    const wl = localState.weaponLevel ?? 0;
    const turnInput = input.getTurnAxis();
    // Su mobile: in curva la velocità si riduce proporzionalmente al joystick,
    // così il raggio di virata si stringe senza penalizzare il rettilineo.
    const mobileSpeedMult = mobile ? (1.0 - 0.4 * Math.abs(turnInput)) : 1.0;
    const baseSpeed = Math.max(MIN_SPEED, BASE_SPEED - wl * SPEED_REDUCTION_PER_LEVEL) * mobileSpeedMult;

    // Extreme Boost: attivazione da doppio tap + countdown
    if (localHasExtremeBoost && extremeBoostTimer <= 0 && input.consumeBoostDoubleTap()) {
      net.sendActivateExtremeBoost();
      localHasExtremeBoost = false;
      extremeBoostTimer = EXTREME_BOOST_DURATION;
      _extremeBoostPendingConfirm = true;
    }
    if (extremeBoostTimer > 0) {
      extremeBoostTimer = Math.max(0, extremeBoostTimer - delta);
    }
    const extremeBoostActive = extremeBoostTimer > 0;

    const wantsBoost = !extremeBoostActive && input.isBoost();
    const boostActive = wantsBoost && boostEnergy > 0.01;
    if (boostActive) {
      boostEnergy = Math.max(0, boostEnergy - BOOST_DRAIN_PER_SEC * delta);
    } else if (!extremeBoostActive) {
      boostEnergy = Math.min(BOOST_MAX, boostEnergy + BOOST_REGEN_PER_SEC * delta);
    }
    const speedMult = extremeBoostActive ? EXTREME_BOOST_MULT : (boostActive ? BOOST_SPEED_MULT : 1);
    const speed = baseSpeed * speedMult;

    if (input.consumeLeftDoubleTap()) localAirplane.triggerSpin(-1);
    if (input.consumeRightDoubleTap()) localAirplane.triggerSpin(1);

    // Input → aggiorna heading e posizione (tutto * delta)
    const turnSpeed = 1.8; // rad/s
    let turnDelta = turnInput * turnSpeed * delta;
    if (
      turnInput !== 0 &&
      localAirplane.isSpinning() &&
      Math.sign(turnInput) === localAirplane.getSpinDirection()
    ) {
      turnDelta *= SPIN_TURN_BOOST_MULT;
    }
    heading += turnDelta;

    // Movimento in avanti sempre attivo
    const movingForward = input.isForward();
    const movingBackward = input.isBackward();

    // Aggiorna volume motore (extreme boost trattato come boost pieno)
    const anyBoostActive = boostActive || extremeBoostActive;
    AudioManager.updateEngine(movingForward, anyBoostActive, delta);
    if (anyBoostActive) { AudioManager.startBoost(); } else { AudioManager.stopBoost(); }
    // Su mobile l'asse Y del joystick (0..1) interpola tra FORWARD_ACCEL e BACKWARD_ACCEL
    const brakeT = input.touch.speedAxis; // 0 = nessun freno, 1 = freno massimo
    const forwardAccel = FORWARD_ACCEL - (FORWARD_ACCEL - BACKWARD_ACCEL) * brakeT;
    const accel = movingForward ? forwardAccel : movingBackward ? BACKWARD_ACCEL : 1;
    const moved = moveOnSphere(theta, phi, heading, speed * accel * delta);
    theta = moved.theta;
    phi   = moved.phi;
    heading = moved.heading;

    localAirplane.setNightFactor(nightFactor);
    localAirplane.update(
      theta,
      phi,
      heading,
      wl,
      localState.hasShield ?? false,
      delta,
      extremeBoostActive ? 1.0 : (boostActive ? (boostEnergy / BOOST_MAX) : 0),
    );
    // Blink durante invincibilità post-respawn (5 Hz, 100ms on/off)
    if (Date.now() < _invincibleUntil) {
      localAirplane.mesh.visible = Math.floor(Date.now() / 100) % 2 === 0;
    } else {
      localAirplane.mesh.visible = true;
    }

    camCtrl.update(localAirplane.mesh, localAirplane.sphereQuaternion, localAirplane.flightQuaternion);

    // Invia input al server (throttled)
    if (now - lastInputSend >= CLIENT_INPUT_SEND_MS) {
      net.sendInput(theta, phi, heading, boostActive, movingForward, movingBackward);
      lastInputSend = now;
    }

    // Radio
    if (input.consumeRadio()) {
      const stationName = AudioManager.nextStation();
      hud.showRadioToast(stationName);
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
        plane.setNightFactor(nightFactor);
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

  // Aggiorna edifici: billboard barra progresso + beacon notturno lampeggiante.
  // Il lookAt sulla progressGroup è costoso; la saltiamo quando la camera non si
  // è mossa abbastanza (e forziamo l'update alla prima apparizione della barra).
  const camMovedEnough =
    _prevCamPos.distanceToSquared(camera.position) >= CAM_MOVE_THRESHOLD_SQ;
  if (camMovedEnough) _prevCamPos.copy(camera.position);
  for (const be of buildingEntities.values()) {
    if (be.progressGroup.visible && (camMovedEnough || !be._progressOriented)) {
      be.progressGroup.lookAt(camera.position);
      be._progressOriented = true;
    }
    be.tick(delta, nightFactor);
  }

  // HUD
  if (inGame) {
    hud.update(
      localState, allPlayerStates, currentTarget, camera,
      boostEnergy / BOOST_MAX, input.isBoost(),
      undefined, // buildings (già passato altrove)
      localHasExtremeBoost,
      extremeBoostTimer,
    );
  }

  renderer.info.reset();
  composer.render();

  // Overlay letto dopo il render: renderer.info accumula su tutti i pass del composer
  if (_perfVisible) {
    const mem = performance.memory;
    const ri = renderer.info.render;
    const col  = (v, w, e, s) => `<span style="color:${v>=e?'#ff4444':v>=w?'#ffcc00':'#00ff99'}">${s}</span>`;
    const coli = (v, w, e, s) => `<span style="color:${v<=e?'#ff4444':v<=w?'#ffcc00':'#00ff99'}">${s}</span>`;
    const heapMB = mem ? mem.usedJSHeapSize / 1048576 : -1;
    const lines = [
      `── Rendering ─────────────`,
      `FPS        ${coli(_perfFps,  50, 30, String(_perfFps).padStart(6))}`,
      `Frame      ${col(_perfFrameMs, 20, 33, _perfFrameMs.toFixed(1).padStart(5)+' ms')}`,
      `Draw calls ${col(ri.calls, 300, 600, String(ri.calls).padStart(6))}`,
      `Triangoli  ${col(ri.triangles/1000, 200, 500, (ri.triangles/1000).toFixed(1).padStart(5)+' k')}`,
      heapMB >= 0 ? `Heap JS    ${col(heapMB, 200, 400, heapMB.toFixed(1).padStart(4)+' MB')}` : '',
      ``,
      `── Rete ──────────────────`,
      `Ping       ${_perfPingMs < 0 ? '     …' : col(_perfPingMs, 100, 300, String(_perfPingMs).padStart(4)+' ms')}`,
      `Transport  ${net.getTransport().padStart(9)}`,
      `GS/s       ${coli(_perfGsRate, 30, 20, _perfGsRate.toFixed(1).padStart(6))}`,
      ``,
      `── Entità ────────────────`,
      `Giocatori  ${String(allPlayerStates.length).padStart(6)}`,
      `Proiettili ${String(projectileEntities.size).padStart(6)}`,
      `Powerup    ${String(powerupEntities.size).padStart(6)}`,
      `Bombe      ${String(bombEntities.size).padStart(6)}`,
      `Edifici    ${String(buildingEntities.size).padStart(6)}`,
    ].filter(Boolean).join('\n');
    document.getElementById('perf-content').innerHTML = lines;
  }
}

animate();
