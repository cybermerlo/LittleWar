# Design: Proiettili Skill-Based (Approccio A)

**Data:** 2026-04-12  
**Stato:** Approvato

## Obiettivo

Rendere i proiettili piu' leggibili e piu' tecnici da usare, aumentando il peso di mira e predizione senza introdurre complessita' non necessaria.

## Direzione gameplay

- Colpo piu' veloce ma con finestra utile piu' breve.
- Hitbox leggermente piu' piccola per premiare precisione.
- Nessuna modifica al protocollo rete o al flusso eventi esistente.

## Direzione grafica

- Proiettile non piu' sferico ma allungato.
- Orientamento lungo la traiettoria per leggere direzione.
- Mini-trail corto e poco luminoso per feedback tecnico.

## Modifiche previste

### Costanti (`shared/constants.js`)
- `BULLET_SPEED`: `0.8 -> 0.95`
- `BULLET_HIT_RADIUS`: `1.2 -> 0.9`
- `BULLET_LIFETIME`: `2000 -> 1600`

### Projectile client (`client/entities/Projectile.js`)
- Geometria allungata (`CapsuleGeometry`) e materiale piu' leggibile.
- Calcolo direzione dal delta posizione per orientare la mesh.
- Trail lineare breve tra posizione precedente e corrente.

### Server
- Nessuna variazione strutturale: usa automaticamente le nuove costanti.

## Validazione

- Build di produzione (`npm run build`).
- Controllo leggibilita' visiva in volo.
- Verifica feeling: colpi piu' tecnici e meno permissivi.
