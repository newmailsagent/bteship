/**
 * МОРСКОЙ БОЙ — server.js
 * Node.js + Express + Socket.io
 * Комнаты, matchmaking, хранение состояний, лидерборд
 */

'use strict';

const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const path      = require('path');
const crypto    = require('crypto');
const Database  = require('better-sqlite3');

/* ─── CONFIG ─────────────────────────────────────── */
const PORT    = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './data/game.db';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

/* ─── EXPRESS ────────────────────────────────────── */
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Раздаём index.html для SPA-роутинга
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ─── SOCKET.IO ──────────────────────────────────── */
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET','POST'] },
  pingTimeout:  30000,
  pingInterval: 10000,
});

/* ─── DATABASE ───────────────────────────────────── */
const fs = require('fs');
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    username    TEXT,
    wins        INTEGER DEFAULT 0,
    losses      INTEGER DEFAULT 0,
    draws       INTEGER DEFAULT 0,
    total_shots INTEGER DEFAULT 0,
    total_hits  INTEGER DEFAULT 0,
    updated_at  INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS games (
    id         TEXT PRIMARY KEY,
    player1_id TEXT,
    player2_id TEXT,
    winner_id  TEXT,
    shots_p1   INTEGER DEFAULT 0,
    shots_p2   INTEGER DEFAULT 0,
    hits_p1    INTEGER DEFAULT 0,
    hits_p2    INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

/* ─── DB HELPERS ─────────────────────────────────── */
function upsertPlayer(id, name, username) {
  db.prepare(`
    INSERT INTO players (id, name, username)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username, updated_at=strftime('%s','now')
  `).run(id, name || 'Игрок', username || '');
}

function addWin(id, shots, hits) {
  db.prepare(`UPDATE players SET wins=wins+1, total_shots=total_shots+?, total_hits=total_hits+?, updated_at=strftime('%s','now') WHERE id=?`).run(shots, hits, id);
}
function addLoss(id, shots, hits) {
  db.prepare(`UPDATE players SET losses=losses+1, total_shots=total_shots+?, total_hits=total_hits+?, updated_at=strftime('%s','now') WHERE id=?`).run(shots, hits, id);
}
function addDraw(id) {
  db.prepare(`UPDATE players SET draws=draws+1 WHERE id=?`).run(id);
}

function getLeaderboard() {
  return db.prepare(`SELECT id, name, username, wins, losses, draws, total_shots, total_hits FROM players ORDER BY wins DESC LIMIT 50`).all();
}

function getPlayerStats(id) {
  return db.prepare(`SELECT * FROM players WHERE id=?`).get(id);
}

/* ─── СОСТОЯНИЯ МАТЧЕЙ ───────────────────────────── */
const rooms       = new Map(); // roomId → RoomState
const waitingPool = [];        // игроки ждущие матча

class RoomState {
  constructor(roomId, p1, p2) {
    this.id       = roomId;
    this.p1       = { ...p1, field: null, ready: false, shots: 0, hits: 0 };
    this.p2       = { ...p2, field: null, ready: false, shots: 0, hits: 0 };
    this.turn     = p1.id; // кто ходит
    this.started  = false;
    this.over     = false;
    this.created  = Date.now();
  }

  getPlayer(socketId) {
    if (this.p1.socketId === socketId) return this.p1;
    if (this.p2.socketId === socketId) return this.p2;
    return null;
  }

  getOpponent(socketId) {
    if (this.p1.socketId === socketId) return this.p2;
    if (this.p2.socketId === socketId) return this.p1;
    return null;
  }

  bothReady() {
    return this.p1.ready && this.p2.ready;
  }
}

/* ─── SOCKET HANDLERS ────────────────────────────── */
io.on('connection', (socket) => {
  console.log(`[+] Socket ${socket.id} connected`);

  /**
   * Matchmaking
   */
  socket.on('matchmake', (data) => {
    const { mode, friendId, playerId, playerName } = data;
    const player = { socketId: socket.id, id: playerId, name: playerName };

    socket.data.playerId = playerId;
    
    upsertPlayer(playerId, playerName, '');
    socket.data.playerId = playerId;  // 👇 Добавить эту строку

    if (mode === 'random') {
      // Ищем кого-то в пуле
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
        socket.data.waiting = true;
      }
    } else if ((mode && mode.startsWith('friend_')) || (mode === 'friend' && friendId)) {
  const roomId = (mode && mode.startsWith('friend_')) 
    ? mode.replace('friend_', '') 
    : friendId;
    
  if (rooms.has(roomId)) {
  const room = rooms.get(roomId);
  if (room.p2?.socketId && room.p2.socketId !== socket.id) {
    socket.emit('error', { message: 'Комната заполнена' });
    return;
  }
  room.p2 = { ...player, field: null, ready: false, shots: 0, hits: 0 };
  socket.join(roomId);
  
  // 👇 ДОБАВИТЬ: обновляем p1 реальными данными соперника
  io.to(room.p1.socketId).emit('opponent_joined', {
    opponent: { id: player.id, name: player.name }
  });
  
  socket.emit('matched', { 
    roomId, 
    opponent: { id: room.p1.id, name: room.p1.name } 
  });
}
}
  });

  /**
   * Расстановка кораблей
   */
  socket.on('place_ships', (data) => {
    const { roomId, field } = data;
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.getPlayer(socket.id);
    if (!player) return;

    player.field = field;
    player.ready = true;

    const opp = room.getOpponent(socket.id);
    io.to(opp.socketId).emit('enemy_ready');

    io.to(socket.id).emit('my_ready_confirmed');

    if (room.bothReady()) {
      room.started = true;
      io.to(room.p1.socketId).emit('turn', { roomId, isMyTurn: true });
      io.to(room.p2.socketId).emit('turn', { roomId, isMyTurn: false });
    }


    const p1Socket = room.p1.socketId;
const p2Socket = room.p2.socketId;

  io.to(p1Socket).emit('game_start', {
  myBoard: room.p1.field,
  enemyBoard: room.p2.field,
  isMyTurn: room.turn === room.p1.id
});

// Для p2 (если подключен)
if (p2Socket) {
  io.to(p2Socket).emit('game_start', {
    myBoard: room.p2.field,
    enemyBoard: room.p1.field,  // 👈 Инвертировано!
    isMyTurn: room.turn === room.p2.id
  });
}
  
  });

  /**
   * Выстрел
   */
  socket.on('shoot', (data) => {
    const { roomId, r, c } = data;
    const room = rooms.get(roomId);
    if (!room || room.over || !room.started) return;
    if (room.turn !== socket.data.playerId && room.turn !== socket.id) {
      // Проверка очерёдности хода через socket.id
      const shooter = room.getPlayer(socket.id);
      if (!shooter || room.turn !== shooter.id) return;
    }

    const shooter = room.getPlayer(socket.id);
    const target  = room.getOpponent(socket.id);
    if (!shooter || !target || !target.field) return;

    const cellVal = target.field[r]?.[c];
    const SHIP_VAL = 1;
    const hit = cellVal === SHIP_VAL;

    target.field[r][c] = hit ? 2 : 3; // 2=hit, 3=miss
    shooter.shots++;
    if (hit) shooter.hits++;

    // Проверка на потопление
    let sunk = false;
    if (hit) {
      sunk = checkSunkServer(target.field, r, c);
    }

    // Проверка на конец игры
    const allSunk = !target.field.flat().includes(SHIP_VAL);

    const result = {
      roomId, r, c, hit, sunk, shooter: shooter.id,
      gameOver: allSunk,
      winner:   allSunk ? shooter.id : null,
    };

    io.to(roomId).emit('shot_result', result);

    if (allSunk) {
      room.over = true;
      // Сохраняем результаты
      addWin(shooter.id, shooter.shots, shooter.hits);
      addLoss(target.id, target.shots, target.hits);
    } else {
      // Передаём ход
      if (!hit) {
        room.turn = target.id;
        io.to(shooter.socketId).emit('turn', { roomId, isMyTurn: false });
        io.to(target.socketId).emit('turn',  { roomId, isMyTurn: true });
      }
      // При попадании ход остаётся
    }
  });

  /**
   * Отключение
   */
  socket.on('disconnect', () => {
    console.log(`[-] Socket ${socket.id} disconnected`);

    // Убрать из пула ожидания
    const idx = waitingPool.findIndex(p => p.socketId === socket.id);
    if (idx >= 0) waitingPool.splice(idx, 1);

    // Уведомить соперника в комнате
    for (const [roomId, room] of rooms) {
      if (room.over) continue;
      if (room.p1.socketId === socket.id || room.p2.socketId === socket.id) {
        io.to(roomId).emit('opponent_left');
        rooms.delete(roomId);
      }
    }
  });
});

/* ─── Вспомогательная: проверка потопления на сервере ─── */
function checkSunkServer(field, r, c) {
  // Ищем корабль (связанные ячейки)
  const visited = new Set();
  const stack   = [[r, c]];
  const shipCells = [];

  while (stack.length) {
    const [cr, cc] = stack.pop();
    const key = `${cr},${cc}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const v = field[cr]?.[cc];
    if (v === 1 || v === 2) {
      shipCells.push([cr, cc]);
      [[cr-1,cc],[cr+1,cc],[cr,cc-1],[cr,cc+1]].forEach(([nr,nc]) => {
        if (nr>=0&&nr<10&&nc>=0&&nc<10) stack.push([nr,nc]);
      });
    }
  }

  return shipCells.length > 0 && shipCells.every(([sr,sc]) => field[sr][sc] === 2);
}

/* ─── REST API ───────────────────────────────────── */
app.get('/api/leaderboard', (req, res) => {
  try {
    const lb = getLeaderboard();
    res.json({ ok: true, data: lb });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/stats/:playerId', (req, res) => {
  try {
    const stats = getPlayerStats(req.params.playerId);
    res.json({ ok: true, data: stats || null });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    rooms:   rooms.size,
    waiting: waitingPool.length,
    uptime:  process.uptime(),
  });
});

/* ─── START ──────────────────────────────────────── */
server.listen(PORT, () => {
  console.log(`\n🚢 Морской бой сервер запущен на порту ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Статус: http://localhost:${PORT}/api/status\n`);
});

module.exports = { app, server };
