import { defineConfig } from 'vite';

// Porta del server di gioco per il proxy di sviluppo. Configurabile per far
// girare più copie del gioco in parallelo (es. verifiche visive in worktree
// separate): LW_SERVER_PORT=3101 npx vite --port 5201
const SERVER = `http://localhost:${process.env.LW_SERVER_PORT || 3000}`;

export default defineConfig({
  root: 'client',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    host: true,
    proxy: {
      '/socket.io': {
        target: SERVER,
        ws: true,
      },
      '/api': {
        target: SERVER,
      },
    },
  },
});
