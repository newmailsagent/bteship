/**
 * МОРСКОЙ БОЙ — server.js (ИСПРАВЛЕННАЯ ВЕРСИЯ)
 */

'use strict';

const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const path      = require('path');
const crypto    = require('crypto');
const Database  = require('better-sqlite3');

const PORT    = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './data/game.db';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET','POST'] },
  pingTimeout:  30000,
  pingInterval: 10000,
});

const fs = require('fs');
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS players (...);  /* твой код без изменений */
  CREATE TABLE IF NOT EXISTS games (...);
`);

function upsertPlayer(...) { /* без изменений */ }
function addWin(...) { /* без изменений */ }
function addLoss(...) { /* без изменений */ }
function addDraw(...) { /* без изменений */ }
function getLeaderboard(...) { /* без изменений */ }
function getPlayerStats(...) { /* без изменений */ }

const rooms       = new Map();
const waitingPool = [];

class RoomState {
  constructor(roomId, p1, p2 = null) {  // p2 может быть null на момент создания
    this.id       = roomId;
    this.p1       = { ...p1, field: null, ready: false, shots: 0, hits: 0 };
    this.p2       = p2 ? { ...p2, field: null, ready: false, shots: 0, hits: 0 } : null;
    this.turn     = p1.id;
    this.started  = false;
    this.over     = false;
    this.created  = Date.now();
  }

  getPlayer(socketId) {
    if (this.p1.socketId === socketId) return this.p1;
    if (this.p2 && this.p2.socketId === socketId) return this.p2;
    return null;
  }

  getOpponent(socketId) {
    if (this.p1.socketId === socketId) return this.p2;
    if (this.p2 && this.p2.socketId === socketId) return this.p1;
    return null;
  }

  bothReady() {
    return this.p1.ready && this.p2 && this.p2.ready;
  }
}

/* ==================== SOCKET ==================== */
io.on('connection', (socket) => {
  console.log(`[+] Socket ${socket.id} connected`);

  socket.on('matchmake', (data) => {
    const { mode, friendId, playerId, playerName } = data;
    const player = { socketId: socket.id, id: playerId, name: playerName };

    socket.data.playerId = playerId;
    upsertPlayer(playerId, playerName, '');

    if (mode === 'random') {
      // === твой старый код random без изменений ===
      const oppIdx = waitingPool.findIndex(p => p.id !== playerId);
      if (oppIdx >= 0) {
        const opp = waitingPool.splice(oppIdx, 1)[0];
        const roomId = crypto.randomUUID();
        const room   = new RoomState(roomId, player, opp);
        rooms.set(roomId, room);

        socket.join(roomId);
        io.sockets.sockets.get(opp.socketId)?.join(roomId);

        io.to(player.socketId).emit('matched', { roomId, opponent: { id: opp.id, name: opp.name } });
        io.to(opp.socketId).emit('matched',   { roomId, opponent: { id: player.id, name: player.name } });
      } else {
        waitingPool.push(player);
      }
      return;
    }

    /* ==================== НОВАЯ ЛОГИКА ДЛЯ ДРУГА ==================== */
    if (mode === 'friend') {
      if (!friendId) {
        // === СОЗДАТЕЛЬ ===
        const roomId = crypto.randomUUID();
        const room = new RoomState(roomId, player);
        rooms.set(roomId, room);
        socket.join(roomId);
        socket.emit('friend_room_created', { roomId });
        console.log(`[+] Комната создана ${roomId} игроком ${playerName}`);
        return;
      }

      // === ПРИСОЕДИНЯЕМСЯ ===
      const roomId = friendId;
      if (!rooms.has(roomId)) {
        socket.emit('error', { message: 'Комната не найдена' });
        return;
      }
      const room = rooms.get(roomId);
      if (room.p2 && room.p2.socketId) {
        socket.emit('error', { message: 'Комната уже заполнена' });
        return;
      }
      if (room.p1.id === player.id) {
        socket.emit('error', { message: 'Нельзя зайти в свою комнату' });
        return;
      }

      room.p2 = { ...player, field: null, ready: false, shots: 0, hits: 0 };
      socket.join(roomId);

      io.to(room.p1.socketId).emit('opponent_joined', {
        opponent: { id: player.id, name: player.name }
      });
      socket.emit('matched', {
        roomId,
        opponent: { id: room.p1.id, name: room.p1.name }
      });
      return;
    }
  });

  socket.on('place_ships', (data) => {
    const { roomId, field } = data;
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.getPlayer(socket.id);
    if (!player) return;

    player.field = field;
    player.ready = true;

    const opp = room.getOpponent(socket.id);
    if (opp) io.to(opp.socketId).emit('enemy_ready');
    io.to(socket.id).emit('my_ready_confirmed');

    if (room.bothReady()) {
      room.started = true;
      room.turn = room.p1.id;

      // === ИСПРАВЛЕНИЕ: game_start ТОЛЬКО когда оба готовы ===
      io.to(room.p1.socketId).emit('game_start', {
        myBoard: room.p1.field,
        enemyBoard: room.p2.field,
        isMyTurn: true
      });
      io.to(room.p2.socketId).emit('game_start', {
        myBoard: room.p2.field,
        enemyBoard: room.p1.field,
        isMyTurn: false
      });
    }
  });

  socket.on('shoot', (data) => {
    const { roomId, r, c } = data;
    const room = rooms.get(roomId);
    if (!room || room.over || !room.started) return;

    const shooter = room.getPlayer(socket.id);
    if (!shooter || room.turn !== shooter.id) return;

    const target = room.getOpponent(socket.id);
    if (!target || !target.field) return;

    const cellVal = target.field[r]?.[c];
    const hit = cellVal === 1;

    target.field[r][c] = hit ? 2 : 3;
    shooter.shots++;
    if (hit) shooter.hits++;

    const sunk = hit ? checkSunkServer(target.field, r, c) : false;
    const allSunk = !target.field.flat().includes(1);

    const result = {
      roomId, r, c, hit, sunk, shooter: shooter.id,
      gameOver: allSunk,
      winner: allSunk ? shooter.id : null,
    };

    io.to(roomId).emit('shot_result', result);

    if (allSunk) {
      room.over = true;
      addWin(shooter.id, shooter.shots, shooter.hits);
      addLoss(target.id, target.shots, target.hits);
    } else if (!hit) {
      room.turn = target.id;
      io.to(shooter.socketId).emit('turn', { roomId, isMyTurn: false });
      io.to(target.socketId).emit('turn',  { roomId, isMyTurn: true });
    }
  });

  socket.on('disconnect', () => { /* без изменений */ });
});

function checkSunkServer(...) { /* без изменений */ }

/* REST API без изменений */
app.get('/api/leaderboard', ...);
app.get('/api/stats/:playerId', ...);
app.get('/api/status', ...);

server.listen(PORT, () => {
  console.log(`🚢 Сервер запущен на ${PORT}`);
});