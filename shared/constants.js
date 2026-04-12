export const PLANET_RADIUS = 50;
export const FLY_ALTITUDE = 56;       // altitudine volo sopra la superficie
export const MAX_PLAYERS = 10;
export const TICK_RATE = 20;          // Hz server broadcast
export const TICK_INTERVAL = 1000 / TICK_RATE;

// Velocità aereo
export const BASE_SPEED = 0.022;      // radianti/frame
export const SPEED_REDUCTION_PER_LEVEL = 0.003; // riduzione per livello arma
export const MIN_SPEED = 0.005;

// Armi
export const MAX_WEAPON_LEVEL = 4;
export const WEAPON_CONFIGS = [
  { bullets: 1, spread: 0,    speedMult: 1.00 },
  { bullets: 2, spread: 0.09, speedMult: 0.90 },
  { bullets: 3, spread: 0.17, speedMult: 0.80 },
  { bullets: 5, spread: 0.26, speedMult: 0.65 },
  { bullets: 7, spread: 0.44, speedMult: 0.50 },
];

// Proiettili
export const BULLET_SPEED = 0.06;     // radianti/frame sulla sfera
export const BULLET_LIFETIME = 2000;  // ms
export const BULLET_HIT_RADIUS = 1.2;

// Bombe
export const BOMB_GRAVITY = 0.04;     // unità/frame verso il centro
export const BOMB_HIT_RADIUS = 3.0;  // distanza dall'obiettivo per contare il colpo

// Powerup
export const POWERUP_COLLECT_RADIUS = 2.5;
export const POWERUP_LIFETIME = 30000;       // ms
export const POWERUP_RANDOM_INTERVAL = 12000; // ms tra spawn casuali
export const POWERUP_DROP_CHANCE = 0.5;      // 50% alla morte

// Respawn
export const RESPAWN_DELAY = 3000;           // ms

// Scudo
export const SHIELD_INVINCIBILITY = 500;     // ms dopo aver perso lo scudo
