
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

## Peso dei modelli (2026-07-27)

I GLB avevano un aspetto low-poly ma non lo erano: una casa costava **7.765
triangoli** e un ospedale **16.996**, per oggetti alti 2–4 unità su un pianeta
di raggio 50, guardati quasi sempre dall'alto e da lontano. Con 80 case e 12
ospedali il solo terreno faceva **562k triangoli per frame** — l'89% della
scena — e siccome viene fuso in poche mesh che coprono tutto il pianeta non
viene mai scartato dal frustum culling.

`tools/decimate-models.mjs` li decima con meshoptimizer (via gltf-transform):

```bash
npm i --no-save @gltf-transform/core @gltf-transform/extensions \
                @gltf-transform/functions meshoptimizer draco3dgltf
node tools/decimate-models.mjs
```

| modello | prima | dopo |
|---|---|---|
| `hospital.glb` | 16.996 | 2.208 |
| `torretta_cesare.glb` | 13.348 | 3.751 |
| `building-house.glb` | 7.765 | 1.604 |
| `pre_torretta.glb` | 5.071 | 1.262 |
| **terreno in scena** | **562k** | **151k** |
| **totale disegnato** | **573k** | **163k** |

Gli originali stanno in `public/models/original/`: lo script riparte sempre da
lì, quindi si può ritarare un rapporto e rilanciare senza degradare due volte.
I rapporti sono nella costante `TARGETS` in cima al file.

**Cosa non è stato decimato e perché.** `spitfire.glb` ha 1.91 vertici per
triangolo, cioè vertici spezzati da normali/UV per faccia: meshopt non collassa
spigoli di bordo e in una mesh così ogni spigolo è di bordo, quindi si ferma al
4% di riduzione. Servirebbe togliere le normali, saldare per sola posizione,
semplificare e rigenerarle — ma è l'aereo del giocatore, sempre al centro dello
schermo. Alberi e powerup sono già leggeri (56–694 triangoli).

Dopo ogni decimazione **verificare i nomi**: il codice cerca il nodo
`Turret_Pivot` e i materiali `Gesso (5)` / `Gesso (7)` in `torretta_cesare`, e
il materiale `blue` nello spitfire. Lo script segnala ciò che sparisce.
(Nota: l'animazione dell'elica si chiama `helice`, non `PropellerAction` come
cerca `Airplane.js` — funziona solo grazie al fallback su `animations[0]`.)

### Decoder Draco servito in locale

Stava su jsDelivr. Se la CDN è lenta o irraggiungibile **tutti** i GLB compressi
falliscono in silenzio e il gioco ricade sui proxy procedurali: nessun errore,
solo un mondo diverso da quello previsto. Ora è in `public/draco/` (750 KB,
messo in cache dal browser). Aggiornando `three`, ricopiare i file — le
istruzioni sono in `client/utils/createGLTFLoader.js`.

## Sonda prestazioni (tasto F9)

Il costo per-pixel non si indovina: dipende da GPU, risoluzione e fattore di
scala del sistema operativo. `client/utils/perfProbe.js` spegne un effetto alla
volta durante la partita, misura il tempo di frame e stampa una classifica di
quanto si guadagnerebbe a rinunciarci. Si avvia con **F9** (non P: T, L e P
sono della chat) e dura una ventina di secondi.

Tre accorgimenti che sembrano dettagli e non lo sono, tutti nati da una prima
versione che dava risultati assurdi con effetti *più lenti da spenti*:

- **Ogni scenario è racchiuso fra due riferimenti** e confrontato con la loro
  media. Misurando il riferimento una volta sola all'inizio, tutta la deriva
  accumulata in decine di secondi (throttling, altre finestre) finiva
  attribuita all'ultimo effetto misurato.
- **Il ciclo giorno/notte viene congelato** durante la sonda: dura 2:45 minuti,
  meno della sonda stessa. Senza congelarlo si confrontano scene diverse — la
  nebulosa misurata a mezzogiorno non costa nulla, l'acqua misurata a notte
  fonda costa il doppio.
- **Il rumore si misura come differenza seconda** del riferimento, non come
  scarto max−min: una GPU che scala la frequenza mentre si scalda fa esplodere
  lo scarto pur restando perfettamente correggibile, e avvisare lì porterebbe
  solo a diffidare di dati buoni.

Se il riferimento sobbalza oltre il 12% del suo valore, la sonda lo dichiara
nel referto: sotto quella soglia i risparmi piccoli non sono attendibili.

### Cosa NON era il collo di bottiglia

Misurato su un Intel Iris Xe (i5-1135G7), a 1920×1080:

| | prima | dopo la decimazione |
|---|---|---|
| triangoli | 489.6k | 170.0k |
| FPS | 21 | 19 |

Ridurre i triangoli del 65% non ha spostato il tempo di frame di un
millisecondo. **Su questa scena la geometria non è il collo di bottiglia**: lo
è il fill rate, cioè quanti pixel si attraversano e con quali shader. La
decimazione resta utile (serve col multiplayer pieno e sulle macchine deboli)
ma va cercato altrove il guadagno grosso: risoluzione di rendering, bloom,
overdraw di acqua e atmosfera, numero di luci per frammento.

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
