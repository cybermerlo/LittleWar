# LittleWar

A multiplayer 3D browser game built with Three.js. Players fly around a small planet Earth, chasing and shooting each other.

## Project Vision

- Small, cute low-poly planet Earth as the game world, orbitabile in poco tempo
- Superficie con elementi (montagne, edifici o simili) — non sfera liscia
- Multiplayer: amici si uniscono via link/codice stanza, unico server, max 10 giocatori per sessione
- Sessioni continue: si entra ed esce liberamente, nessuna lobby strutturata
- Gameplay: piccoli aerei low-poly volano radenti al suolo (altezza cielo) attorno al pianeta
- Stile visivo: low-poly cartoon, colori vivaci, mini mondo carino

## Gameplay

- **Veicoli**: piccoli aerei low-poly
- **Telecamera**: terza persona dietro l'aereo
- **Combattimento**: ispirato agli arcade classici tipo Aero Fighter
  - Arma base allo spawn, powerup raccoglibili che aumentano livello e dimensione dell'arma
  - Più armi potenti = aereo più pesante e lento (trade-off velocità/potenza)
  - Proiettili semplici (no laser), un colpo = eliminazione
- **Modalità**: chaos libero (deathmatch FFA) — in futuro team vs team
- **Identità**: nickname scelto al volo + personalizzazione colore aereo (no registrazione)

## Tech Stack

- **Frontend**: Three.js (vanilla JS) + Vite bundler
- **Backend / Multiplayer**: Node.js + Socket.IO (WebSocket con fallback polling)
- **Deployment**: GitHub → Railway (Railway pulls from the GitHub repo and deploys automatically)

## Deployment

Railway is configured to watch the GitHub repository and auto-deploy on push. The server must listen on the port provided by `process.env.PORT`.

## Three.js Skills

Skills are installed in `.claude/skills/` and are automatically loaded by Claude Code when relevant:

| Skill | When used |
|---|---|
| `threejs-fundamentals` | Scene, camera, renderer setup |
| `threejs-geometry` | Shapes and custom geometry |
| `threejs-materials` | PBR and custom materials |
| `threejs-lighting` | Lights and shadows |
| `threejs-textures` | Texture loading and UV mapping |
| `threejs-animation` | Keyframe and skeletal animation |
| `threejs-loaders` | GLTF/GLB and asset loading |
| `threejs-shaders` | Custom GLSL shaders |
| `threejs-postprocessing` | Bloom, DOF, screen effects |
| `threejs-interaction` | Raycasting, controls, input |

## Commands

```bash
npm install        # installa dipendenze
npm run dev        # avvia Vite dev server (porta 5173) + proxy a localhost:3000
npm start          # avvia server Express+Socket.io (porta 3000 o $PORT)
npm run build      # build produzione in dist/
```

In sviluppo aprire **due terminali**: uno per `npm start` (server), uno per `npm run dev` (client Vite).

## Architecture

- `shared/` — codice puro senza dipendenze (constants, movement math) importato sia da client che da server
- `shared/movement.js` — `moveOnSphere`, `sphericalToCartesian`, `cartesianToSpherical` (senza Three.js)
- `client/utils/SphereUtils.js` — re-esporta da shared + funzioni Three.js-dipendenti (`sphereOrientation`)
- `server/Game.js` — usa `moveOnSphere` da shared per **predizione server-side** (muove ogni player a ogni tick)
- Coordinate: theta = angolo polare (0..PI), phi = azimutale (0..2PI), heading = direzione di volo (0 = nord)

## Networking Notes (Railway)

- Railway **non supporta WebSocket affidabilmente** — Socket.IO ricade su HTTP polling
- Con polling lento (1 req/s), gli input arrivano tardi → il server predice il movimento server-side
- `Game.tick()` muove ogni player nella direzione corrente prima del broadcast; `updatePlayerInput` corregge
- Gli eventi `shoot` e `drop-bomb` **devono includere theta/phi/heading** dal client — la posizione predetta dal server diverge, specialmente quando si sta girando
- Socket.IO client configurato con `transports: ['websocket', 'polling']` (WebSocket prioritario)

## Development Notes

- Keep the game lightweight — it runs in the browser for casual sessions with friends
- Prefer simple, readable code over premature optimization
- Game logic decisions are still being finalized — wait for explicit instructions before implementing features
