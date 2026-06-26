// ============================================================================
//  Server entry �?Express static host + Socket.IO realtime gateway.
//  One process, one shared GameRoom; every browser that opens the URL joins
//  the same live tower.
// ============================================================================
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { GameRoom } from './game/GameRoom.js';
import { Leaderboard } from './game/Leaderboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const PORT = process.env.PORT || process.argv[2] || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000,
});

const leaderboard = await new Leaderboard().load();
const room = new GameRoom(io, leaderboard);
room.start();

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  // dev: never cache JS/CSS so code changes show after a refresh
  setHeaders(res, filePath) {
    if (/\.(js|css|mjs)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  },
}));
app.get('/health', (_req, res) => {
  res.json({ ok: true, players: room.players.size, round: room.round, phase: room.phase });
});

// menu data (shown before joining): live round + historical leaderboard
app.get('/api/state', (_req, res) => {
  res.json({ round: room.round, players: room.players.size, phase: room.phase });
});
app.get('/api/leaderboard', (_req, res) => {
  res.json({ top: leaderboard.top(20) });
});

io.on('connection', (socket) => {
  socket.on('join', (data, ack) => {
    try {
      const name = (data && data.name) || '';
      const look = (data && data.look) || {};
      const player = room.addPlayer(socket.id, name, look);
      const init = room.initStateFor(socket.id);
      if (typeof ack === 'function') ack(init);
      else socket.emit('init', init);
      io.emit('system', { msg: `${player.name} 加入了攀登`, kind: 'join' });
    } catch (err) {
      console.error('[join] error:', err);
    }
  });

  socket.on('input', (msg) => room.setInput(socket.id, msg));

  // chat message: server thottles + trims, then broadcasts to everyone so a
  // speech bubble appears over the sender and the line shows in the chat log.
  socket.on('chat', (text) => {
    const p = room.players.get(socket.id);
    if (!p || typeof text !== 'string') return;
    const clean = String(text).trim().slice(0, 80);
    if (!clean) return;
    if (room.setChat(socket.id, clean)) {
      io.emit('chat', { id: p.id, name: p.name, text: clean });
    }
  });

  // round-trip clock sync probe
  socket.on('timesync', (t0, ack) => {
    if (typeof ack === 'function') ack({ t0, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    const p = room.players.get(socket.id);
    room.removePlayer(socket.id);
    if (p) io.emit('system', { msg: `${p.name} 离开了`, kind: 'leave' });
  });
});

server.listen(PORT, '::', () => {
  console.log(`\n  🧗 敲冰块大逃杀 / Ice-Climber Arena`);
  console.log(`  �? http://localhost:${PORT}\n`);
});
