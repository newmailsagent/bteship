// server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static('public'));

const rooms = new Map();
const waitingPool = [];

/* ───────── ROOM STATE ───────── */
class Room {
  constructor(id, p1) {
    this.id = id;
    this.p1 = { ...p1, field: null, ready: false, shots: 0, hits: 0 };
    this.p2 = null;
    this.turn = null;
    this.started = false;
    this.over = false;
  }

  bothReady() {
    return this.p1?.ready && this.p2?.ready;
  }

  getPlayerBySocket(socketId) {
    if (this.p1?.socketId === socketId) return this.p1;
    if (this.p2?.socketId === socketId) return this.p2;
    return null;
  }

  getOpponent(socketId) {
    if (this.p1?.socketId === socketId) return this.p2;
    if (this.p2?.socketId === socketId) return this.p1;
    return null;
  }
}

/* ───────── SOCKETS ───────── */
io.on('connection', socket => {
  console.log('[+] connected', socket.id);

  socket.on('matchmake', data => {
    const { mode, friendId, playerId, playerName } = data;
    const player = { socketId: socket.id, id: playerId, name: playerName };
    socket.data.playerId = playerId;

    /* RANDOM */
    if (mode === 'random') {
      const idx = waitingPool.findIndex(p => p.id !== playerId);
      if (idx >= 0) {
        const opp = waitingPool.splice(idx, 1)[0];
        const roomId = crypto.randomUUID();
        const room = new Room(roomId, opp);
        room.p2 = player;
        room.turn = room.p1.id;
        rooms.set(roomId, room);

        socket.join(roomId);
        io.sockets.sockets.get(opp.socketId)?.join(roomId);

        io.to(roomId).emit('matched', {
          roomId,
          opponent: player.id === room.p1.id ? room.p2 : room.p1
        });
      } else {
        waitingPool.push(player);
      }
      return;
    }

    /* FRIEND */
    const roomId = friendId || crypto.randomUUID();
    let room = rooms.get(roomId);

    if (!room) {
      room = new Room(roomId, player);
      rooms.set(roomId, room);
      socket.join(roomId);
      socket.emit('waiting_friend', { roomId });
      return;
    }

    if (room.p2) {
      socket.emit('error', { message: 'Комната заполнена' });
      return;
    }

    room.p2 = player;
    room.turn = room.p1.id;
    socket.join(roomId);

    io.to(roomId).emit('matched', {
      roomId,
      opponent: player.id === room.p1.id ? room.p2 : room.p1
    });
  });

  /* PLACE SHIPS */
  socket.on('place_ships', ({ roomId, field }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.getPlayerBySocket(socket.id);
    if (!player) return;

    player.field = field;
    player.ready = true;

    if (room.bothReady() && !room.started) {
      room.started = true;

      io.to(room.p1.socketId).emit('game_start', {
        myBoard: room.p1.field,
        enemyBoard: room.p2.field,
        isMyTurn: room.turn === room.p1.id
      });

      io.to(room.p2.socketId).emit('game_start', {
        myBoard: room.p2.field,
        enemyBoard: room.p1.field,
        isMyTurn: room.turn === room.p2.id
      });
    }
  });

  /* SHOOT */
  socket.on('shoot', ({ roomId, r, c }) => {
    const room = rooms.get(roomId);
    if (!room || room.over || !room.started) return;

    const shooter = room.getPlayerBySocket(socket.id);
    const target = room.getOpponent(socket.id);
    if (!shooter || !target) return;
    if (room.turn !== shooter.id) return;

    const hit = target.field[r][c] === 1;
    target.field[r][c] = hit ? 2 : 3;
    shooter.shots++;
    if (hit) shooter.hits++;

    const allSunk = !target.field.flat().includes(1);

    io.to(room.id).emit('shot_result', {
      r, c, hit, shooter: shooter.id, gameOver: allSunk
    });

    if (allSunk) {
      room.over = true;
      return;
    }

    if (!hit) {
      room.turn = target.id;
      io.to(room.id).emit('turn', { isMyTurn: room.turn === shooter.id });
    }
  });

  socket.on('disconnect', () => {
    const idx = waitingPool.findIndex(p => p.socketId === socket.id);
    if (idx >= 0) waitingPool.splice(idx, 1);

    for (const [id, room] of rooms) {
      if (room.p1?.socketId === socket.id || room.p2?.socketId === socket.id) {
        io.to(id).emit('opponent_left');
        rooms.delete(id);
      }
    }
  });
});

server.listen(3000, () => console.log('Server on :3000'));