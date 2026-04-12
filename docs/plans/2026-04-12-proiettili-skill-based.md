# Proiettili Skill-Based Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migliorare i proiettili per uno stile tecnico/skill-based con resa grafica piu' leggibile e tuning dinamico piu' preciso.

**Architecture:** Le modifiche restano nel dominio projectile e nelle costanti condivise. Il server continua a simulare traiettoria e collisione usando i nuovi parametri globali, mentre il client aggiorna la resa visiva (mesh orientata + mini-trail) senza alterare il protocollo rete.

**Tech Stack:** Three.js (Mesh/Line/CapsuleGeometry), Node.js server tick loop, costanti condivise JS.

---

### Task 1: Tuning dinamica projectile

**Files:**
- Modify: `shared/constants.js`

**Step 1: Definire i valori target**
- Speed up lieve, hit radius ridotta, lifetime ridotta.

**Step 2: Applicare il tuning minimo**
- Aggiornare `BULLET_SPEED`, `BULLET_HIT_RADIUS`, `BULLET_LIFETIME`.

**Step 3: Verifica**
- Run: `npm run build`
- Expected: build OK.

### Task 2: Visual upgrade projectile client

**Files:**
- Modify: `client/entities/Projectile.js`

**Step 1: Definire resa**
- Mesh allungata orientata alla direzione.
- Trail corto non invasivo.

**Step 2: Implementare minimo necessario**
- Sostituire geometria sferica con geometria allungata.
- Aggiungere orientamento dinamico con delta posizione.
- Aggiungere trail lineare aggiornato a ogni tick rete.

**Step 3: Verifica**
- Run: `npm run build`
- Expected: build OK, nessun errore runtime atteso.

### Task 3: Validazione finale

**Files:**
- Validate: `shared/constants.js`, `client/entities/Projectile.js`

**Step 1: Build finale**
- Run: `npm run build`
- Expected: PASS.

**Step 2: Controllo qualità**
- Confermare leggibilita' dei colpi e coerenza skill-based.
