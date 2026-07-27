
# NOTA PRELIMINARE: Ogni volta che fai una modifica strutturale al gioco modifica questo file.

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

Skills are installed in `.Codex/skills/` and are automatically loaded by Codex when relevant:

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

- `shared/` — codice puro senza dipendenze da Three.js, importato sia da client che da server
- `shared/movement.js` — `moveOnSphere`, `sphericalToCartesian`, `cartesianToSpherical`
- `shared/planetField.js` — **forma del pianeta** (campo di rumore con seed fisso): `heightAt01`,
  `radiusAt`, `slopeAtSpherical`, `sampleBuildableSite`. Client e server generano lo stesso
  pianeta senza scambiarsi dati, così il server può scegliere siti validi per torrette e bersagli
- `client/scene/planetSurface.js` — **superficie renderizzata** (vedi sotto): `sampleGround`,
  `fitGroundPlane`, `createConformingRingGeometry`
- `client/scene/LightPool.js` — pool di PointLight a numero fisso (vedi Performance Notes)
- `client/utils/SphereUtils.js` — re-esporta da shared + funzioni Three.js-dipendenti (`sphereOrientation`)
- `server/Game.js` — usa `moveOnSphere` da shared per **predizione server-side** (muove ogni player a ogni tick)
- Coordinate: theta = angolo polare (0..PI), phi = azimutale (0..2PI), heading = direzione di volo (0 = nord)

### Campo ideale vs superficie renderizzata (2026-07-27)

Distinzione da tenere presente ogni volta che si appoggia qualcosa sul pianeta:

- il **campo** (`shared/planetField.js`) è la forma matematica continua;
- la **superficie** è `IcosahedronGeometry(50, 5)` = **720 triangoli larghi ~10 unità**, i cui
  vertici stanno sul campo e il resto no (`detail` in `PolyhedronGeometry` suddivide ogni spigolo
  in `detail + 1` segmenti, non ricorsivamente: non sono 20k triangoli).

Lo scarto misurato tra le due è **0.28 unità in media e fino a 1.74** — più dell'altezza di un
albero (1.65). Per questo appoggiare gli oggetti alla quota analitica li lasciava sospesi al centro
delle facce e sepolti vicino alle creste.

`sampleGround(dir)` interseca il raggio uscente dal centro del pianeta con i triangoli reali e
restituisce punto e normale della faccia. Con `flatShading` quella normale è esattamente il piano
che l'occhio percepisce, quindi un oggetto orientato su di essa risulta piantato.
Indice spaziale: griglia su cubemap con risoluzione scelta in base alla dimensione dei triangoli,
più scansione completa di riserva (~3 µs a query).

**Regola: per piazzare qualcosa sul terreno usare `planetSurface.js`, mai `planetField.js`.**

## Networking Notes (Railway)

- Railway **non supporta WebSocket affidabilmente** — Socket.IO ricade su HTTP polling
- Con polling lento (1 req/s), gli input arrivano tardi → il server predice il movimento server-side
- `Game.tick()` muove ogni player nella direzione corrente prima del broadcast; `updatePlayerInput` corregge
- Gli eventi `shoot` e `drop-bomb` **devono includere theta/phi/heading** dal client — la posizione predetta dal server diverge, specialmente quando si sta girando
- Socket.IO client configurato con `transports: ['websocket', 'polling']` (WebSocket prioritario)

## Mobile Support (2026-04-17)

Il gioco è giocabile da browser mobile senza installazione.

### Architettura controlli
- `InputManager.getTurnAxis()` ritorna un valore analogico [-1, 1]: priorità tastiera → joystick touch → giroscopio.
- `isLeft()` / `isRight()` restano booleani (threshold 0.15) per compatibilità con la logica esistente.
- `MobileControls` (client/systems/MobileControls.js) gestisce joystick virtuale sinistro e bottoni FIRE/BOMB/BOOST/Centra. Su mobile il movimento in avanti è sempre attivo (nessun tasto W necessario).
- Detect mobile: `isTouchDevice()` in MobileControls.js → aggiunge `body.is-mobile`.
- Classe `body.in-game` aggiunta all'ingresso in partita, rimossa alla disconnessione.

### Giroscopio
- `DeviceOrientationEvent` — Android non richiede permessi; iOS 13+ richiede `DeviceOrientationEvent.requestPermission()` chiamato da un gesto utente.
- Il bottone "Sterza inclinando il telefono" nella lobby gestisce il flow permesso e calibra.
- Calibrazione: fissa il tilt corrente come zero (usare anche il bottone "Centra" in gioco).
- Deadzone: 4°, range completo: 22° — tunable in `InputManager.gyro.sensitivity / deadzone`.
- Orientazione schermo: usa `screen.orientation.angle` per remappare beta/gamma in base al landscape.
- iOS Safari **non supporta la Fullscreen API** — su Android e desktop funziona.

### Fullscreen
- Chiamato nel click handler di GIOCA (richiede contesto gesto utente).
- `exitFullscreen()` alla disconnessione dal server.
- Prefix webkit per Safari desktop: `el.webkitRequestFullscreen()`.

### CSS mobile
- Prompt rotazione (`#rotate-prompt`) mostrato in portrait su `body.is-mobile.in-game` via media query.
- HUD ridotto in landscape mobile: hud-players nascosto, hud-bottom e chat traslati a destra del joystick.
- Safe area insets (`env(safe-area-inset-*)`) nei controlli touch per compatibilità notch/home bar.

## Development Notes

- Keep the game lightweight — it runs in the browser for casual sessions with friends
- Prefer simple, readable code over premature optimization
- Game logic decisions are still being finalized — wait for explicit instructions before implementing features

## Performance Notes (2026-04-24)

Prima pass anti-rallentamenti:
- Render client: DPR massimo ridotto (desktop 1.5, touch 1.25), bloom renderizzato a risoluzione più bassa e ridotto su touch. Se il frame time resta alto per ~90 frame, il client abbassa automaticamente DPR; se continua, disabilita il bloom.
- HUD: testi e scoreboard non vengono più riscritti ogni frame se non cambiano; la classifica giocatori è throttled a 4 Hz.
- Combattimento: cooldown sparo condiviso client/server (`SHOOT_COOLDOWN_MS`) e limite autoritativo di proiettili attivi (`MAX_ACTIVE_PROJECTILES`) per evitare spike quando molti giocatori/torrette sparano insieme.

Prossime ottimizzazioni candidate se persistono spike:
- Ridurre broadcast `game-state` da 40 Hz a 20 Hz con interpolazione client.
- Disabilitare o fondere scie/particelle boost per aerei remoti lontani.
- Sostituire le luci puntiformi alari/beacon con soli puntini emissivi + bloom.
- Nascondere nebulosa/stelle/nuvole quando hanno opacità praticamente nulla.

Aggiornamento spike kill/respawn:
- `AudioManager.warmupSfx()` viene chiamato nel click di ingresso in partita per evitare decode/play spike al primo suono di morte/respawn.
- Gli effetti di morte ravvicinati sono coalescenti lato client: collisioni con due `player-killed` quasi simultanei non generano due esplosioni/audio nello stesso frame.
- Il kill feed non riproduce più il pop chat.
- I suoni SFX puntano agli asset finali OGG in `public/sounds/*.ogg`; `popup.ogg` viene riprodotto quando il giocatore locale elimina qualcuno, sia con sparo sia tramite propria torretta.
- Gli effetti separati degli aerei morti (boost particles + wingtip trails) non vengono resettati a ogni game-state se sono già nascosti.
- I fallback dei powerup riusano geometria/materiali condivisi.
- La death screen resta stilizzata ma non usa più `backdrop-filter`, perché blur/saturate sul frame della morte può causare jank.

Aggiornamento profilo batteria / laptop integrata (2026-04-25):
- Aggiunto `client/utils/performanceProfile.js`: la qualità è solo manuale (`high`/`low`) tramite selettore in lobby; default sempre `high`. Il cambio qualità salva `localStorage['littlewar:quality']` e ricarica la pagina prima dell'ingresso in partita, così mondo e asset nascono già col profilo scelto.
- Rimossa la modalità auto: il client non scala più DPR/bloom per frame lenti e non passa più a low in base alla batteria.
- Cielo e pianeta hanno `setQualityStage()`: stage alto disattiva bloom, atmosfera, nebulosa/stelle/nuvole costose e ferma l'animazione delle onde.
- Le PointLight minuscole di luci alari, beacon e muzzle flash sono disabilitate salvo `quality=high`; restano i puntini additivi visivi.
- I GLB decorativi del terreno (alberi/case/ospedali) sono caricati e usati solo con `quality=high`; in `low` il terreno usa proxy procedurali fusi per abbattere triangoli e draw call. La compressione GLB riduce download/cache ma non il numero di triangoli renderizzati.

## Rallentamenti improvvisi e appoggio a terra (2026-07-27)

Due problemi storici, entrambi risolti e verificati con `tests/visual-ground-check.mjs`
(avvia il gioco in Chromium headless, misura e fotografa).

### Causa dei freeze: il conteggio delle luci cambiava di continuo

In Three.js la program cache key di ogni materiale include il **numero** di luci in scena. Quando
quel numero cambia, `lights.state.version` avanza e al frame successivo **ogni materiale illuminato
ricompila il proprio shader**: una pausa da decine o centinaia di millisecondi, in mezzo alla
partita. `projectObject()` scarta gli oggetti invisibili *e le luci sotto di loro*, quindi il
conteggio cambiava a ogni:

- morte e respawn di un giocatore (2 PointLight alari per aereo sparivano con `mesh.visible = false`);
- conquista di una torretta (PointLight del beacon);
- **singolo colpo di torretta** (muzzle flash creava e distruggeva una PointLight).

In un deathmatch il conteggio non si stabilizzava mai → le pause tornavano per tutta la sessione.

**Soluzione:** `client/scene/LightPool.js`. Quattro PointLight create una volta sola, mai nascoste
né rimosse: chi ne ha bisogno prende uno slot e ne imposta posizione/colore/intensità. Intensità 0 =
spenta ma ancora contata, quindi il conteggio non cambia mai. Il pool è volutamente minuscolo:
ogni PointLight presente costa un ciclo nel fragment shader di *ogni* pixel illuminato. Gli slot
vanno a chi si vede davvero (2 aereo locale + 2 muzzle flash a rotazione); per beacon e aerei
remoti resta il puntino additivo con bloom, che è ciò che si nota da lontano.

> Se in futuro serve una luce dinamica, **prenderla dal pool**. Non aggiungere né rimuovere luci
> dalla scena a runtime, e non nasconderle con `visible = false`.

### Altre cause di pause

- **Compilazione shader al primo utilizzo.** `warmupShaders()` in `main.js` chiama
  `renderer.compileAsync(scene, camera)` all'ingresso in partita. I pool di effetti (esplosioni,
  distruzione torrette, muzzle flash) vengono registrati nella scena *prima*, con
  `initExplosionPool` / `initTurretEffects`: se una mesh entrasse in scena solo alla prima
  esplosione, il suo shader verrebbe compilato proprio in quell'istante.
- **Spazzatura per il GC.** `onGameState` arriva a 40 Hz e allocava quattro `Set` più gli array di
  `.map()` a ogni messaggio → ora usa set riusati. Eliminate anche le allocazioni per-frame in
  `Airplane` (clone di Vector3, doppio `updateMatrixWorld` ricorsivo, colori delle scie riscritti a
  ogni frame benché costanti) e in `BuildingEntity` (`_findNearestAlive`, `_aimTurretAt`, ritinta
  dei materiali a ogni game-state).
- **Un `requestAnimationFrame` per effetto**, con dt fisso a 16 ms: sostituiti da `tickExplosions`
  e `tickTurretEffects`, chiamati una volta per frame col delta reale.
- **Materiali del terreno duplicati.** I nove GLB portano ~194 istanze di materiale, ma moltissime
  sono lo stesso marrone corteccia o lo stesso verde foglia: raggruppando per *aspetto* invece che
  per uuid le draw call del terreno passano da **194 a 24**.

Provato e **scartato**: spezzare il terreno in chunk spaziali per il frustum culling. Misurato,
faceva salire le draw call del 26% per risparmiare la metà di appena 48k triangoli.

### Causa del "gli oggetti non poggiano": tre difetti sovrapposti

1. **Quota sbagliata.** Il piazzamento usava il campo analitico, mentre la superficie visibile è
   fatta di 720 facce piatte che se ne discostano fino a 1.74 unità (vedi Architecture). Ora tutto
   passa da `sampleGround`.
2. **Pivot buttato via.** `prepareTemplate` normalizzava la base del modello scrivendo l'offset
   nella `position` del root — ma il piazzamento *sovrascrive* quella stessa `position`, quindi la
   normalizzazione spariva e i modelli venivano appoggiati per la loro origine arbitraria. Ora
   l'offset vive in un figlio e `root.position` significa solo "dove poggia l'oggetto". Stesso
   problema in `makeProceduralBuilding`, che restituiva una Mesh con `position.y = h / 2`: risolto
   con `withGroundOrigin`, che riguardava la **qualità bassa**, cioè le macchine più deboli.
3. **Torrette a raggio fisso.** `BuildingEntity` piantava la torretta a `PLANET_RADIUS` esatto: su
   una collina finiva sepolta fino a `MOUNTAIN_HEIGHT` (5.2 unità). Ora la base segue un piano
   adattato al terreno sotto l'impronta.

Inoltre: gli anelli (zona di conquista, bersaglio bombardamento) sono **conformati al terreno** con
`createConformingRingGeometry` — un `RingGeometry` piatto di raggio 10 su una sfera di raggio 50
sprofonda di un'unità sul bordo per la sola curvatura, prima ancora di incontrare una collina. Le
esplosioni di bombe e la distruzione delle torrette usano la quota del terreno invece di 50 fisso.

Lato server, `generateBuildings` e `Target` usano `sampleBuildableSite`: prima la posizione era
puramente casuale e **il 64% del pianeta è oceano**, quindi in media 4 torrette su 7 nascevano in
acqua.

**Misure finali** (`node tests/visual-ground-check.mjs`, distanza dal terreno del vertice più basso
di ogni oggetto, negativo = sotto la superficie):

| | prima | dopo |
|---|---|---|
| basi alberi | fino a ±1.7 | −0.059 … −0.037 (voluto −0.05) |
| basi edifici | fino a −2.9 | −0.049 … +0.046 (voluto −0.04) |
| basi torrette | fino a −5.2 | 0.000 … 0.077 |
| draw call terreno | 194 | 24 |
| luci in scena | variabile | 8, costante |

### Verifica automatica

```bash
npm start & npx vite &          # servono entrambi
node tests/visual-ground-check.mjs tests/out
```

Stampa le statistiche di appoggio e salva screenshot ravvicinati in `tests/out/`. `quota locale
base` deve restare ~0: se non lo è, il problema non è il terreno ma il modello (pivot) o la
rotazione applicata — attenzione che una terna **mancina** passata a `Matrix4.makeBasis` è una
riflessione, e `Quaternion.setFromRotationMatrix` ne ricava un quaternione privo di senso.

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
