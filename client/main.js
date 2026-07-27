import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { createPlanet } from './scene/Planet.js';
import { createTerrain, loadTreeTemplates, loadBuildingTemplates, loadHospitalTemplates } from './scene/Terrain.js';
import { createSky } from './scene/Sky.js';
import { setupLighting } from './scene/Lighting.js';
import { Airplane, preloadAirplaneModels } from './entities/Airplane.js';
import { ProjectileEntity } from './entities/Projectile.js';
import { BombEntity, spawnExplosion, initExplosionPool, tickExplosions } from './entities/Bomb.js';
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
import { groundRadiusSpherical, sampleGround, makeSurfaceHit } from './scene/planetSurface.js';
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

let renderQualityStage = LOW_POWER_DEFAULTS ? 2 : 0;

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

const sky = createSky(scene, lights, { qualityStage: renderQualityStage });
const {
  mesh: planetMesh,
  water: waterMesh,
  atmosphere: atmosphereMesh,
  heightData,
  posAttr,
  update: updatePlanet,
  setQualityStage: setPlanetQualityStage,
} = createPlanet(scene, { qualityStage: renderQualityStage });

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

/** Risolve quando mondo e modelli sono pronti: gate per la pre-compilazione. */
const worldReady = Promise.all([
  loadTreeTemplates(),
  loadBuildingTemplates(),
  loadHospitalTemplates(),
  preloadTurretBuildingModels(),
  preloadAirplaneModels(),
]).then(([treeTemplates, buildingTemplates, hospitalTemplates]) => {
  terrainGroup = createTerrain(scene, heightData, posAttr, planetMesh, treeTemplates, buildingTemplates, hospitalTemplates);
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
  window.__lwDebug = { THREE, scene, camera, renderer, sampleGround, makeSurfaceHit };
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
const _seenProjIds   = new Set();
const _seenBombIds   = new Set();
const _seenPuIds     = new Set();
const _shootSoundOwners = new Set();

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
    _seenProjIds.clear();
    for (const p of state.projectiles) _seenProjIds.add(p.id);
    pruneMissing(projectileEntities, _seenProjIds, (id, e) => {
      e.dispose(scene);
      projectileEntities.delete(id);
    });
    /** Un solo “bang” per salvo (stesso ownerId), così le armi multi-colpo non saturano l’audio. */
    _shootSoundOwners.clear();
    state.projectiles.forEach(p => {
      if (!projectileEntities.has(p.id)) {
        if (
          localState
          && p.ownerId !== localPlayerId
          && !_shootSoundOwners.has(p.ownerId)
        ) {
          _shootSoundOwners.add(p.ownerId);
          const dist = sphereDist(
            p.theta, p.phi,
            localState.theta, localState.phi,
            FLY_ALTITUDE,
          );
          AudioManager.playShootAtDistance(dist);
        }
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
    const fxNow = performance.now();
    if (fxNow - lastDeathFxAt > 90) {
      lastDeathFxAt = fxNow;
      spawnExplosion(scene, t, p, FLY_ALTITUDE);
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
    // Quota del terreno vero: a raggio 50 fisso l'esplosione finiva sottoterra
    // su ogni collina (la superficie sale fino a 5.2 unità più in alto).
    spawnExplosion(scene, t, p, groundRadiusSpherical(t, p) + 0.4, hit ? 0xffcc00 : 0x884400);
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
    spawnTurretDestruction(scene, theta, phi, groundRadiusSpherical(theta, phi) + 1.5);
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
  if (_perfVisible && now - _perfLastPingTime > 2000) {
    _perfLastPingTime = now;
    net.measurePing(ms => { _perfPingMs = ms; });
  }

  sky.update(_skyFrozen ? 0 : delta);
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
      `Proiettili ${String(projectileEntities.size).padStart(6)}`,
      `Powerup    ${String(powerupEntities.size).padStart(6)}`,
      `Bombe      ${String(bombEntities.size).padStart(6)}`,
      `Edifici    ${String(buildingEntities.size).padStart(6)}`,
    ].filter(Boolean).join('\n');
    document.getElementById('perf-content').innerHTML = lines;
  }
}

animate();
