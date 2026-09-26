import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { createPlanet } from './scene/Planet.js';
import { createTerrain, loadTreeTemplates, loadBuildingTemplates, loadHospitalTemplates } from './scene/Terrain.js';
import { createSky } from './scene/Sky.js';
import { setupLighting } from './scene/Lighting.js';
import { Airplane, preloadAirplaneModels } from './entities/Airplane.js';
import { ProjectileSystem } from './entities/Projectile.js';
import { BombEntity, spawnExplosionAt, initExplosionPool, tickExplosions } from './entities/Bomb.js';
import { PlaneShadows } from './entities/PlaneShadows.js';
import { PowerUpEntity } from './entities/PowerUp.js';
import { TargetEntity } from './entities/Target.js';
import {
  BuildingEntity,
  spawnTurretDestruction,
  preloadTurretBuildingModels,
  initTurretEffects,
  tickTurretEffects,
} from './entities/Building.js';
import { lightPool } from './scene/LightPool.js';
import { surfaceRadiusSpherical, sampleGround, makeSurfaceHit, fitGroundPlane } from './scene/planetSurface.js';
import { InputManager } from './systems/InputManager.js';
import { MobileControls, isTouchDevice } from './systems/MobileControls.js';
import { CameraController } from './systems/CameraController.js';
import { NetworkManager } from './systems/NetworkManager.js';
import { HUD } from './systems/HUD.js';
import { AudioManager } from './systems/AudioManager.js';
import { ChatManager } from './systems/ChatManager.js';
import { LobbyScreen } from './ui/LobbyScreen.js';
import { DeathScreen } from './ui/DeathScreen.js';
import { moveOnSphere, sphericalToCartesian } from './utils/SphereUtils.js';
import { getRenderQualityPreference, isLowPowerQuality } from './utils/performanceProfile.js';
import { PerfProbe } from './utils/perfProbe.js';
import { AdaptiveResolution } from './utils/adaptiveResolution.js';
import {
  BASE_SPEED, SPEED_REDUCTION_PER_LEVEL, MIN_SPEED,
  BOOST_MAX, BOOST_SPEED_MULT, BOOST_DRAIN_PER_SEC, BOOST_REGEN_PER_SEC,
  FORWARD_ACCEL, BACKWARD_ACCEL,
  EXTREME_BOOST_MULT, EXTREME_BOOST_DURATION,
  FLY_ALTITUDE, MAX_PLAYERS, CLIENT_INPUT_SEND_MS,
  POWERUP_COLLECT_RADIUS,
  RESPAWN_INVINCIBILITY, SHOOT_COOLDOWN_MS,
  BULLET_SPEED, BULLET_LIFETIME,
} from '../shared/constants.js';
import { shotHeadingOffsets } from '../shared/projectile.js';

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

const IS_TOUCH_DEVICE = isTouchDevice();
const LOW_POWER_DEFAULTS = isLowPowerQuality();
const RENDER_QUALITY_LABEL = getRenderQualityPreference();
const DEVICE_DPR = window.devicePixelRatio || 1;
const BASE_RENDER_DPR = LOW_POWER_DEFAULTS ? 1.0 : Math.min(DEVICE_DPR, IS_TOUCH_DEVICE ? 1.25 : 1.5);
/**
 * Risoluzione del bloom, come frazione della finestra.
 *
 * Misurato con la sonda F9 su Intel Iris Xe a 1920×1080: il bloom costava
 * 2.7 ms su 18.8 (il 14% del frame), secondo solo alla risoluzione di
 * rendering — e più di acqua, atmosfera, nuvole e superficie del pianeta
 * messe insieme. Ma è un effetto di sfocatura: la sua risoluzione non si
 * vede, si vede solo il suo raggio. Passando da 0.55 a 0.38 l'area da
 * elaborare si dimezza, e con essa gran parte di quei 2.7 ms.
 *
 * ATTENZIONE: passare una `resolution` al costruttore di UnrealBloomPass NON
 * ha alcun effetto. `EffectComposer.addPass()` e `setPixelRatio()` chiamano
 * `pass.setSize(larghezza × DPR, …)`, e `UnrealBloomPass.setSize()` ricalcola i
 * propri render target da quei valori ignorando `this.resolution`. Per anni il
 * bloom ha quindi girato a metà della risoluzione *di rendering* — 1402 px di
 * mip invece dei 523 previsti, cioè sette volte l'area — ed è per questo che
 * la sonda lo misurava al 44% del frame a batteria. L'unico modo per ridurlo
 * davvero è intercettare `setSize`, come si fa qui sotto.
 *
 * Non abbassarlo oltre senza guardare: sotto ~0.3 i punti luce piccoli
 * iniziano a sfarfallare, perché cadono dentro e fuori dai pixel del
 * target ridotto mentre l'aereo si muove.
 */
const BLOOM_SCALE = LOW_POWER_DEFAULTS ? 0.3 : (IS_TOUCH_DEVICE ? 0.32 : (DEVICE_DPR > 1.5 ? 0.34 : 0.38));
const BLOOM_INITIAL_STRENGTH = LOW_POWER_DEFAULTS ? 0 : (IS_TOUCH_DEVICE ? 0.12 : 0.22);

const renderer = new THREE.WebGLRenderer({
  antialias: !LOW_POWER_DEFAULTS,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(BASE_RENDER_DPR);
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
composer.setPixelRatio(BASE_RENDER_DPR);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth * BLOOM_SCALE, window.innerHeight * BLOOM_SCALE),
  BLOOM_INITIAL_STRENGTH,
  0.62,
  0.88,
);
bloomPass.enabled = !LOW_POWER_DEFAULTS;
// Deve stare PRIMA di addPass, che chiama subito setSize con la dimensione piena.
const _bloomSetSize = UnrealBloomPass.prototype.setSize.bind(bloomPass);
bloomPass.setSize = (width, height) => _bloomSetSize(
  Math.max(4, Math.round(width * BLOOM_SCALE)),
  Math.max(4, Math.round(height * BLOOM_SCALE)),
);
composer.addPass(bloomPass);


window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  // setSize propaga ai pass, e il bloom applica da solo la propria frazione.
  composer.setSize(window.innerWidth, window.innerHeight);
});

// Tasti chat (T, L, P) — delegati al ChatManager
window.addEventListener('keydown', (e) => chat.handleKey(e));

// ── Costruzione mondo ─────────────────────────────────────────────────────────

const lights = setupLighting(scene);
// Prima di qualunque altra cosa: le PointLight del pool entrano ora nella scena
// e non se ne vanno più. Il numero di luci resta costante per tutta la sessione,
// quindi Three.js non deve mai ricompilare gli shader in mezzo alla partita
// (vedi scene/LightPool.js — era la causa dei rallentamenti improvvisi).
lightPool.init(scene);

const sky = createSky(scene, lights, { lowQuality: LOW_POWER_DEFAULTS });
const {
  mesh: planetMesh,
  water: waterMesh,
  atmosphere: atmosphereMesh,
  update: updatePlanet,
} = createPlanet(scene, { lowQuality: LOW_POWER_DEFAULTS });

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyH' && !e.repeat) {
    _perfVisible = !_perfVisible;
    document.getElementById('perf-overlay').classList.toggle('visible', _perfVisible);
  }
  // F9 e non P: T, L e P sono già presi dalla chat.
  if (e.code === 'F9' && !e.repeat) {
    e.preventDefault();
    startPerfProbe();
  }
});

// ── Sonda prestazioni (F9) ────────────────────────────────────────────────────
// Il costo per-pixel non si può indovinare da lontano: dipende da GPU,
// risoluzione e fattore di scala del sistema. La sonda spegne un effetto alla
// volta e misura, così si interviene su ciò che pesa davvero.

const _setRenderScale = (scale) => {
  renderer.setPixelRatio(scale);
  composer.setPixelRatio(scale);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
};

/** Nasconde un Object3D ripristinandone poi la visibilità originale. */
function hideScenario(label, getObject) {
  let previous = null;
  return {
    label,
    off() {
      const o = getObject();
      previous = o ? o.visible : null;
      if (o) o.visible = false;
    },
    on() {
      const o = getObject();
      if (o && previous !== null) o.visible = previous;
      previous = null;
    },
  };
}

/**
 * Regolazione automatica della risoluzione: sulla stessa macchina il tempo di
 * frame raddoppia passando a batteria (18.8 -> 37.6 ms, misurato con F9), e il
 * caricabatterie si stacca a metà partita, quando un selettore in lobby non
 * serve più. Tocca solo la nitidezza, mai elementi visibili: vedi il modulo.
 */
const adaptiveResolution = new AdaptiveResolution({
  baseDpr: BASE_RENDER_DPR,
  apply: (dpr) => _setRenderScale(dpr),
});

const perfProbe = new PerfProbe([
  {
    label: 'bloom (post-processing)',
    off() { bloomPass.enabled = false; },
    on()  { bloomPass.enabled = !LOW_POWER_DEFAULTS; },
  },
  {
    label: `risoluzione a 1x (ora ${BASE_RENDER_DPR}x)`,
    off() { _setRenderScale(1); },
    on()  { _setRenderScale(BASE_RENDER_DPR); },
  },
  hideScenario('acqua', () => waterMesh),
  hideScenario('atmosfera', () => atmosphereMesh),
  hideScenario('nebulosa', () => sky.nebula),
  hideScenario('stelle', () => sky.stars),
  hideScenario('nuvole', () => sky.cloudRoot),
  hideScenario('cielo (sfondo)', () => sky.sky),
  hideScenario('alberi e case', () => terrainGroup),
  hideScenario('superficie del pianeta', () => planetMesh),
  {
    // Cambiare il numero di luci fa ricompilare gli shader: la pausa cade nei
    // frame di riscaldamento, non nel campione.
    label: 'luci puntiformi del pool',
    off() { for (const s of lightPool.slots) s.light.visible = false; },
    on()  { for (const s of lightPool.slots) s.light.visible = true; },
  },
], {
  // Il ciclo giorno/notte dura ~2:45 e la sonda decine di secondi: senza
  // congelarlo si confronterebbero scene diverse (la nebulosa a mezzogiorno
  // non costa nulla, l'acqua a notte fonda costa il doppio).
  freeze(frozen) { _skyFrozen = frozen; },
  context() {
    const r = renderer.info.render;
    const px = Math.round(window.innerWidth * adaptiveResolution.dpr) *
               Math.round(window.innerHeight * adaptiveResolution.dpr);
    return [
      `finestra ${window.innerWidth}×${window.innerHeight} × DPR ${adaptiveResolution.dpr.toFixed(2)}` +
        ` = ${(px / 1e6).toFixed(1)} Mpixel`,
      `qualita ${RENDER_QUALITY_LABEL} · ${(r.triangles / 1000).toFixed(0)}k triangoli` +
        ` · ${r.calls} draw call · ${allPlayerStates.length} giocatori`,
    ];
  },
});

/** True mentre la sonda misura: il cielo non avanza. */
let _skyFrozen = false;

function startPerfProbe() {
  if (perfProbe.running || !inGame) return;
  // La sonda cambia la risoluzione da sé: le due regolazioni si darebbero
  // battaglia e il referto sarebbe senza senso.
  adaptiveResolution.setEnabled(false);
  const el = document.getElementById('perf-content');
  document.getElementById('perf-overlay')?.classList.add('visible');
  _perfVisible = false; // la sonda scrive nell'overlay al posto delle statistiche
  if (el) el.textContent = 'Misurazione in corso — non toccare i comandi…';
  perfProbe.start((report) => {
    if (el) el.textContent = report;
    _perfVisible = false;
    _setRenderScale(adaptiveResolution.dpr);
    adaptiveResolution.setEnabled(true);
  });
}
/** Riferimento al terreno statico, usato dalla sonda prestazioni. */
let terrainGroup = null;

// Pool degli effetti: devono stare nella scena PRIMA della pre-compilazione,
// altrimenti il loro shader viene compilato alla prima esplosione — cioè
// esattamente nel momento più concitato della partita.
initExplosionPool(scene);
initTurretEffects(scene);
const planeShadows = new PlaneShadows(scene);

/** Risolve quando mondo e modelli sono pronti: gate per la pre-compilazione. */
const worldReady = Promise.all([
  loadTreeTemplates(),
  loadBuildingTemplates(),
  loadHospitalTemplates(),
  preloadTurretBuildingModels(),
  preloadAirplaneModels(),
]).then(([treeTemplates, buildingTemplates, hospitalTemplates]) => {
  terrainGroup = createTerrain(scene, treeTemplates, buildingTemplates, hospitalTemplates);
});

/**
 * Compila in anticipo i programmi GLSL di tutto ciò che è in scena.
 *
 * Senza questo passaggio Three.js compila il programma di un materiale la
 * prima volta che lo incontra durante il render: il primo albero, la prima
 * esplosione, la prima torretta conquistata producevano ognuno una pausa. La
 * compilazione qui avviene mentre si è ancora in lobby.
 */
let _shadersWarmed = false;
function warmupShaders() {
  if (_shadersWarmed) return Promise.resolve();
  _shadersWarmed = true;
  return worldReady
    .then(() => {
      if (typeof renderer.compileAsync === 'function') {
        return renderer.compileAsync(scene, camera);
      }
      renderer.compile(scene, camera);
      return undefined;
    })
    .catch(() => { /* la compilazione anticipata è un'ottimizzazione, non un requisito */ });
}

// Hook di ispezione per i test automatici (tests/visual-ground-check.mjs).
// `import.meta.env.DEV` è sostituito staticamente da Vite, quindi in build di
// produzione questo blocco viene eliminato.
if (import.meta.env?.DEV) {
  window.__lwDebug = {
    THREE, scene, camera, renderer, composer, sampleGround, makeSurfaceHit, fitGroundPlane,
    spawnExplosionAt: (pos, opts) => spawnExplosionAt(scene, pos, opts),
    get projectiles() { return projectiles; },
    get net() { return net; },
    get remoteAirplanes() { return remoteAirplanes; },
    sky,
    get localId() { return localPlayerId; },
    get localPos() { return localAirplane?.mesh.position.clone(); },
    teleport(t, p, h) { theta = t; phi = p; heading = h; },
  };
}

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
const mobile   = IS_TOUCH_DEVICE ? new MobileControls(input) : null;
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
const projectiles      = new ProjectileSystem(scene);
const bombEntities       = new Map();
/**
 * Dati statici dei giocatori (nickname, colore, modello). Non viaggiano più
 * nel game-state a ogni tick: arrivano una volta con `joined` /
 * `player-joined` e vengono riattaccati qui agli stati ricevuti.
 */
const playerInfo = new Map(); // playerId → { nickname, color, model }
function withInfo(p) {
  const info = playerInfo.get(p.id);
  if (info) {
    p.nickname = info.nickname;
    p.color = info.color;
    p.model = info.model;
  }
  return p;
}
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
/** Ultimo stato degli edifici (per l'HUD: torrette possedute). */
let   buildingStates     = [];
let   targetEntity       = null;
let   currentTarget      = null;
let   allPlayerStates    = [];
/** Ultimo nightFactor campionato (aggiornato ogni frame): serve al beacon torrette in onGameState. */
let   currentNightFactor = 0;
let   lastDeathFxAt      = 0;

// Powerup: posizioni note (da game-state) + timestamp ultimo try-collect per ID.
// Non marchiamo più i powerup come "tentati una volta" — se la prima richiesta
// viene persa (packet drop con polling, disconnect transiente, player morto per
// un istante sul server) i retry garantiscono che la collection venga confermata
// appena possibile. Il server è idempotente (`if (!pu) return`) quindi retry
// multipli sono sicuri.
const powerupPositions   = new Map(); // powerupId → {theta, phi}
const powerupLastTryAt   = new Map(); // powerupId → ms dell'ultimo try-collect inviato
const TRY_COLLECT_RETRY_MS = 300;     // ~3 retry/s finché in range e powerup presente

/**
 * Set riusati per il diff del game-state.
 *
 * `onGameState` arriva fino a 40 volte al secondo: allocare qui quattro Set
 * (più gli array intermedi di `.map()`) significava decine di migliaia di
 * oggetti al minuto da far raccogliere al GC, cioè micro-pause periodiche.
 * Svuotarli e riempirli costa zero allocazioni.
 */
const _seenPlayerIds = new Set();
const _seenBombIds   = new Set();
const _seenPuIds     = new Set();

/** Rimuove dalla mappa le entità che il server non elenca più. */
function pruneMissing(map, seen, onRemove) {
  for (const [id, entity] of map) {
    if (seen.has(id)) continue;
    onRemove(id, entity);
  }
}

// Throttle invio input (allineato al tick server)
let lastInputSend = 0;

// Shoot cooldown
let lastShootTime = 0;
const SHOOT_COOLDOWN = SHOOT_COOLDOWN_MS; // ms
/** Numero progressivo degli spari: id deterministici `${playerId}.${seq}:${i}`. */
let shotSeq = 0;

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
  AudioManager.warmupSfx();
  warmupShaders();
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
    projectiles.clear();
    playerInfo.clear();
    for (const p of players) playerInfo.set(p.id, { nickname: p.nickname, color: p.color, model: p.model });
    for (const [, e] of powerupEntities) e.dispose(scene);
    powerupEntities.clear();
    powerupPositions.clear();
    powerupLastTryAt.clear();

    // Crea aerei degli altri giocatori già presenti
    players.forEach(p => {
      if (p.id !== localPlayerId) {
        const plane = new Airplane(scene, THREE, p.color, p.model, false);
        plane.setNetworkState(p, performance.now(), net.oneWayMs, remoteBoostAmount(p));
        remoteAirplanes.set(p.id, plane);
        remoteWasDead.set(p.id, !p.alive);
        plane.mesh.visible = !!p.alive;
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
      for (const [, e] of buildingEntities) { e.dispose(scene); }
      buildingEntities.clear();
      buildings.forEach(b => {
        buildingEntities.set(b.id, new BuildingEntity(scene, b.id, b.theta, b.phi));
      });
      applyBuildingStates(buildings);
    }

    allPlayerStates = players;
    input.clearQueuedClicks();
    lobby.hide();
    hud.show();
    mobile?.show();
    chat.enable();
    inGame = true;
    document.body.classList.add('in-game');
  },

  onPlayerJoined(info) {
    playerInfo.set(info.id, { nickname: info.nickname, color: info.color, model: info.model });
    if (info.id === localPlayerId) return;
    remoteAirplanes.get(info.id)?.dispose(scene);
    const plane = new Airplane(scene, THREE, info.color, info.model, false);
    remoteAirplanes.set(info.id, plane);
    allPlayerStates.push({ ...info, kills: 0, bombPoints: 0, weaponLevel: 0 });
    lobby.setOnlineCount(allPlayerStates.length, MAX_PLAYERS);
  },

  onPlayerLeft({ id }) {
    playerInfo.delete(id);
    remoteAirplanes.get(id)?.dispose(scene);
    remoteAirplanes.delete(id);
    remoteWasDead.delete(id);
    allPlayerStates = allPlayerStates.filter(p => p.id !== id);
    lobby.setOnlineCount(allPlayerStates.length, MAX_PLAYERS);
  },

  onGameState(state) {
    _perfGsCount++;
    const recvAt = performance.now();
    for (const p of state.players) withInfo(p);
    allPlayerStates = state.players;

    // Rimuovi aerei remoti non più presenti nel game-state
    _seenPlayerIds.clear();
    for (const p of state.players) _seenPlayerIds.add(p.id);
    pruneMissing(remoteAirplanes, _seenPlayerIds, (id, plane) => {
      plane.dispose(scene);
      remoteAirplanes.delete(id);
      remoteWasDead.delete(id);
    });

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
          plane.resetRemote(p.theta, p.phi, p.heading, recvAt);
        }
        plane.mesh.visible = true;
        plane.setBoostParticlesVisible(true);
        plane.setNetworkState(p, recvAt, net.oneWayMs, remoteBoostAmount(p));
        remoteWasDead.set(p.id, false);
      } else {
        plane.mesh.visible = false;
        plane.setBoostParticlesVisible(false);
        remoteWasDead.set(p.id, true);
      }
    });

    // Bombe
    _seenBombIds.clear();
    for (const b of state.bombs) _seenBombIds.add(b.id);
    pruneMissing(bombEntities, _seenBombIds, (id, e) => {
      e.dispose(scene);
      bombEntities.delete(id);
    });
    state.bombs.forEach(b => {
      if (!bombEntities.has(b.id)) {
        if (
          localState
          && b.ownerId
          && b.ownerId !== localPlayerId
        ) {
          const dist = sphereDist(
            b.theta, b.phi,
            localState.theta, localState.phi,
            FLY_ALTITUDE,
          );
          AudioManager.playBombAtDistance(dist);
        }
        bombEntities.set(b.id, new BombEntity(scene, b.id, b.theta, b.phi, b.altitude));
      } else {
        bombEntities.get(b.id).update(b.theta, b.phi, b.altitude);
      }
    });

    // Powerup (stato server = fonte di verità: spariscono se non sono più nella lista)
    _seenPuIds.clear();
    for (const p of state.powerups) _seenPuIds.add(powerupKey(p.id));
    pruneMissing(powerupEntities, _seenPuIds, (id, e) => {
      e.dispose(scene);
      powerupEntities.delete(id);
      powerupPositions.delete(id);
      powerupLastTryAt.delete(id);
    });
    state.powerups.forEach(p => {
      const id = powerupKey(p.id);
      if (!powerupEntities.has(id)) {
        powerupEntities.set(id, new PowerUpEntity(scene, id, p.type, p.theta, p.phi));
      } else {
        powerupEntities.get(id).update(p.theta, p.phi);
      }
      powerupPositions.set(id, { theta: p.theta, phi: p.phi });
    });
  },

  /** Edifici: arrivano solo quando cambiano. */
  onBuildings(list) {
    applyBuildingStates(list);
  },

  /**
   * Una salva appena sparata (da chiunque, noi compresi). È l'unico messaggio
   * che un proiettile genera: il volo lo calcola il ProjectileSystem.
   */
  onShots(shot) {
    const now = performance.now();
    // L'età all'invio più il viaggio fino a qui: il proiettile compare dove è
    // davvero, non dove era quando il server ha spedito il messaggio.
    const spawnAt = now - (shot.ag ?? 0) - net.oneWayMs;
    const isTurret = typeof shot.o === 'string' && shot.o.startsWith('turret-');

    if (shot.o === localPlayerId) {
      // Nostra salva, già mostrata al momento dello sparo. Il server può aver
      // deciso un numero di colpi diverso (livello arma appena cambiato):
      // si aggiungono i mancanti e si tolgono quelli in più.
      const have = projectiles.salvoIndices(shot.id);
      const missing = [];
      for (let i = 0; i < shot.hd.length; i++) {
        if (!have.includes(i) && !projectiles.wasRemoved(`${shot.id}:${i}`)) missing.push(i);
      }
      for (const i of have) if (i >= shot.hd.length) projectiles.remove(`${shot.id}:${i}`);
      if (missing.length) {
        projectiles.spawnSalvo({
          shotId: shot.id, ownerId: shot.o, theta: shot.th, phi: shot.ph, headings: shot.hd,
          speed: shot.sp, lifetime: shot.lt, spawnAt, color: localState?.color, local: true,
          only: missing,
        });
      }
      return;
    }

    let altitude; // undefined → quota di volo
    let color = playerInfo.get(shot.o)?.color;
    if (isTurret) {
      // I colpi di torretta partono dalla bocca del cannone (~53 dal centro),
      // non a quota di volo. Il server continua a usare FLY_ALTITUDE per gli impatti.
      const be = buildingEntities.get(shot.o.slice('turret-'.length));
      if (be) {
        const tip = be.getCannonTipWorld();
        if (tip) altitude = tip.length();
        be.spawnMuzzleFlash();
        color = be.ownerColor ?? color;
      }
    }

    projectiles.spawnSalvo({
      shotId: shot.id, ownerId: shot.o, theta: shot.th, phi: shot.ph, headings: shot.hd,
      speed: shot.sp, lifetime: shot.lt, spawnAt, altitude, color, local: false,
    });

    // Un solo "bang" per salva, attenuato con la distanza.
    if (localState) {
      AudioManager.playShootAtDistance(sphereDist(shot.th, shot.ph, theta, phi, FLY_ALTITUDE));
    }
  },

  /** Il server non ha accettato un nostro sparo: via i colpi mostrati in anticipo. */
  onShotRejected({ seq }) {
    if (localPlayerId == null) return;
    projectiles.removeSalvo(`${localPlayerId}.${seq}`);
  },

  /** Un proiettile ha colpito qualcuno (deciso dal server o da chi ha sparato). */
  onProjectileHit({ id }) {
    if (projectiles.remove(id, _hitPos)) spawnImpact(_hitPos);
  },

  onPlayerKilled({ killerId, victimId, theta: t, phi: p, byTurret }) {
    // L'esplosione va dove l'aereo è *disegnato*, non dove lo aveva il server:
    // con il dead reckoning i due punti differiscono di qualche unità.
    const remote = remoteAirplanes.get(victimId);
    if (victimId === localPlayerId && localAirplane) _deathPos.copy(localAirplane.mesh.position);
    else if (remote?.mesh.visible) _deathPos.copy(remote.mesh.position);
    else {
      const c = sphericalToCartesian(t, p, FLY_ALTITUDE);
      _deathPos.set(c.x, c.y, c.z);
    }
    if (remote) {
      remote.mesh.visible = false;
      remote.setBoostParticlesVisible(false);
      remoteWasDead.set(victimId, true);
    }

    const fxNow = performance.now();
    if (fxNow - lastDeathFxAt > 90) {
      lastDeathFxAt = fxNow;
      spawnExplosionAt(scene, _deathPos);
      AudioManager.playExplosion();
    }

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
      AudioManager.playPopup();
    }
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
    // Quota del terreno vero: a raggio 50 fisso l'esplosione finiva sottoterra
    // su ogni collina (la superficie sale fino a 5.2 unità più in alto).
    const c = sphericalToCartesian(t, p, surfaceRadiusSpherical(t, p) + 0.3);
    spawnExplosionAt(scene, _deathPos.set(c.x, c.y, c.z), {
      scale: 1.35,
      color: hit ? 0xffffff : 0x9a7a60,
    });
    // Suono all’impatto: es. `AudioManager.playExplosion()` — disattivato per ora.
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
    spawnTurretDestruction(scene, theta, phi, surfaceRadiusSpherical(theta, phi) + 1.5);
    if (destroyerId === localPlayerId) {
      if (awardedKill) hud.showTowerDestroyedNotice();
      else hud.showOwnTowerDestroyedNotice();
    } else if (turretOwnerId === localPlayerId) {
      hud.showMyTurretDestroyedNotice(destroyerNickname);
    }
  },

  onRespawned(state) {
    isAlive = true;
    input.clearQueuedClicks();
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

/** Virata corrente del nostro aereo (rad/s), inviata al server. */
let _turnRate = 0;
/** Bersagli per i proiettili locali (aerei remoti come sono disegnati), riusati. */
const _hitTargets = [];
const _hitTargetPool = [];
const _hitPos = new THREE.Vector3();
const _deathPos = new THREE.Vector3();
const _shadowPos = new THREE.Vector3();
const _prevDrawPos = new THREE.Vector3();

/** Scintilla d'impatto di un proiettile. */
function spawnImpact(pos) {
  spawnExplosionAt(scene, pos, { scale: 0.32, sparks: 6, smoke: false });
}

function applyBuildingStates(list) {
  buildingStates = list;
  for (const b of list) {
    let e = buildingEntities.get(b.id);
    if (!e) {
      e = new BuildingEntity(scene, b.id, b.theta, b.phi);
      buildingEntities.set(b.id, e);
    }
    e.update(b, currentNightFactor);
  }
}

// ── Performance Overlay ───────────────────────────────────────────────────────

let _perfVisible = false;
let _perfFrameCount = 0;
let _perfLastFpsTime = performance.now();
let _perfFps = 0;
let _perfFrameMs = 0;
let _perfPingMs = -1;
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
  perfProbe.tick(_perfFrameMs);
  if (inGame) adaptiveResolution.tick(_perfFrameMs);
  if (now - _perfLastFpsTime >= 500) {
    _perfFps = Math.round(_perfFrameCount * 1000 / (now - _perfLastFpsTime));
    _perfGsRate = _perfGsCount * 1000 / (now - _perfLastGsTime);
    _perfFrameCount = 0;
    _perfGsCount = 0;
    _perfLastFpsTime = now;
    _perfLastGsTime = now;
  }
  if (perfProbe.running) {
    const el = document.getElementById('perf-content');
    if (el && el.textContent !== perfProbe.progress) el.textContent = perfProbe.progress;
  }
  if (_perfVisible) _perfPingMs = net.lastPingMs;

  sky.update(_skyFrozen ? 0 : delta);
  lights.follow(camera.position, delta);
  updatePlanet(_skyFrozen ? 0 : delta, lights, sky.horizonColor);
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
    const effectiveSpeed = speed * accel;
    const moved = moveOnSphere(theta, phi, heading, effectiveSpeed * delta);
    theta = moved.theta;
    phi   = moved.phi;
    heading = moved.heading;
    // Virata effettiva (rad/s), media morbida: la usano il server e gli altri
    // client per estrapolare il nostro volo tra un pacchetto e l'altro.
    const instTurn = delta > 1e-4 ? turnDelta / delta : 0;
    _turnRate += (instTurn - _turnRate) * Math.min(1, delta * 12);

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

    camCtrl.update(localAirplane.mesh, localAirplane.sphereQuaternion, localAirplane.flightQuaternion, delta);

    // Invia input al server (throttled)
    if (now - lastInputSend >= CLIENT_INPUT_SEND_MS) {
      net.sendInput(theta, phi, heading, boostActive, movingForward, movingBackward, effectiveSpeed, _turnRate);
      lastInputSend = now;
    }

    // Radio
    if (input.consumeRadio()) {
      const stationName = AudioManager.nextStation();
      hud.showRadioToast(stationName);
    }

    // Sparo: i colpi compaiono subito, senza aspettare il giro dal server.
    // Gli id sono deterministici, così la conferma del server (evento `shots`)
    // si aggancia a questi stessi proiettili invece di crearne altri.
    if (input.consumeShoot() && now - lastShootTime > SHOOT_COOLDOWN) {
      const seq = shotSeq++;
      projectiles.spawnSalvo({
        shotId: `${localPlayerId}.${seq}`,
        ownerId: localPlayerId,
        theta, phi,
        headings: shotHeadingOffsets(wl).map((o) => heading + o),
        speed: BULLET_SPEED,
        lifetime: BULLET_LIFETIME,
        spawnAt: now,
        color: localState.color,
        local: true,
      });
      net.sendShoot(seq, theta, phi, heading);
      AudioManager.playShoot();
      lastShootTime = now;
    }

    // Bomba: audio solo allo sgancio (suono impatto bomba eventualmente in onBombExploded).
    if (input.consumeBomb() && now - lastBombTime > BOMB_COOLDOWN) {
      net.sendBomb(theta, phi);
      AudioManager.playBomb();
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

  // Aerei remoti: dead reckoning fino ad "adesso" (più la latenza stimata).
  _hitTargets.length = 0;
  if (inGame) {
    const lead = net.oneWayMs;
    let n = 0;
    for (const [id, plane] of remoteAirplanes) {
      if (remoteWasDead.get(id) ?? true) continue;
      plane.setNightFactor(nightFactor);
      _prevDrawPos.copy(plane.mesh.position);
      const fresh = plane._drawnOnce !== true;
      plane.tickRemote(delta, now, lead);
      plane._drawnOnce = true;
      if (!plane.mesh.visible) continue;
      // Bersagli per i nostri proiettili: la posizione *disegnata*, con
      // quella del frame precedente per il test sul moto relativo.
      const slot = _hitTargetPool[n] ?? (_hitTargetPool[n] = { id: '', x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0 });
      slot.id = id;
      slot.x = plane.mesh.position.x;
      slot.y = plane.mesh.position.y;
      slot.z = plane.mesh.position.z;
      const from = fresh || _prevDrawPos.distanceToSquared(plane.mesh.position) > 100 ? plane.mesh.position : _prevDrawPos;
      slot.px = from.x;
      slot.py = from.y;
      slot.pz = from.z;
      _hitTargets.push(slot);
      n++;
    }
  }

  // Proiettili: volo calcolato qui a ogni frame. I nostri decidono i colpi:
  // se sul nostro schermo toccano un aereo, il colpo è a segno.
  projectiles.update(now, _hitTargets, (rec, target, ageMs, point) => {
    net.sendHit(rec.id, target.id, ageMs);
    spawnImpact(point);
  });

  // Ombre degli aerei sul terreno
  planeShadows.begin(nightFactor);
  if (inGame && isAlive && localAirplane?.mesh.visible) planeShadows.add(localAirplane.mesh.position);
  for (const t of _hitTargets) planeShadows.add(_shadowPos.set(t.x, t.y, t.z));
  planeShadows.end();

  // Anima powerup
  for (const pu of powerupEntities.values()) pu.tick(delta);

  // Anima target
  targetEntity?.tick();

  // Effetti (esplosioni, distruzione torrette, vampate di sparo): un solo tick
  // agganciato al delta reale, invece di un requestAnimationFrame per effetto
  // con dt fisso a 16 ms.
  tickExplosions(delta);
  tickTurretEffects(delta);

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
    // Il cannone segue il bersaglio scelto dal server, nella posizione in cui
    // è disegnato (ogni frame: prima scattava a 40 Hz sul dato di rete).
    if (be.turretTargetId) {
      const tgt = be.turretTargetId === localPlayerId
        ? (isAlive ? localAirplane?.mesh : null)
        : remoteAirplanes.get(be.turretTargetId)?.mesh;
      if (tgt?.visible) be.aimAt(tgt.position);
    }
    be.tick(delta, nightFactor);
  }

  // HUD
  if (inGame) {
    hud.update(
      localState, allPlayerStates, currentTarget, camera,
      boostEnergy / BOOST_MAX, input.isBoost(),
      buildingStates,
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
      `Qualita    ${RENDER_QUALITY_LABEL}`,
      `Risoluzione ${adaptiveResolution.label.padStart(9)}`,
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
      `Proiettili ${String(projectiles.count).padStart(6)}`,
      `Powerup    ${String(powerupEntities.size).padStart(6)}`,
      `Bombe      ${String(bombEntities.size).padStart(6)}`,
      `Edifici    ${String(buildingEntities.size).padStart(6)}`,
    ].filter(Boolean).join('\n');
    document.getElementById('perf-content').innerHTML = lines;
  }
}

animate();
