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

- **Frontend**: Three.js (vanilla JS or minimal bundler)
- **Backend / Multiplayer**: TBD — likely Node.js + WebSockets (e.g. Socket.io)
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

## Development Notes

- Keep the game lightweight — it runs in the browser for casual sessions with friends
- Prefer simple, readable code over premature optimization
- Game logic decisions are still being finalized — wait for explicit instructions before implementing features
