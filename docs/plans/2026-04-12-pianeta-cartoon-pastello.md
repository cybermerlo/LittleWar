# Pianeta Cartoon Pastello Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migliorare la resa del pianeta in stile cartoon/pastello con luci stylized e bloom morbido, mantenendo fluidita' e leggibilita' gameplay.

**Architecture:** L'intervento resta confinato al layer rendering client. Si aggiornano materiali e palette del pianeta/acqua, setup luci e sky/fog, poi si introduce un post-processing minimale basato su composer con bloom leggero. La logica di gioco e networking non viene toccata.

**Tech Stack:** Three.js (`MeshToonMaterial`/`MeshPhongMaterial`, luci), Vite, post-processing (`EffectComposer`, `RenderPass`, `UnrealBloomPass`).

---

### Task 1: Migliorare materiale e palette pianeta

**Files:**
- Modify: `client/scene/Planet.js`

**Step 1: Definire aspettativa visiva**
- Rendere piu' morbida la gradazione dei biomi e applicare shading toon.

**Step 2: Implementare minimo necessario**
- Aggiornare palette colori altimetrici.
- Passare da `MeshLambertMaterial` a materiale stylized cartoon.
- Rifinire materiale acqua per highlight pastello.

**Step 3: Verifica locale rapida**
- Run: `npm run build`
- Expected: build OK senza errori.

### Task 2: Lighting stylized (key/fill/rim)

**Files:**
- Modify: `client/scene/Lighting.js`

**Step 1: Definire target**
- Setup piu' leggibile e caldo/freddo, coerente con stile cartoon.

**Step 2: Implementazione minima**
- Aggiungere rim light.
- Ritoccare colori/intensita' di ambient, sole e fill.
- Introdurre lieve fog atmosferica di scena.

**Step 3: Verifica locale rapida**
- Run: `npm run build`
- Expected: build OK senza regressioni.

### Task 3: Post-processing soft glow

**Files:**
- Modify: `client/main.js`

**Step 1: Definire comportamento**
- Render finale tramite composer con bloom discreto.

**Step 2: Implementazione minima**
- Aggiungere `EffectComposer`, `RenderPass`, `UnrealBloomPass`.
- Gestire resize di renderer/camera/composer.
- Usare fallback bloom leggero su device ad alto pixel ratio.

**Step 3: Verifica locale rapida**
- Run: `npm run build`
- Expected: build OK, bundle generato.

### Task 4: Rifinitura sky e validazione finale

**Files:**
- Modify: `client/scene/Sky.js` (solo se necessario)
- Validate: `client/main.js`, `client/scene/Planet.js`, `client/scene/Lighting.js`

**Step 1: Rifinitura minima**
- Ritoccare gradiente cielo per coerenza con nuove luci/fog.

**Step 2: Verifica finale**
- Run: `npm run build`
- Expected: build PASS.

**Step 3: Smoke test manuale**
- Avviare `npm start` e `npm run dev`.
- Verificare: pianeta leggibile, glow non invasivo, HUD e gameplay chiari.
