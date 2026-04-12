# Indicatori Player Vicini Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Mostrare in HUD la direzione/posizione dei 3 giocatori avversari piu' vicini, oltre al target bomba esistente.

**Architecture:** Si estende il sistema HUD con un container dedicato a marker dinamici per i player vicini. Ogni frame, il client seleziona i 3 avversari vivi piu' vicini e ne proietta la posizione sullo schermo, con comportamento on-screen/off-screen analogo al target arrow.

**Tech Stack:** Three.js (`Vector3.project`), DOM HUD, CSS lightweight.

---

### Task 1: Estendere HUD markup e stile

**Files:**
- Modify: `client/index.html`

**Step 1: Aggiungere contenitore marker player**
- Inserire `#player-arrows` nel blocco HUD.

**Step 2: Aggiungere stile base marker**
- Definire classe marker con colore dinamico e layout minimale.

**Step 3: Verifica**
- Run: `npm run build`
- Expected: build OK.

### Task 2: Logica HUD per 3 player piu' vicini

**Files:**
- Modify: `client/systems/HUD.js`

**Step 1: Preparare riferimenti DOM**
- Leggere `#player-arrows`.

**Step 2: Selezione player**
- Filtrare avversari vivi, ordinare per distanza dal local player e prendere top 3.

**Step 3: Rendering marker**
- On-screen: marker circolare vicino alla posizione proiettata.
- Off-screen: freccia al bordo orientata verso il player.

**Step 4: Cleanup dinamico**
- Ricreare/aggiornare marker ogni frame, rimuovendo quelli non necessari.

### Task 3: Validazione finale

**Files:**
- Validate: `client/index.html`, `client/systems/HUD.js`

**Step 1: Build e lint**
- Run: `npm run build`
- Run: lint/diagnostica IDE sui file toccati.
- Expected: tutto green.
