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
- Nota: Per lanciare test: npm run dev

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

## Bug Log

### Powerup non raccoglibili in multiplayer (intermittente)

**Sintomo:** In multiplayer il giocatore vede il powerup, ci passa attraverso, nessun suono né arma data. In solo non accade.

**Causa radice (tre failure mode sovrapposti):**
1. **Divergenza posizione con HTTP polling (causa principale):** Su Railway, Socket.IO ricade su HTTP polling (~1 req/s). Il server predice il movimento dell'aereo in base all'ultimo heading ricevuto, ma se il client ha girato nel frattempo la posizione predetta diverge di ~11 unità (base speed × 1s). Il check tick-based usa la posizione sbagliata e non rileva la collisione.
2. **Miss geometrico dell'arc-check:** `_checkPowerupCollectionAlongPath` fa uno sweep sull'arco tra la posizione precedente e quella nuova del client. Se il giocatore ha curvato per avvicinarsi al powerup e poi ha curvato di nuovo (approach da lato), il powerup non cade sull'arco di cerchio massimo tra A e B → miss.
3. **Competizione con altri giocatori + ritardo evento:** Un altro giocatore raccoglie il powerup; l'evento `powerup-collected` arriva con ritardo polling → il powerup rimane visibile per ~1s e poi sparisce senza suono né effetto.

**Soluzione applicata (2026-04-14):** Rilevamento lato client + evento `try-collect`.
- `client/main.js`: ogni frame, quando vivo, controlla distanza sferica tra posizione locale e tutti i powerup noti. Se entro `POWERUP_COLLECT_RADIUS`, invia `try-collect { powerupId }` al server (una sola volta per ID tramite `triedPowerups` Set).
- `server/Game.js`: `tryCollectPowerup()` — se il powerup esiste ancora, lo raccoglie (no check di distanza: inutile con polling lag, gioco casual con amici).
- Server-side collection esistente rimane come backup per chi usa WebSocket.

**Tentativo 2026-04-16 (retry idempotente, NON HA FUNZIONATO):** Sostituito `triedPowerups Set` con `powerupLastTryAt Map`, retry ogni 300ms finché in range. Il bug è continuato a presentarsi anche **in locale** (escludendo packet loss/polling) e in particolare con due powerup sovrapposti uno solo veniva raccolto. Quindi il problema non era network né "una sola richiesta" — era altro, presumibilmente race server-side.

**Tentativo 2026-04-16 v2 (client autoritativo + feedback ottimistico):** Riprogettato il flusso di raccolta:
- **Server**: rimosse `_checkPowerupCollection` e `_checkPowerupCollectionAlongPath`. Erano due strade indipendenti che usavano posizione **predetta dal server** (divergente dalla realtà del client) per raccogliere i powerup. Generavano race con `try-collect`: a volte il check su posizione predetta cancellava un powerup mentre il client stava ancora avvicinandosi alla posizione vera → l'evento `powerup-collected` arrivava al client senza che lui avesse percepito la collisione, e i powerup vicini sovrapposti potevano essere "rubati" male. Rimanga unicamente `tryCollectPowerup` (idempotente). Aggiunto warning console se `try-collect` viene rifiutato per player non vivo.
- **Client**: aggiunto **feedback ottimistico immediato**. Appena il client locale rileva collisione con un powerup, nasconde subito l'entità dalla scena e suona l'effetto. Poi invia `try-collect` con retry ogni `POWERUP_RETRY_MS = 200ms` per max `POWERUP_RETRY_MAX_MS = 5000ms`. L'effetto di gameplay (weaponLevel/hasShield) resta autoritativo dal server via `game-state`. Se per caso il server non confermasse, il prossimo `game-state` ri-aggiunge automaticamente l'entità (rollback visivo), ma il giocatore ha sempre feedback immediato. Il client è ora unica fonte di verità per il rilevamento collisione (l'unico che conosce posizione esatta in real time).

**Se il problema persiste:** controllare i log server per `[powerup] try-collect rifiutato`. Se compare frequentemente con "non vivo", c'è un mismatch dello stato `alive` tra client e server. Se non compare mai e i powerup non si applicano lato gameplay, il problema è in `collectPowerup` (es. branch ramificato che non incrementa). Se la sparizione visiva ottimistica funziona ma l'upgrade non arriva, attivare un log temporaneo in `collectPowerup` con player/weaponLevel risultante.
