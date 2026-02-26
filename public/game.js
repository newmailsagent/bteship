'use strict';

const WS = {
  socket: null,
  roomId: null,

  async connect(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url + '/socket.io/socket.io.js';
      s.onload = () => {
        this.socket = io(url, { transports: ['websocket'] });
        this.socket.on('connect', resolve);
        this.socket.on('connect_error', reject);

        this.socket.on('matched', data => {
          this.roomId = data.roomId;
          startPlacement('online');
        });

        this.socket.on('game_start', data => {
          startGame(
            'online',
            data.myBoard,
            extractShips(data.myBoard),
            data.enemyBoard,
            [],
            { name: 'Opponent' }
          );
          Game.isMyTurn = data.isMyTurn;
        });

        this.socket.on('turn', data => {
          Game.isMyTurn = data.isMyTurn;
          updateGameStatus();
        });

        this.socket.on('shot_result', data => {
          applyShotResult(data);
        });

        this.socket.on('opponent_left', () => {
          alert('Соперник вышел');
          location.reload();
        });
      };
      document.head.appendChild(s);
    });
  },

  matchmake(mode, friendId) {
    this.socket.emit('matchmake', {
      mode,
      friendId,
      playerId: App.user.id,
      playerName: App.user.name
    });
  },

  sendShips(board) {
    this.socket.emit('place_ships', {
      roomId: this.roomId,
      field: board
    });
  },

  shoot(r, c) {
    this.socket.emit('shoot', {
      roomId: this.roomId,
      r, c
    });
  }
};

/* ───────── START ONLINE ───────── */
async function startOnline(mode) {
  showScreen('waiting');

  const server = App.settings.server || location.origin;
  await WS.connect(server);

  if (mode === 'friend') {
    const roomId = 'room_' + Date.now();
    document.getElementById('invite-link-text').textContent =
      server + '/?room=' + roomId;
    WS.matchmake('friend', roomId);
  } else {
    WS.matchmake('random');
  }
}

/* ───────── READY BUTTON FIX ───────── */
document.getElementById('btn-ready')?.addEventListener('click', () => {
  if (!Placement.allPlaced()) return;
  WS.sendShips(Placement.board);
  showScreen('waiting');
});

/* ───────── SHOOT FIX ───────── */
function playerShoot(r, c) {
  if (!Game.isMyTurn) return;
  if (Game.myShots[r][c] !== 0) return;

  WS.shoot(r, c);
  Game.isMyTurn = false;
  updateGameStatus();
}