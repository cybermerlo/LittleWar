import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Game } from './Game.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// Serve il build di produzione
app.use(express.static(join(__dirname, '../dist')));
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../dist/index.html'));
});

const game = new Game(io);

io.on('connection', (socket) => {
  console.log(`[+] Socket connesso: ${socket.id}`);

  socket.on('join', ({ nickname, color }) => {
    game.addPlayer(socket, nickname, color);
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

  socket.on('disconnect', () => {
    console.log(`[-] Socket disconnesso: ${socket.id}`);
    game.removePlayer(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`LittleWar server in ascolto su porta ${PORT}`);
});
