export const PLANET_RADIUS = 50;
export const FLY_ALTITUDE = 56;       // altitudine volo sopra la superficie
export const MAX_PLAYERS = 10;

/** Colori selezionabili in lobby (uno per slot giocatore; stessa cardinalità di MAX_PLAYERS). */
export const PLAYER_COLORS = [
  '#ff0000', // rosso
  '#0000ff', // blu
  '#ffff00', // giallo
  '#008000', // verde
  '#ffa500', // arancione
  '#800080', // viola
  '#ffc0cb', // rosa
  '#8b4513', // marrone
  '#ffffff', // bianco
  '#000000', // nero
];
export const TICK_RATE = 40;          // Hz server broadcast / simulazione
export const TICK_INTERVAL = 1000 / TICK_RATE;
/** Allinea l’invio input al tick server (evita ritardo extra tra client e broadcast). */
export const CLIENT_INPUT_SEND_MS = TICK_INTERVAL;

// Velocità aereo (radianti al SECONDO — moltiplicare per delta)
export const BASE_SPEED = 0.20;
export const SPEED_REDUCTION_PER_LEVEL = 0.025;
export const MIN_SPEED = 0.06;

// Boost
export const BOOST_MAX = 100;
export const BOOST_SPEED_MULT = 1.9;
export const BOOST_DRAIN_PER_SEC = 34;
export const BOOST_REGEN_PER_SEC = 11;
export const FORWARD_ACCEL = 1.3;
export const BACKWARD_ACCEL = 0.4;

// Rollio in virata (banking) — radianti
export const MAX_BANK_ANGLE = 0.38;      // ~22°
export const BANK_GAIN = 0.34;           // quanto il roll risponde alla velocità di virata (rad / (rad/s))
export const BANK_SMOOTH = 7.0;          // smorzamento esponenziale (~1/s)
export const BANK_MAX_DH_FRAME = 0.14;   // limite |Δheading| per frame (evita spike ai poli)

// Telecamera: quanto il rollio dell'aereo influenza l'orientamento della camera (0 = nessuno, 1 = come l'aereo)
export const CAMERA_BANK_FOLLOW = 0.55;

// Armi — tab fino a Lv.4; oltre si extrapola in getWeaponFireConfig
export const MAX_WEAPON_LEVEL = 24;
export const WEAPON_CONFIGS = [
  { bullets: 1, spread: 0,    speedMult: 1.00 },
  { bullets: 2, spread: 0.09, speedMult: 0.90 },
  { bullets: 3, spread: 0.17, speedMult: 0.80 },
  { bullets: 5, spread: 0.26, speedMult: 0.65 },
  { bullets: 7, spread: 0.44, speedMult: 0.50 },
];

/**
 * Pattern di fuoco per qualsiasi livello arma (server sparo + HUD).
 * Per livelli oltre WEAPON_CONFIGS continua a crescere colpi/spread come da ultimo gradino.
 */
export function getWeaponFireConfig(level) {
  const wl = Math.max(0, Math.floor(Number(level) || 0));
  if (wl < WEAPON_CONFIGS.length) return WEAPON_CONFIGS[wl];
  const last = WEAPON_CONFIGS[WEAPON_CONFIGS.length - 1];
  const over = wl - (WEAPON_CONFIGS.length - 1);
  return {
    bullets: last.bullets + over * 2,
    spread: Math.min(0.82, last.spread + over * 0.055),
    speedMult: Math.max(0.12, last.speedMult - over * 0.06),
  };
}

/** % velocità di crociera rispetto al livello 0 — stessa formula di client/main.js e server Game.tick */
export function getWeaponMoveSpeedPercent(level) {
  const wl = Math.max(0, Math.floor(Number(level) || 0));
  const spd = Math.max(MIN_SPEED, BASE_SPEED - wl * SPEED_REDUCTION_PER_LEVEL);
  return Math.round((spd / BASE_SPEED) * 100);
}

// Proiettili (radianti al SECONDO)
export const BULLET_SPEED = 0.95;
export const BULLET_LIFETIME = 1600;  // ms
export const BULLET_HIT_RADIUS = 0.9;

// Bombe (unità al SECONDO)
export const BOMB_FALL_SPEED = 4.0;
export const BOMB_HIT_RADIUS = 3.0;  // distanza dall'obiettivo per contare il colpo

// Powerup
export const POWERUP_COLLECT_RADIUS = 4.0;
export const POWERUP_LIFETIME = 30000;       // ms
export const POWERUP_RANDOM_INTERVAL = 12000; // ms tra spawn casuali
export const POWERUP_DROP_CHANCE = 0.5;      // 50% alla morte

// Respawn
export const RESPAWN_DELAY = 3000;           // ms
export const RESPAWN_INVINCIBILITY = 2000;   // ms di invulnerabilità dopo il respawn

// Scudo
export const SHIELD_INVINCIBILITY = 500;     // ms dopo aver perso lo scudo

// Edifici conquistabili / Torrette
export const BUILDING_COUNT = 7;
export const BUILDING_CONQUEST_RADIUS = 11.2; // unità cartesiane (raggio zona conquista)
export const BUILDING_CONQUEST_TIME = 10;    // secondi per conquistare
export const TURRET_RANGE = 25;              // unità cartesiane (raggio tiro torretta)
export const TURRET_FIRE_RATE = 1.5;         // secondi tra uno sparo e l'altro
export const TURRET_BULLET_SPEED = 0.7125;   // ~25% più lenti dei proiettili giocatore (rad/s)
export const TURRET_BULLET_LIFETIME = 1800;  // ms (leggermente superiore ai normali)
