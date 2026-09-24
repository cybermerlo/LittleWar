/**
 * Prova end-to-end del netcode dei proiettili: avvia il server vero su una
 * porta libera, collega due client Socket.IO e verifica che
 *  - una salva venga annunciata una sola volta (evento `shots`) a tutti;
 *  - il game-state non contenga più i proiettili e resti piccolo;
 *  - il colpo rivendicato da chi spara uccida il bersaglio;
 *  - uno sparo duplicato venga respinto al solo tiratore.
 *
 *   node --test tests/netcode.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import { moveOnSphere } from '../shared/movement.js';
import { BULLET_SPEED } from '../shared/constants.js';

const PORT = 4100 + Math.floor(Math.random() * 800);
const URL = `http://localhost:${PORT}`;

function startServer() {
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server non partito')), 10000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('in ascolto')) { clearTimeout(timer); resolve(proc); }
    });
    proc.on('exit', (code) => reject(new Error(`server uscito (${code})`)));
  });
}

function connect() {
  return io(URL, { transports: ['websocket'], forceNew: true });
}

function waitFor(socket, event, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, h); reject(new Error(`timeout su ${event}`)); }, ms);
    const h = (d) => { if (pred(d)) { clearTimeout(timer); socket.off(event, h); resolve(d); } };
    socket.on(event, h);
  });
}

test('salve a eventi, colpi decisi da chi spara, game-state compatto', async (t) => {
  const server = await startServer();
  const a = connect();
  const b = connect();
  t.after(() => { a.close(); b.close(); server.kill(); });
  await Promise.all([once(a, 'connect'), once(b, 'connect')]);

  const joinedA = waitFor(a, 'joined');
  a.emit('join', { nickname: 'Alfa', color: '#ff0000', model: 'spitfire' });
  const ja = await joinedA;
  const joinedB = waitFor(b, 'joined');
  b.emit('join', { nickname: 'Bravo', color: '#0000ff', model: 'spitfire' });
  const jb = await joinedB;

  const idA = ja.playerId;
  const idB = jb.playerId;
  const meA = ja.players.find((p) => p.id === idA);
  assert.equal(meA.nickname, 'Alfa', 'joined porta i dati statici');

  // A fermo, muso a heading 0; B fermo 0.1 rad davanti (≈ 5.6 unità).
  const th = 1.3, ph = 0.7;
  const front = moveOnSphere(th, ph, 0, 0.1);
  const hold = setInterval(() => {
    a.emit('player-input', { theta: th, phi: ph, heading: 0, sp: 0, tr: 0, lat: 0 });
    b.emit('player-input', { theta: front.theta, phi: front.phi, heading: 0, sp: 0, tr: 0, lat: 0 });
  }, 25);
  t.after(() => clearInterval(hold));

  // Il game-state non trasporta più proiettili né dati statici.
  const gs = await waitFor(b, 'game-state', (s) => s.players.length === 2);
  assert.equal(gs.projectiles, undefined);
  assert.equal(gs.players[0].nickname, undefined);
  const bytes = Buffer.byteLength(JSON.stringify(gs));
  console.log(`    game-state con 2 giocatori: ${bytes} byte`);
  assert.ok(bytes < 900, `game-state troppo grande: ${bytes} byte`);

  await new Promise((r) => setTimeout(r, 150)); // lascia assestare le posizioni

  // Sparo: annunciato una volta a entrambi, con id deterministico.
  const shotsOnB = waitFor(b, 'shots', (s) => s.o === idA);
  const shotsOnA = waitFor(a, 'shots', (s) => s.o === idA);
  a.emit('shoot', { seq: 0, theta: th, phi: ph, heading: 0 });
  const [sb] = await Promise.all([shotsOnB, shotsOnA]);
  assert.equal(sb.id, `${idA}.0`);
  assert.equal(sb.hd.length, 1);

  // Sparo duplicato → respinto al solo tiratore.
  const rejected = waitFor(a, 'shot-rejected', (d) => d.seq === 0);
  a.emit('shoot', { seq: 0, theta: th, phi: ph, heading: 0 });
  await rejected;

  // Il proiettile raggiunge B in ~105 ms: A lo vede colpire e lo rivendica.
  await new Promise((r) => setTimeout(r, (0.1 / BULLET_SPEED) * 1000));
  const killed = waitFor(b, 'player-killed', (d) => d.victimId === idB);
  const hitEvt = waitFor(b, 'projectile-hit', (d) => d.id === `${idA}.0:0`);
  a.emit('hit', { id: `${idA}.0:0`, v: idB });
  const [k] = await Promise.all([killed, hitEvt]);
  assert.equal(k.killerId, idA);
});
