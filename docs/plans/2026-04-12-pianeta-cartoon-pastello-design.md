# Design: Pianeta Cartoon Pastello

**Data:** 2026-04-12  
**Stato:** Approvato

## Obiettivo

Rendere il pianeta piu' "coccolo e bello" mantenendo uno stile cartoon/pastello, senza impatti negativi sul gameplay multiplayer.

## Direzione estetica

- Palette morbida e luminosa per biomi del pianeta.
- Acqua piu' "creamy" con riflessi delicati.
- Cielo pastello con atmosfera piu' leggibile all'orizzonte.
- Illuminazione key/fill/rim colorata e morbida.
- Post-processing leggero con glow soft non invasivo.

## Modifiche principali

### Pianeta (`client/scene/Planet.js`)

- Conservare la geometria low-poly esistente con noise.
- Migliorare la resa del materiale con uno shading piu' stylized.
- Ritoccare la palette altimetrica per transizioni meno dure.

### Acqua (`client/scene/Planet.js`)

- Mantenere mesh separata.
- Aggiornare materiale per highlight morbidi e trasparenza controllata.

### Luci (`client/scene/Lighting.js`)

- Setup key/fill/rim in toni caldi/freddi leggeri.
- Bilanciamento intensita' per non "bruciare" i colori pastello.

### Cielo (`client/scene/Sky.js`)

- Estendere gradiente pastello.
- Aggiungere supporto a una nebbia leggera per profondita' atmosferica.

### Post-processing (`client/main.js`)

- Introdurre `EffectComposer` con:
  - `RenderPass`
  - `UnrealBloomPass` con parametri conservativi
- Gestione resize completa (camera, renderer, composer).

## Vincoli e performance

- Niente effetti pesanti (SSAO, DOF).
- Bloom con risoluzione ridotta sui device con pixel ratio alto.
- Nessuna modifica alla logica di rete o al loop di sincronizzazione.

## Validazione

- Controllo leggibilita' gameplay (aerei, proiettili, HUD).
- Verifica assenza di flicker e glow eccessivo.
- Test resize in finestra desktop.
- Build produzione con `npm run build`.
