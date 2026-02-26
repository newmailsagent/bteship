/* ... весь твой код до WS ... */

const WS = {
  socket: null,
  roomId: null,

  connect(...) { /* без изменений */ },

  _init(serverUrl, resolve, reject) {
    this.socket = io(...);
    this.socket.on('connect', () => resolve());
    /* ... все старые on() ... */

    this.socket.on('friend_room_created', (data) => this.onFriendRoomCreated(data));
    this.socket.on('opponent_joined', (data) => this.onOpponentJoined(data));
    this.socket.on('matched', (data) => this.onMatched(data));
    this.socket.on('game_start', (data) => this.onGameStart(data));
    this.socket.on('turn', (data) => this.onTurn(data));
    this.socket.on('shot_result', (data) => this.onShotResult(data));
  },

  matchmake(mode, friendId) {
    this.socket.emit('matchmake', {
      mode,
      friendId,           // null = создать, строка = присоединиться
      playerId: App.user.id,
      playerName: App.user.name,
    });
  },

  /* === НОВЫЕ/ИСПРАВЛЕННЫЕ ХЕНДЛЕРЫ === */
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
    document.getElementById('invite-block').classList.remove('hidden');
    document.getElementById('waiting-title').textContent = 'Ссылка готова!';
    document.getElementById('waiting-sub').textContent = 'Отправь другу по ссылке';
  },

  onOpponentJoined(data) {
    Game.opponent = { name: data.opponent.name, id: data.opponent.id };
    if (currentScreen === 'waiting') {
      document.getElementById('waiting-title').textContent = `Соперник ${data.opponent.name} подключился!`;
      document.getElementById('waiting-sub').textContent = 'Расставляй корабли и жми «Готов»';
      setTimeout(() => startPlacement('online'), 1200);
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

  onGameStart(data) {
    if (!Game.active) {
      const myShips = Placement.getShipsForGame?.() || [];
      startGame('online', data.myBoard, myShips, data.enemyBoard, [], Game.opponent);
    }
  },

  onTurn(data) {
    Game.isMyTurn = data.isMyTurn;
    updateGameStatus();
    renderGameBoard();
    if (Game.isMyTurn) setShowingField(true);   // авто-переключение на поле врага
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

    // звук + вибрация
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

    // авто-переключение поля
    if (shooter === App.user.id) {
      setShowingField(hit);   // попал — остаёмся на поле врага, промах — на своё
    } else {
      setShowingField(false); // соперник выстрелил — показываем своё поле
    }
  },

  sendShot(r, c) {
    this.socket.emit('shoot', { roomId: this.roomId, r, c });
  },
  /* ... остальные методы без изменений ... */
};

/* ==================== ИСПРАВЛЕННЫЕ ФУНКЦИИ ==================== */
async function startOnline(mode) {
  showScreen('waiting');
  document.getElementById('waiting-title').textContent = 'Подключение…';
  document.getElementById('waiting-sub').textContent = 'Соединяемся с сервером';

  const serverUrl = App.settings.server || window.location.origin;
  try {
    await WS.connect(serverUrl);

    if (mode === 'friend') {
      WS.matchmake('friend', null);   // создать комнату
    } else if (mode === 'random') {
      document.getElementById('waiting-title').textContent = 'Ищем соперника…';
      WS.matchmake('random', null);
    }
  } catch (e) {
    showModal('Нет сервера', 'Онлайн недоступен. Сыграй с ботом?', [
      { label: 'С ботом', action: () => { closeModal(); startBotGame('bot-medium'); }},
      { label: 'В меню', action: () => { closeModal(); showScreen('menu'); }}
    ]);
  }
}

function joinFriendRoom(roomId) {
  showScreen('waiting');
  document.getElementById('waiting-title').textContent = 'Подключение к другу...';
  const serverUrl = App.settings.server || window.location.origin;
  WS.connect(serverUrl).then(() => {
    WS.matchmake('friend', roomId);
  }).catch(() => {
    showModal('Ошибка', 'Не удалось подключиться', [{label: 'OK', action: closeModal}]);
  });
}

/* В playerShoot — только отправка на сервер для онлайн */
function playerShoot(r, c) {
  if (!Game.active || !Game.isMyTurn || Game.myShots[r][c] !== CELL_EMPTY) return;

  if (Game.mode === 'online') {
    WS.sendShot(r, c);
    return;
  }

  // весь старый код для бота остаётся без изменений
  /* ... твой оригинальный bot-код ... */
}

/* В DOMContentLoaded добавь: */
window.addEventListener('DOMContentLoaded', async () => {
  /* ... твой старый init ... */

  // === ДЕСКТОП + БУРГЕР ===
  const isDesktop = window.innerWidth >= 1024;
  document.body.classList.toggle('desktop', isDesktop);

  if (!isDesktop) {
    const burger = document.createElement('button');
    burger.id = 'burger-btn';
    burger.innerHTML = '☰';
    burger.style.cssText = 'position:fixed;top:15px;right:15px;z-index:9999;font-size:28px;background:none;border:none;color:white;';
    document.body.appendChild(burger);

    burger.addEventListener('click', () => {
      showModal('Меню', '', [
        { label: 'Сдаться 🏳️', cls: 'btn-danger', action: () => { closeModal(); document.getElementById('btn-surrender')?.click(); }},
        { label: App.settings.sound ? '🔊 Выключить звук' : '🔇 Включить звук', action: () => {
          App.settings.sound = !App.settings.sound;
          saveJSON('bs_settings', App.settings);
          initSoundButton();
          closeModal();
        }},
        { label: 'Статистика', action: () => { closeModal(); showScreen('stats'); }}
      ]);
    });
  }

  // центрирование экранов ожидания
  const oldShowScreen = showScreen;
  showScreen = (name) => {
    oldShowScreen(name);
    if (name === 'waiting') {
      const screen = document.getElementById('screen-waiting');
      if (screen) screen.style.textAlign = 'center';
    }
  };

  // исправление перекрытия дока кораблей
  const oldStartPlacement = startPlacement;
  startPlacement = (mode) => {
    oldStartPlacement(mode);
    setTimeout(() => {
      const dock = document.getElementById('ship-dock');
      if (dock) {
        dock.style.maxHeight = '280px';
        dock.style.overflowY = 'auto';
      }
    }, 200);
  };

  /* ... остальной код ... */
});

/* В URL-параметрах (приглашение) замени на: */
if (room) {
  setTimeout(() => {
    showModal('Приглашение', 'Тебя пригласили в игру!', [
      { label: 'Подключиться', cls: 'btn-primary', action: () => { closeModal(); joinFriendRoom(room); }},
      { label: 'Отмена', cls: 'btn-ghost', action: closeModal }
    ]);
  }, 400);
}