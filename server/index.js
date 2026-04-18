import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, statSync } from 'fs';
import { Game } from './Game.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// Scansiona public/music/ e ritorna le stazioni con i loro file
app.get('/api/music-stations', (req, res) => {
  const musicDir = join(__dirname, '../public/music');
  try {
    const stations = readdirSync(musicDir)
      .filter((name) => statSync(join(musicDir, name)).isDirectory())
      .map((name) => {
        const files = readdirSync(join(musicDir, name))
          .filter((f) => /\.(mp3|ogg|wav)$/i.test(f))
          .map((f) => `/music/${name}/${f}`);
        return { name, paths: files };
      });
    res.json(stations);
  } catch {
    res.json([]);
  }
});

// Serve il build di produzione
app.use(express.static(join(__dirname, '../dist')));
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../dist/index.html'));
});

const game = new Game(io);

io.on('connection', (socket) => {
  console.log(`[+] Socket connesso: ${socket.id}`);

  // Invia subito i colori occupati al nuovo client (per aggiornare la lobby)
  game.broadcastLobbyInfo(socket);

  socket.on('join', ({ nickname, color, model }) => {
    game.addPlayer(socket, nickname, color, model);
  });

  socket.on('player-input', (input) => {
    game.updatePlayerInput(socket.id, input);
  });

  socket.on('shoot', (data) => {
    game.playerShoot(socket.id, data);
  });

  socket.on('drop-bomb', (data) => {
    game.playerDropBomb(socket.id, data);
  });

  socket.on('chat', ({ text }) => {
    game.broadcastChat(socket.id, text);
  });

  socket.on('try-collect', ({ powerupId }) => {
    game.tryCollectPowerup(socket.id, powerupId);
  });

  socket.on('disconnect', () => {
    console.log(`[-] Socket disconnesso: ${socket.id}`);
    game.removePlayer(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`LittleWar server in ascolto su porta ${PORT}`);
});
