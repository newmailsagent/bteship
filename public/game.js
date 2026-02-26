// ... весь твой код до WS остаётся без изменений ...

const WS = {
  socket: null,
  roomId: null,

  connect(serverUrl) {
    return new Promise((resolve, reject) => {
      try {
        if (!window.io) {
          const s = document.createElement('script');
          s.src = (serverUrl || 'http://localhost:3000') + '/socket.io/socket.io.js';
          s.onload = () => this._init(serverUrl, resolve, reject);
          s.onerror = () => reject(new Error('Не удалось загрузить socket.io'));
          document.head.appendChild(s);
        } else {
          this._init(serverUrl, resolve, reject);
        }
      } catch(e) { reject(e); }
    });
  },

  _init(serverUrl, resolve, reject) {
    this.socket = io(serverUrl || 'http://localhost:3000', { transports: ['websocket'] });

    this.socket.on('connect', () => resolve());
    this.socket.on('connect_error', () => reject(new Error('Ошибка подключения')));
    this.socket.on('disconnect', () => {
      if (Game.active) showModal('Соединение потеряно', 'Игра прервана.', [
        { label: 'В меню', cls: 'btn-primary', action: () => { closeModal(); showScreen('menu'); } }
      ]);
    });

    this.socket.on('matched', (data) => WS.onMatched(data));
    this.socket.on('friend_room_created', (data) => WS.onFriendRoomCreated(data));
    this.socket.on('opponent_joined', (data) => WS.onOpponentJoined(data));
    this.socket.on('enemy_ready', () => WS.onEnemyReady());
    this.socket.on('my_ready_confirmed', () => WS.onMyReadyConfirmed());
    this.socket.on('game_start', (data) => WS.onGameStart(data));
    this.socket.on('turn', (data) => WS.onTurn(data));
    this.socket.on('shot_result', (data) => WS.onShotResult(data));
    this.socket.on('opponent_left', () => {
      showModal('Соперник вышел', 'Засчитана победа!', [
        { label: 'Ок', cls: 'btn-primary', action: () => { closeModal(); endGame('win'); } }
      ]);
    });
  },

  matchmake(mode, friendId = null) {
    if (!this.socket) return;
    this.socket.emit('matchmake', {
      mode,
      friendId,
      playerId: App.user.id,
      playerName: App.user.name,
    });
  },

  sendShips(field) {
    if (!this.socket) return;
    this.socket.emit('place_ships', { roomId: this.roomId, field });
  },

  sendShot(r, c) {
    if (!this.socket) return;
    this.socket.emit('shoot', { roomId: this.roomId, r, c });
  },

  onFriendRoomCreated(data) {
    this.roomId = data.roomId;
    Game.roomId = data.roomId;

    const link = (App.settings.server || window.location.origin) + '/?room=' + data.roomId;
    const linkEl = document.getElementById('invite-link-text');
    if (linkEl) {
      linkEl.textContent = link;
      linkEl.style.overflow = 'hidden';
      linkEl.style.textOverflow = 'ellipsis';
      linkEl.style.whiteSpace = 'nowrap';
      linkEl.style.maxWidth = '100%';
    }
    document.getElementById('invite-block')?.classList.remove('hidden');
    document.getElementById('waiting-title').textContent = 'Ссылка готова!';
    document.getElementById('waiting-sub').textContent = 'Отправь другу по ссылке';
  },

  onOpponentJoined(data) {
    Game.opponent = { name: data.opponent.name, id: data.opponent.id };
    if (currentScreen === 'waiting') {
      document.getElementById('waiting-title').textContent = `Соперник ${data.opponent.name} подключился!`;
      document.getElementById('waiting-sub').textContent = 'Расставляй корабли и жми «Готов»';
      setTimeout(() => startPlacement('online'), 800);
    }
  },

  onMatched(data) {
    this.roomId = data.roomId;
    Game.roomId = data.roomId;
    Game.opponent = { name: data.opponent.name, id: data.opponent.id };
    document.getElementById('waiting-title').textContent = `Соперник найден: ${data.opponent.name}`;
    document.getElementById('waiting-sub').textContent = 'Расставляй корабли и жми «Готов»';
    setTimeout(() => startPlacement('online'), 800);
  },

  onEnemyReady() {
    document.getElementById('waiting-sub')?.textContent = 'Соперник готов! Ждём тебя...';
  },

  onMyReadyConfirmed() {
    document.getElementById('waiting-sub')?.textContent = '✅ Ты готов! Ждём соперника...';
  },

  onGameStart(data) {
    if (!Game.active) {
      const myShips = Placement.getShipsForGame?.() || Game.myShips || [];
      startGame('online', data.myBoard, myShips, data.enemyBoard, [], Game.opponent);
    }
  },

  onTurn(data) {
    Game.isMyTurn = data.isMyTurn;
    updateGameStatus();
    renderGameBoard();
    if (Game.isMyTurn) setShowingField(true);
  },

  onShotResult(data) {
    const { r, c, hit, sunk, gameOver, winner, shooter } = data;

    if (shooter === App.user.id) {
      Game.myShots[r][c] = hit ? (sunk ? CELL_SUNK : CELL_HIT) : CELL_MISS;
      Game.shots++;
      if (hit) Game.hits++;
    } else {
      Game.myBoard[r][c] = hit ? (sunk ? CELL_SUNK : CELL_HIT) : CELL_MISS;
      Game.enemyShots[r][c] = Game.myBoard[r][c];
    }

    renderGameBoard();

    if (hit) {
      Sound.hit();
      if (sunk) Sound.sunk();
      vibrate([30, 10, 30]);
    } else {
      Sound.miss();
      vibrate([10]);
    }

    if (gameOver) {
      endGame(winner === App.user.id ? 'win' : 'loss');
      return;
    }

    if (shooter === App.user.id) {
      setShowingField(hit);
    } else {
      setShowingField(false);
    }
  },

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
};

// ... остальной код game.js без изменений ...

// В DOMContentLoaded добавь/убедись, что есть:
if (room) {
  joinFriendRoom(room);
}