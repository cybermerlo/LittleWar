
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
npm test           # test server + prova end-to-end del netcode (avvia un server su porta libera)
```

In sviluppo aprire **due terminali**: uno per `npm start` (server), uno per `npm run dev` (client Vite).

## Architecture

- `shared/` — codice puro senza dipendenze da Three.js, importato sia da client che da server
- `shared/movement.js` — `moveOnSphere`, `advanceOnSphere` (volo con virata, per predizione e
  dead reckoning), `sphericalToCartesian`, `cartesianToSpherical`
- `shared/projectile.js` — **traiettoria dei proiettili** (`makeTrajectory`, `trajectoryPoint`),
  raffica per livello arma (`shotHeadingOffsets`), test segmento-punto. Identica su client e server:
  vedi "Netcode dei proiettili"
- `shared/planetField.js` — **forma del pianeta** (campo di rumore con seed fisso): `elevationAt`,
  `heightAt01`, `radiusAt`, `slopeAtSpherical`, `sampleBuildableSite`. Client e server generano lo
  stesso pianeta senza scambiarsi dati, così il server può scegliere siti validi per torrette e bersagli
- `client/scene/planetSurface.js` — **superficie renderizzata** (vedi sotto): `sampleGround`,
  `fitGroundPlane`, `createConformingRingGeometry`, `SEA_SURFACE_RADIUS`, `surfaceRadiusSpherical`
- `client/scene/planetBiomes.js` — biomi (solo estetica, solo client): colore delle facce e regole
  per boschi e paesi
- `client/scene/Lighting.js` — luci; `lights.follow()` tiene il sole sulla zona inquadrata
- `client/scene/LightPool.js` — pool di PointLight a numero fisso (vedi Performance Notes)
- `client/entities/Projectile.js` — `ProjectileSystem`: volo dei proiettili calcolato a ogni frame,
  due InstancedMesh (nuclei + scie), rilevamento dei colpi del giocatore locale
- `client/entities/Bomb.js` — bombe ed **esplosioni** (pool fisso: lampo, fuoco, fumo, scintille, onda)
- `client/entities/PlaneShadows.js` — ombra sotto ogni aereo (una sola InstancedMesh)
- `client/utils/SphereUtils.js` — re-esporta da shared + funzioni Three.js-dipendenti (`sphereOrientation`)
- `client/scene/PostFX.js` — bloom e passata finale unica (grading, ACES, effetti di gioco); `worldShaders.js`,
  `NightLights.js`, `CloudShadows.js` — finestre, aloni dei paesi, ombre delle nuvole e vento dentro i
  materiali esistenti; `client/scene/life/` — barche, uccelli, fumo, fari, aurora, sentieri
- `client/entities/` — oltre agli aerei: `TrailRibbons` (tutte le scie in una mesh), `AircraftFx`,
  `Wreckage`, `SpeedLines`, `airplaneLook` (patch dei materiali degli aerei), `glowSprite`, `ObjectiveFx`
  (effetti di torrette, powerup, bersaglio e bombe in quattro batch)
- `client/ui/LobbyAttract.js` — lobby dal vivo; `client/systems/hud/` — mirino, indicatori, radar
- Vedi "Grafica: pipeline, mondo vivo, aerei, obiettivi, interfaccia (2026-09-26)" per regole e trappole
- `server/Game.js` — usa `advanceOnSphere` da shared per **predizione server-side** (muove ogni player
  a ogni tick) e per la compensazione della latenza degli input
- Coordinate: theta = angolo polare (0..PI), phi = azimutale (0..2PI), heading = direzione di volo
  (0 = "nord" del codice, cioè verso theta **crescente**; π/2 = est)

### Campo ideale vs superficie renderizzata

Distinzione da tenere presente ogni volta che si appoggia qualcosa sul pianeta:

- il **campo** (`shared/planetField.js`) è la forma matematica continua;
- la **superficie** è una `IcosahedronGeometry` con `DETAIL = 36` (≈ 27k facce larghe ~1.4 unità,
  vedi `client/scene/Planet.js`), i cui vertici stanno sul campo e il resto no (`detail` in
  `PolyhedronGeometry` suddivide ogni spigolo in `detail + 1` segmenti, non ricorsivamente).

Fino al 2026-09 la mesh aveva `detail = 5`, cioè 720 facce da 10 unità, e lo scarto misurato tra
campo e superficie era 0.28 unità in media e fino a 1.74 — più dell'altezza di un albero. Con la
mesh fitta lo scarto è molto minore, ma la regola resta.

`sampleGround(dir)` interseca il raggio uscente dal centro del pianeta con i triangoli reali e
restituisce punto e normale della faccia. Le facce sono piatte (geometria non indicizzata, normali
di faccia), quindi quella normale è esattamente il piano che l'occhio percepisce e un oggetto
orientato su di essa risulta piantato. Sul mare `sampleGround` restituisce il **fondale**: per
effetti ed esplosioni usare `surfaceRadiusSpherical` (terra emersa o pelo dell'acqua).
Indice spaziale: griglia su cubemap con celle mai più piccole di un triangolo (anche agli angoli
del cubo, dove la proiezione le rimpicciolisce), più scansione completa di riserva (~3 µs a query).

**Regola: per piazzare qualcosa sul terreno usare `planetSurface.js`, mai `planetField.js`.**

## Pianeta low-poly a biomi (2026-09-24)

- **Forma** (`shared/planetField.js`): continenti da fbm a poche ottave con domain warp (~52% di
  terra), spiaggia corta, **pianure ampie** a quota 0.78, colline e catene montuose decise da un
  rumore di *rilievo* indipendente dalla costa, fondale vero fino a −2.6 con piattaforme basse
  vicino a riva. Le vette restano ≤ `MOUNTAIN_HEIGHT` (5.2): gli aerei volano a 56.
  Due tentativi scartati: rilievo legato alla distanza dalla costa (la pianura era una striscia e
  ci stava un paese ogni 50 tentativi) e fbm a 5 ottave piene (coste frattali con scogliera
  sottomarina subito dietro la spiaggia). Metrica utile: quota di terra con un anello di 4.5 unità
  pianeggiante — ora ~12%, prima 2%.
- **Colori** (`client/scene/planetBiomes.js`): un colore per *faccia*, non per vertice, dal bioma
  (quota, pendenza, temperatura = latitudine + quota, umidità = rumore). Calotte polari, tundra,
  deserti, savane, prati, foreste, rocce, cime innevate, fondali dal turchese al blu.
- **Mare**: stessa suddivisione del terreno, così ogni vertice dell'acqua conosce la profondità
  esatta del terreno sotto (`aDepth`): colore per profondità, schiuma dove la profondità tende a
  zero (cioè sulla costa disegnata), ghiaccio vicino ai poli, normali di faccia dalle derivate.
  Le facce interamente sopra la costa non vengono create.
- **Sole che segue la zona inquadrata** (`Lighting.js`): con il sole fisso metà pianeta era
  sempre in ombra. Il ciclo giorno/notte continua a regolare colori e intensità.
- **Nuvole**: grappoli di icosaedri flat-shaded illuminati, fusi in un'unica mesh (1 draw call).
- **Boschi e paesi** (`Terrain.js`): seme fisso (tutti i client vedono lo stesso mondo), alberi
  per bioma (pini in tundra e in quota, niente nel deserto), case raggruppate in ~11 paesi su
  siti la cui intera area è pianura emersa, più qualche fattoria.

## Networking Notes

- Socket.IO client configurato con `transports: ['websocket', 'polling']` (WebSocket prioritario,
  polling HTTP come ripiego). Che Railway "non supporti WebSocket" era scritto qui ma non è mai
  stato verificato: controllare `Transport` nell'overlay H prima di ragionarci sopra.
- Il server predice il movimento tra un input e l'altro: `Game.tick()` muove ogni player con la
  velocità e la virata **dichiarate dal client** (`sp`, `tr` nell'input); `updatePlayerInput`
  corregge e porta la posizione ricevuta avanti della latenza dichiarata (`lat`, max 250 ms).
- Gli eventi `shoot` e `drop-bomb` **devono includere theta/phi/heading** dal client.
- `game-state` (40 Hz) è **volatile** e compatto: niente proiettili, niente nickname/colore/modello
  (arrivano con `joined`/`player-joined` e il client li riattacca), numeri arrotondati a 1e-4.
  Gli edifici viaggiano a parte (`buildings`) e solo quando cambiano.

## Netcode dei proiettili (2026-09-24)

Il "lag quando ci si spara" aveva una causa precisa: ogni proiettile viaggiava nel game-state
40 volte al secondo. Misurato con 2 giocatori: 70 KB/s per client a vuoto, **557 KB/s** con 160
proiettili in volo — su una connessione normale (o in long-polling) i pacchetti si accodavano
proprio durante gli scontri. Ora il game-state pesa ~0.5 KB (~19 KB/s) qualunque cosa succeda.

- **Salve a eventi.** Un proiettile vola su un cerchio massimo a velocità costante: la posizione
  dipende solo da partenza, direzione ed età (`shared/projectile.js`). Il server annuncia ogni
  salva una volta (`shots`: id, owner, theta, phi, headings, velocità, durata, età all'invio) e
  ogni client ne calcola il volo a ogni frame. Id deterministici `${playerId}.${seq}:${i}`.
- **I propri colpi compaiono subito.** Il client crea la salva al click e manda `shoot {seq,…}`;
  l'eco `shots` del server la riconcilia (colpi in più/in meno se il livello arma è cambiato);
  `shot-rejected {seq}` la toglie. Il server accetta la cadenza con un secchiello di gettoni
  (capacità 2), non con un intervallo rigido: il jitter di rete scartava colpi regolari.
- **Colpi decisi da chi spara** (scelta dell'utente). Il client del tiratore testa i propri
  proiettili contro gli aerei remoti *come li disegna*, sul moto relativo nel frame, e manda
  `hit {id, v, a}` con l'età del proiettile all'impatto. Il server (`Game.claimHit`) accetta se il
  proiettile è suo e, **rivedendo lo storico posizioni** del bersaglio (1.2 s, un campione per
  tick) all'istante dell'impatto, la traiettoria passava entro `BULLET_HIT_RADIUS` + tolleranza.
  Proiettili di **bot e torrette**: nessun client li possiede, gli impatti li decide il server
  (`serverHits`, test a segmento). Dopo un impatto parte `projectile-hit` per tutti.
- **Dead reckoning degli aerei remoti** (`Airplane.setNetworkState/tickRemote`): lo stato dice dove
  era l'aereo; il client lo estrapola fino ad *adesso* + latenza stimata (ping ogni 2 s,
  `NetworkManager.rttMs`) con velocità e virata ricevute. Gli scarti fra una stima e la successiva
  si assorbono in ~0.12 s invece di scattare.
- Test: `npm test` (unitari in `server/*.test.js`, end-to-end in `tests/netcode.test.mjs`).
  Per provarlo a mano con due browser servono due profili (i colori sono unici per giocatore).

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
| basi alberi | fino a ±1.7 | −0.059 … −0.037 (voluto −0.05)¹ |
| basi edifici | fino a −2.9 | −0.049 … +0.046 (voluto −0.04) |
| basi torrette | fino a −5.2 | 0.000 … 0.077 |
| draw call terreno | 194 | 24 |
| luci in scena | variabile | 8, costante |

¹ Misura della mesh a `DETAIL = 5`. Con la mesh fitta attuale (2026-09-26): mediana −0.050, p05 −0.113,
minimo −0.249 sui pendii dove `MAX_TREE_TILT` impedisce all'albero di inclinarsi quanto il terreno.
Edifici −0.049 … +0.093, torrette 0.000 … 0.169, luci 8.

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

Gli originali stanno in `tools/models-original/` (fuori da `public/`, altrimenti
finivano nel deploy): lo script riparte sempre da lì, quindi si può ritarare un
rapporto e rilanciare senza degradare due volte.
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

## Risoluzione adattiva e la trappola del bloom (2026-07-27)

### A batteria la GPU dimezza

Misurato con la sonda F9 su Intel Iris Xe (i5-1135G7), stessa scena:

| | a corrente | a batteria |
|---|---|---|
| riferimento | 18.8 ms (53 FPS) | 37.6 ms (27 FPS) |
| bloom | −2.7 ms (14%) | **−17.5 ms (44%)** |
| risoluzione a 1× | −3.0 ms (15%) | **−12.7 ms (32%)** |
| tutto il resto | ≤1.5 ms | ≤3.3 ms (sotto il rumore) |

Acqua, atmosfera, nuvole, nebulosa, stelle e superficie del pianeta non
contano nulla in nessuno dei due casi. Il ciclo giorno/notte non c'entra:
anche misurando con la nebulosa spenta il quadro non cambia.

### `BLOOM_SCALE` non aveva alcun effetto

`UnrealBloomPass.setSize()` **ignora `this.resolution`** e ricava i propri
render target dalla dimensione che gli passa il composer — e sia
`EffectComposer.addPass()` sia `setPixelRatio()` gliela passano piena, moltiplicata
per il DPR. La `resolution` data al costruttore veniva quindi sovrascritta
subito: il bloom girava con mip di 1402 px invece dei 523 previsti, **sette
volte l'area**, ed è per questo che pesava il 44% del frame a batteria.

L'unico modo di ridurlo davvero è intercettare `setSize` sull'istanza, come si
fa ora in `main.js`. Se un giorno si aggiunge un altro pass con una propria
risoluzione, verificare che non caschi nella stessa trappola.

### Scala automatica della risoluzione

`client/utils/adaptiveResolution.js`. Il caricabatterie si stacca a metà
partita, quando un selettore in lobby non serve più: serve una regolazione
continua.

Tocca **solo la risoluzione**, mai elementi visibili. Una modalità automatica
era già esistita ed era stata rimossa: il difetto di quelle regolazioni è il
"pop" di oggetti che appaiono e spariscono mentre giochi, molto più fastidioso
di qualche frame in meno. Un cambio di risoluzione non fa apparire né sparire
nulla.

Tre difese contro le oscillazioni, tutte necessarie:
- **zona morta larga** fra discesa (>21 ms) e risalita (<12.5 ms);
- **periodo di quiete** di 90 frame dopo ogni cambio;
- **blocco per livello**: dopo due discese dallo stesso gradino, quel gradino
  è dichiarato irraggiungibile.

Si misura la **mediana** della finestra, non la media: un picco isolato (una
raccolta della memoria, una compilazione) non deve degradare tutta la partita.

Verificato a secco su quattro scenari, incluso il caso critico di una macchina
esattamente al limite (22 ms a piena risoluzione, che scenderebbe e risalirebbe
per sempre): scende di un gradino solo e si ferma. La macchina veloce non
subisce alcun cambio in 6000 frame.

La risoluzione effettiva è mostrata nell'overlay F9/H: un calo di nitidezza
senza spiegazione visibile sarebbe peggio del calo stesso.

## Qualità grafica high/low

Verificato nel codice il 2026-09-24 (le vecchie note in AGENTS.md descrivevano una modalità
automatica che scalava anche il bloom: non esiste più).

- Selettore manuale in lobby (`client/utils/performanceProfile.js`, `localStorage['littlewar:quality']`),
  default `high`; il cambio ricarica la pagina, così mondo e asset nascono già col profilo scelto.
- `low`: niente bloom, atmosfera, nebulosa, stelle e nuvole, acqua ferma, nessuna PointLight del
  pool, terreno con alberi/case procedurali invece dei GLB e densità ridotta.
- In entrambe: DPR massimo 1.5 desktop / 1.25 touch, bloom a risoluzione ridotta, e la
  **risoluzione adattiva** (`adaptiveResolution.js`) che tocca solo la risoluzione (e i campioni MSAA).
- Dal 2026-09-26 in bassa sono spenti anche GradePass, aurora, fumo dei comignoli, onde di riva, scie
  delle bombe, nastri in quota e lanterne delle barche; barche e stormi dimezzati (dettagli nella
  sezione "Grafica" sotto).

## Altre correzioni (2026-09-24)

- **Click persi**: il rilascio del mouse cancellava lo sparo prima che il frame lo leggesse
  (sotto i 30 fps un click rapido andava perso). Ora il click resta in coda finché non viene
  consumato; i click su bottoni e campi non sparano.
- **HUD "Torrette: 0" sempre**: `main.js` passava `undefined` al posto degli edifici.
- **Nickname come HTML**: la classifica usava `innerHTML` con i nickname degli altri giocatori
  (iniezione di markup). Ora `textContent`, e il server ripulisce il nickname (max 16 caratteri).
- **HUD senza `backdrop-filter`** in partita (pillole, classifica, chat, tasto indietro): sopra il
  canvas WebGL la sfocatura veniva rifatta a ogni frame, con sfondi già opachi all'80%.
- **Camera legata al frame rate**: lo smorzamento era una frazione fissa per frame; ora è
  esponenziale sul tempo reale (a 60 Hz si comporta come prima).
- Rimossi: wireframe di debug (tasto G), `sphereDistance` (rotta e inutilizzata), stadi di qualità
  mai richiamati in Planet/Sky, `getSocketByPlayerId`, `Player.lastInput`, `Target.radius`,
  `getWeaponFireConfig` e il campo `speedMult` delle armi (mai usati). `sphereOrientation` non alloca più.

## Grafica: pipeline, mondo vivo, aerei, obiettivi, interfaccia (2026-09-26)

Sei pacchetti sviluppati in parallelo e integrati insieme. Nessuna luce nuova (il conteggio resta 8),
nessun effetto creato a partita iniziata, nessuna modifica al server. Costi GPU stimati in Chromium
headless (SwiftShader): da confermare con la sonda F9, che ha uno scenario per quasi ogni effetto.
Giro fotografico: `node tests/visual-tour.mjs <cartella>` (servono `npm start` e `npx vite`).

### Regole trasversali

- **Ogni materiale additivo ha `fog: false`.** La nebbia mescola il colore senza toccare l'alfa: sulle
  parti nere di un additivo diventa colore di nebbia sommato alla scena (aloni, righe chiare).
  `excludeAdditiveFromFog(scene)` lo fa una volta a mondo caricato; chi crea additivi dopo lo dichiara.
- **Ogni `ShaderMaterial` che può finire a schermo** chiude il `main()` con
  `#include <tonemapping_fragment>` e `#include <colorspace_fragment>`: nel render target del composer
  compilano vuoti, a schermo (qualità bassa) applicano ACES e sRGB come i materiali standard.
- **Patch con `onBeforeCompile` ⇒ `customProgramCacheKey`.** Senza, materiali dello stesso tipo con
  patch diverse condividono il programma (la chiave sarebbe il sorgente della funzione, identico).
  Se un aggiornamento di three rinomina i chunk il `replace` non trova nulla: l'effetto sparisce in
  silenzio, va riverificato.
- **Pre-compilazione nel render target giusto.** `renderer.compile` sceglie tone mapping e spazio
  colore dal target *corrente*: `warmupShaders()` e `precompileObjectives` usano `sceneRenderTarget()`
  (main.js), cioè `composer.readBuffer` in alta e lo schermo in bassa, ricavato da
  `composer.isLastEnabledPass(0)`. **Non** leggere `renderPass.renderToScreen`: lo imposta solo
  `composer.render()` e prima del primo frame vale sempre false (in bassa nascevano 21 programmi in
  partita, ora 0 in entrambe le qualità). `renderer.compile` (r160) percorre anche gli oggetti invisibili, quindi basta che siano
  in scena.
- **`sky.getNightFactor()` vale 0.2 a mezzogiorno** (0.4 al tramonto, 0.5 all'alba, 1 di notte): gli
  effetti notturni usano soglie come `smoothstep(0.45, 0.9, nf)`, mai `nf > 0`.
- **Effetti "a modalità immediata"** (come `PlaneShadows`): batch istanziati creati all'avvio, riempiti
  a ogni frame e chiusi a fine frame. Nessuno slot da prenotare, nessuna istanza orfana, nessuna draw
  call quando sono vuoti. Un nuovo effetto va aggiunto a un batch esistente, non come mesh propria.
- **Posizioni calcolate nel vertex shader** (uccelli, fumo, linee di velocità) non hanno una bounding
  sphere sensata: `frustumCulled = false`. I quad costruiti nel vertex shader vanno a doppia faccia.
- Per spegnere un effetto (sonda F9, qualità) usare il suo `setEnabled`, non `visible`: gli update
  riscrivono la visibilità in base alla notte.
- **Basi di `pow()` sempre con `max(…, 0.0)`** negli shader: un NaN diventa un quadrato che il bloom
  allarga su tutti i mip.
- **Un aereo creato dopo `preloadAirplaneModels` nasce già col modello vero** (`_modelTemplateReady`
  in Airplane.js): con la sola promessa il GLB arrivava in un microtask dopo il render e per un frame
  si vedeva (e si compilava) il sostituto procedurale. L'aereo locale si crea in `onJoined`, non a
  metà frame in `animate()`, e si ricrea se si rientra con un altro colore.
- **Tornando in lobby** `onDisconnect` chiama `clearSessionEntities()` (bombe, powerup, bersaglio,
  edifici, proiettili): il pianeta in lobby è visibile e senza game-state nessuno le poterebbe.

### Pipeline di rendering (`client/scene/PostFX.js`)

`RenderPass → BloomOnlyPass → GradePass`. **BloomOnlyPass** è un `UnrealBloomPass` che calcola solo la
texture del bloom; **GradePass** è l'unica passata finale: scena + bloom sommati in HDR, bilanciamento
del bianco, ACES con `toneMappingExposure`, saturazione, vignettatura, effetti di gioco, sRGB, curva a
S, dithering (il cielo a 8 bit faceva bande). Deve restare l'**ultimo pass**: niente OutputPass o
ShaderPass dopo. Il trucco su `setSize` del bloom (vedi "La trappola del bloom") resta, con un minimo
di 0.3 della larghezza CSS.

- **Ingresso del bloom ripulito** (`HIGH_PASS_FRAG`, stessa passata del passa-alto stock): NaN/Inf a
  0 e colore scalato perché max(rgb) ≤ 8, conservando la tinta. La sfocatura di UnrealBloomPass è
  quasi una scatola (sigma = raggio): un pixel enorme diventava due quadrati annidati.
- **Soglia del bloom** = luminanza ≥ 0.88 sull'HDR prima del tone mapping. Per far brillare qualcosa
  senza che ACES lo porti al bianco, la luminanza va presa dal rosso, non dal verde: finestre
  (2.6, 0.21, 0.012) escono ambra con alone arancio, il vecchio (1, 0.56, 0.2)×2.5 usciva crema.

- **MSAA** solo su `composer.renderTarget2` (quello della RenderPass; nessun pass scambia i buffer,
  quindi `renderTarget1` non si alloca). 4 campioni se schermo × DPR² ≤ 2.2 Mpx, altrimenti 2; touch
  sempre 2. Serve `EXT_color_buffer_float`; senza, o all'ultimo gradino della risoluzione adattiva,
  il GradePass fa un **FXAA** (ramo su uniform). I gradini adattivi sono `{dpr, msaa}`: prima cede
  metà MSAA, poi la risoluzione. Cambiare i campioni rialloca il target ma non ricompila.
- **Effetti di gioco** (`ScreenEffects`): sfocatura radiale e aberrazione ai bordi in boost,
  desaturazione alla morte, bordo azzurro allo scudo perso. In alta nel GradePass, in bassa tre
  velature CSS di cui cambia solo l'opacità.
- **Qualità bassa**: niente GradePass né bloom, la RenderPass disegna dritta a schermo; MSAA del
  framebuffer (`antialias: true`) solo su touch.

### Cielo, luce, nebbia (`Sky.js`, `Lighting.js`)

- Ciclo di 5 stati (giorno, tramonto, crepuscolo, notte, alba) con `hold` e `blend`; ~2:45 in tutto,
  giorno azzurro ~40%, notte ~23%. Per stato: colori, colore e intensità di sole e ambiente,
  elevazione del sole (`lights.setSunElevation`), esposizione (`renderer.toneMappingExposure`, una
  uniform), grading, alone atmosferico. `sky.setPhase(p)`: parte intera = stato, frazione = posizione;
  0.35, 1.35 e 3.1 (usati dai test) sono stati puri.
- Sole e luna disegnati sul bordo del pianeta (compromesso cartoon: la luce arriva comunque dall'alto).
  Il disco **sorge e tramonta** dietro al bordo invece di sfumare sul posto (sommato al cielo azzurro
  diventava un'ellisse grigia): quota per stato (`discLift`), di giorno sopra l'inquadratura, colore
  con `mix` e solo l'alone additivo. Stelle cadenti in un pool fisso.
- **Ordine delle nuvole**: trasparenti senza profondità come il mare (renderOrder 1). Con la camera
  sopra tutto lo strato (r > FLY_ALTITUDE + 20: lobby, viste dall'alto) passano a renderOrder 6.5,
  altrimenti il mare le copriva; sotto restano a 0. Si decide in `scene.onBeforeRender`, prima che il
  renderer ordini la lista, e va sulla mesh, non sul Group (diventerebbe groupOrder).
- **Nebbia = prospettiva aerea**: colore del cielo sopra il bordo del pianeta, near/far legati alla
  quota della camera, copertura massima 60% (patch di `ShaderChunk.fog_fragment` in `Lighting.js`,
  fatta prima di qualunque compilazione). Cielo e nebbia si orientano in `sky.onBeforeRender`, quindi
  valgono per qualunque camera.

### Mondo vivo nei materiali esistenti (`worldShaders.js`, `NightLights.js`, `CloudShadows.js`)

Effetti dentro i materiali del terreno, niente draw call in più. `patchWorldMaterial(mat, {clouds,
glow, sway, windows})`; interruttori a uniform (`uCloudK`, `uGlowOn`, `uWindAmp`), gratis a zero.

- **Finestre**: `mergeStaticTerrain` scrive `aSeed`, la soglia di accensione per edificio (case una
  alla volta al tramonto). I vetri si riconoscono per nome ('Gesso (2)' casa, 'Gesso (5)' ospedale)
  o per colore; un nuovo edificio usa `root.userData.windowSeed` e `mesh.userData.isWindow = true`.
- **Aloni dei paesi**: 12 slot sul materiale del pianeta da `terrainGroup.userData.towns`.
- **Ombre delle nuvole**: ellissi morbide per vertice sotto le 8 nuvole più vicine
  (`cloudRoot.userData.cloudAnchors`); tolgono solo la luce diretta. Le nuvole usano `Math.random`,
  quindi differiscono fra client (solo estetica). In bassa non ci sono.
- **Mare**: onde di riva (solo alta, `#define SHORE_WAVES`), tone mapping nello shader, e un riflesso
  del sole **per faccia intera** (normale di faccia e posizione in un varying `flat`, in WebGL2): ogni
  triangolo si accende intero o resta spento. Scartati la sola normale di faccia (esagoni pieni) e il
  lobo largo sulla normale liscia (macchia bianca sfocata). `seaIceAt()` esporta la formula della
  banchisa per chi deve evitarla.
- **Vento** sugli alberi: `aSway`, solo vertex shader; le mesh fuse hanno matrice identità.
- **Qualità bassa**: tutti i decori procedurali in un `MeshLambertMaterial` a colori per vertice,
  terreno da 90 draw call a 1, stesse chiamate a `rand()` (mondo identico).
- **`cheapMaterial()`**: GLTFLoader promuove a `MeshPhysicalMaterial` ogni materiale con estensioni
  ior/specular/clearcoat anche a zero; quelli senza nulla di fisico diventano Lambert. Restano fisici i
  **metallici** (glTF mette `metallicFactor` 1 se manca): senza env map un metallo esce nero, e le
  pareti dell'ospedale lo sono — va corretto nel GLB.

### Vita del mondo (`client/scene/life/`)

`WorldLife` crea tutto prima di `warmupShaders`: barche e aurora nel costruttore, stormi, fari,
sentieri e fumo in `onWorldReady` (servono paesi ed edifici del terreno). Nessuna luce vera. Uniform
di luce e tempo in un solo oggetto (`lifeShared.lifeUniforms`). CPU ~20 µs per frame.

- **Barche**: 12 (6 in bassa) su giri Catmull-Rom attorno a centri in acqua profonda, scartati se un
  punto ha meno di 0.55 d'acqua misurata con `sampleGround` o tocca la banchisa (`seaIceAt`). Quattro InstancedMesh con lo stesso
  `instanceMatrix`. Tempo locale: non sincronizzate fra client.
- **Uccelli**: una draw call, tutto nel vertex shader; stessa velocità angolare per stormo. La quota
  dell'orbita tiene conto di tetti e chiome (`terrainGroup.userData.buildings` con `height`,
  `userData.trees`); un sito sopra `MAX_ALTITUDE` (54, sotto gli aerei) si scarta invece di schiacciarlo.
- **Fumo** dai comignoli (solo alta): usa `quaternion` e `scale` di `terrainGroup.userData.buildings`.
- **Fari** su capi bassi col mare su ≥5 lati su 12; fasci additivi ruotati nel vertex shader.
- **Aurora**: due sipari ai poli, solo alta, `smoothstep(0.8, 1.0, nf)`. È uno spettacolo polare: il
  vertex shader la attenua con la distanza angolare della camera dall'anello (spenta sotto ~44° di
  latitudine) e col raggio della camera (niente in lobby), il fragment la spegne entro poche unità
  dalla camera (quella di gioco sta a ~62–72, dentro il sipario).
- **Sentieri** fra paesi (Kruskal sotto 0.8 rad, solo se praticabili), campionati sulla superficie
  renderizzata ogni 0.35 unità, con lampioni fusi che si accendono uno alla volta.

### Aerei (`airplaneLook.js`, `TrailRibbons.js`, `AircraftFx.js`, `Wreckage.js`, `SpeedLines.js`, `glowSprite.js`)

- **Scie alari**: tutte in una mesh (`wingTrails`); durata in **secondi** (0.5 s), mai in frame — la
  vecchia Line da 32 punti a 4 fps durava otto secondi. Si spezzano da sole se la punta salta troppo;
  chi sa del salto chiama `Airplane.resetFx()`. `wingTrails.build()` va chiamato dopo camera e aerei.
- **Aspetto**: ogni aereo clona i suoi materiali e aggancia un `onBeforeCompile` (bordo luminoso nel
  colore del giocatore che pulsa durante l'invulnerabilità, riflesso finto di cielo e terra, luce
  propria di notte). **Niente envMap**: su un pianeta il "su" cambia da punto a punto.
- **Elica**: le pale (~11.7k vertici) sostituite da un disco sfocato sul nodo `Cube004_1`; se sparisce
  si torna alla clip `helice`.
- **Scudo**: gabbia a icosaedro condivisa; all'evento `shield-broken` fa schegge e resta nascosto
  600 ms contro i game-state vecchi.
- **Puntini a dimensione minima** (`GlowSpriteBatch`): `max(dimensione mondo, N px)`, per luci di
  navigazione e alone dei proiettili. Colore in `instanceColor`: serve `setColorAt(0, …)`.
- **Effetti in pool**: vampate di sparo (sull'aereo locale i due slot del LightPool fanno da lampo),
  anelli di respawn, schegge, rottami (si posano su `groundRadius` o affondano), linee di velocità.
- `createAirplaneWarmupMesh()`: un aereo invisibile in scena dal "mondo pronto".
- **Camera**: stato smorzato in `_pos`/`_quat`, FOV e scossone sopra. Scossoni a trauma (`addTrauma`,
  ampiezza trauma², solo rotazione); esplosioni di bombe e torrette li danno in base alla distanza
  (`shakeForExplosionAt`). FOV +6° in boost, +13° in extreme. `prefers-reduced-motion`: scossoni ×0.3
  e FOV fisso; col giroscopio ×0.5. `snap()` al respawn e a ogni ingresso (la vecchia soglia di 150
  non scattava mai e la camera attraversava il pianeta). Da morti orbita sull'esplosione e si gira
  verso chi ha sparato.
- **Quasi colpi** (proiettili altrui entro 3.5 u): lampo rosso sul lato giusto dello schermo
  (`NearMissFlash.js`), scossone, fischio.

### Obiettivi (`ObjectiveFx.js`, `Building.js`, `Target.js`, `Bomb.js`, `PowerUp.js`)

- `ObjectiveFx`: quattro InstancedMesh a modalità immediata (aloni, segmenti rivolti alla camera,
  segni a terra, coriandoli), blending **premoltiplicato** (α=0 additivo di notte, α=copertura
  leggibile a mezzogiorno). `endObjectiveFx()` dopo powerup ed edifici. `precompileObjectives()`
  compila i prototipi in lobby.
- **Torretta e avamposto fusi per materiale** (`mergeByMaterial.js`, porta i GLB quantizzati in
  Float32): torretta da 236 draw call a 9, il `Turret_Pivot` conserva la trasformazione. Per istanza
  si clonano solo `Gesso (5)` e `Gesso (7)`. Avamposto: `OUTPOST_FLAT_STYLE` (Lambert flat al posto
  delle texture fotografiche) e asta allungata `POLE_EXTEND = 1.6`; entrambe reversibili.
  Dopo una riesportazione ricontrollare i nomi: `Turret_Pivot`, `Gesso (5)`, `Gesso (7)` in
  torretta_cesare; `Gesso (5)` (bandiera) e `Gesso (4)` (asta) in pre_torretta.
- **Zona di conquista**: raggio vero `acos((R²+A²−C²)/2RA)` = 0.179 rad, la stessa geometria di
  `Building.distanceTo` sul server (se cambia lì, va cambiata qui). L'anello è la barra di progresso;
  lo stato "conteso" lo calcola il client (il server azzera il progresso ma non lo dice).
- **Bersaglio**: mesh create all'avvio (`initTargetFx`), trasparente con `renderOrder` 1.2 (dopo il
  mare, che prima lo copriva sulla costa). Il fumo di segnalazione ha luce propria (resta arancio di
  notte) e sbuffi a opacità per istanza ordinati dal più lontano, in due draw call: colore trasparente
  senza profondità e un passo solo-profondità dove alfa ≥ 0.5 — schema riusabile per altri effetti
  trasparenti densi. **Bombe**: due InstancedMesh, caduta simulata dal client e
  riallineata oltre 0.4 u, mirino di sgancio di raggio `BOMB_HIT_RADIUS`.
- **Torrette**: laser di puntamento che si carica dall'ultimo colpo; beacon visibile anche di giorno
  e in bassa. **Powerup**: colonna di luce e alone; lampeggio finale solo per quelli nati dopo
  l'ingresso (il server non manda l'età).

### Interfaccia (`LobbyAttract.js`, `HUD.js`, `client/systems/hud/`)

- **Lobby dal vivo**: pianeta vero in orbita e uno Spitfire dimostrativo nel colore scelto
  (`isLocal = false`, niente LightPool), a 30 fps (24 in bassa) e DPR ≤ 1, niente finché il mondo non
  è pronto. Pianeta spostato con `camera.setViewOffset`, **da togliere sempre all'ingresso in
  partita** (mirino e indicatori risulterebbero spostati). Il `return` di `lobbyAttract.frame()` salta
  il resto del frame: ciò che deve girare sempre va messo prima. All'ingresso la camera plana 1.3 s
  fino dietro all'aereo su un arco che non attraversa il pianeta.
- **Mirino** dove passeranno i proiettili fra 0.2 rad, rosso se un nemico disegnato è sul percorso;
  hit marker, serie DOPPIO!/TRIPLO!. **Indicatori** sugli aerei nemici con test di occlusione del
  pianeta e frecce "dove virare" su un'ellisse che evita i pannelli; pool fisso per id. Chi ci ha
  abbattuto ha l'etichetta "TI HA ABBATTUTO" (riconosciuto dal nickname del kill feed).
- **Radar** orientato sulla rotta, 15 Hz (10 in bassa). **Notifiche** in una sola pila
  (`hud.notify(kind, text, { icon, ms })`), kill feed separato dalla chat.
- Regole: DOM scritto solo quando un valore cambia, posizioni con `transform`, niente
  `backdrop-filter`, nickname sempre via `textContent`. Proiezioni dopo `camera.updateMatrixWorld()`.
- **Telefono in orizzontale**: kill feed a 2 righe sotto i 420 px d'altezza, 1 sotto i 380 (sotto
  ~330 tocca ancora i bottoni); i toast si nascondono mentre la classifica aperta dalla pillola è su
  (`is-under-board`: `#hud-toasts` sta fuori da `#hud` per coprire la schermata di morte); ellisse
  delle frecce con margini 200/100, senza safe-area. Da morti la freccia del killer usa la camera
  che orbita, non la rotta congelata. Lobby a colonna singola solo se
  `(W ≤ 900 && H > W) || (W ≤ 640 && H > 560)`, uguale in CSS e in `LobbyAttract`.
- Il campo nickname ferma la propagazione dei tasti come la chat (H e R non scattano mentre si
  scrive); tornando in lobby si riseleziona il colore con cui si volava (`LobbyScreen.reclaimColor`).
- **Font** serviti in locale (`public/fonts`, OFL: Fredoka e Be Vietnam Pro), come il decoder Draco.
  **Icone** in uno sprite SVG (`<use href="#i-…">`) al posto delle emoji.

## Bug Log

### Powerup non raccoglibili in multiplayer (intermittente)

**Sintomo:** In multiplayer il giocatore vede il powerup, ci passa attraverso, nessun suono né arma data. In solo non accade.

**Causa radice (tre failure mode sovrapposti):**
1. **Divergenza posizione con HTTP polling (causa principale):** Su Railway, Socket.IO ricade su HTTP polling (~1 req/s). Il server predice il movimento dell'aereo in base all'ultimo heading ricevuto, ma se il client ha girato nel frattempo la posizione predetta diverge di ~11 unità (base speed × 1s). Il check tick-based usa la posizione sbagliata e non rileva la collisione.
2. **Miss geometrico dell'arc-check:** `_checkPowerupCollectionAlongPath` fa uno sweep sull'arco tra la posizione precedente e quella nuova del client. Se il giocatore ha curvato per avvicinarsi al powerup e poi ha curvato di nuovo (approach da lato), il powerup non cade sull'arco di cerchio massimo tra A e B → miss.
3. **Competizione con altri giocatori + ritardo evento:** Un altro giocatore raccoglie il powerup; l'evento `powerup-collected` arriva con ritardo polling → il powerup rimane visibile per ~1s e poi sparisce senza suono né effetto.

**Stato verificato nel codice il 2026-09-24:** il client manda `try-collect` quando è entro
`POWERUP_COLLECT_RADIUS` e ripete ogni 300 ms finché il powerup esiste; il server raccoglie con
`tryCollectPowerup` e con lo sweep sul percorso dichiarato dal client
(`_checkPowerupCollectionAlongPath`). La raccolta su posizione *predetta* dal server
(`_checkPowerupCollection` nel tick) è stata tolta ora: le note sotto dicevano che era già stata
rimossa, ma era ancora lì. Il "feedback ottimistico" descritto nel tentativo v2 non risulta
implementato. Le note storiche restano sotto per contesto.

**Soluzione applicata (2026-04-14):** Rilevamento lato client + evento `try-collect`.
- `client/main.js`: ogni frame, quando vivo, controlla distanza sferica tra posizione locale e tutti i powerup noti. Se entro `POWERUP_COLLECT_RADIUS`, invia `try-collect { powerupId }` al server (una sola volta per ID tramite `triedPowerups` Set).
- `server/Game.js`: `tryCollectPowerup()` — se il powerup esiste ancora, lo raccoglie (no check di distanza: inutile con polling lag, gioco casual con amici).
- Server-side collection esistente rimane come backup per chi usa WebSocket.

**Tentativo 2026-04-16 (retry idempotente, NON HA FUNZIONATO):** Sostituito `triedPowerups Set` con `powerupLastTryAt Map`, retry ogni 300ms finché in range. Il bug è continuato a presentarsi anche **in locale** (escludendo packet loss/polling) e in particolare con due powerup sovrapposti uno solo veniva raccolto. Quindi il problema non era network né "una sola richiesta" — era altro, presumibilmente race server-side.

**Tentativo 2026-04-16 v2 (client autoritativo + feedback ottimistico):** Riprogettato il flusso di raccolta:
- **Server**: rimosse `_checkPowerupCollection` e `_checkPowerupCollectionAlongPath`. Erano due strade indipendenti che usavano posizione **predetta dal server** (divergente dalla realtà del client) per raccogliere i powerup. Generavano race con `try-collect`: a volte il check su posizione predetta cancellava un powerup mentre il client stava ancora avvicinandosi alla posizione vera → l'evento `powerup-collected` arrivava al client senza che lui avesse percepito la collisione, e i powerup vicini sovrapposti potevano essere "rubati" male. Rimanga unicamente `tryCollectPowerup` (idempotente). Aggiunto warning console se `try-collect` viene rifiutato per player non vivo.
- **Client**: aggiunto **feedback ottimistico immediato**. Appena il client locale rileva collisione con un powerup, nasconde subito l'entità dalla scena e suona l'effetto. Poi invia `try-collect` con retry ogni `POWERUP_RETRY_MS = 200ms` per max `POWERUP_RETRY_MAX_MS = 5000ms`. L'effetto di gameplay (weaponLevel/hasShield) resta autoritativo dal server via `game-state`. Se per caso il server non confermasse, il prossimo `game-state` ri-aggiunge automaticamente l'entità (rollback visivo), ma il giocatore ha sempre feedback immediato. Il client è ora unica fonte di verità per il rilevamento collisione (l'unico che conosce posizione esatta in real time).

**Se il problema persiste:** controllare i log server per `[powerup] try-collect rifiutato`. Se compare frequentemente con "non vivo", c'è un mismatch dello stato `alive` tra client e server. Se non compare mai e i powerup non si applicano lato gameplay, il problema è in `collectPowerup` (es. branch ramificato che non incrementa). Se la sparizione visiva ottimistica funziona ma l'upgrade non arriva, attivare un log temporaneo in `collectPowerup` con player/weaponLevel risultante.
