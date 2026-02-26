/* ═══════════════════════════════════════════════════════════════
   МОРСКОЙ БОЙ — game.js
   Вся игровая логика: расстановка, ходы, бот, WebSocket, UI
═══════════════════════════════════════════════════════════════ */

'use strict';

/* ─── КОНСТАНТЫ ──────────────────────────────────── */
const BOARD_SIZE = 10;
const COLS = 'ABCDEFGHIJ';
const SHIP_DEFS = [
  { size: 4, count: 1 },
  { size: 3, count: 2 },
  { size: 2, count: 3 },
  { size: 1, count: 4 },
];

const CELL_EMPTY  = 0;
const CELL_SHIP   = 1;
const CELL_HIT    = 2;
const CELL_MISS   = 3;
const CELL_SUNK   = 4;

/* ─── СОСТОЯНИЕ ПРИЛОЖЕНИЯ ───────────────────────── */
const App = {
  user:     null,
  settings: {},
  stats:    {},
  history:  [],
};

/* ─── СОСТОЯНИЕ ТЕКУЩЕЙ ИГРЫ ─────────────────────── */
const Game = {
  mode: null,         // 'bot-easy' | 'bot-medium' | 'bot-hard' | 'random' | 'friend'
  myBoard:     null,  // 10x10 числовой массив
  enemyBoard:  null,
  myShots:     null,  // что мы стреляли по врагу (что видим)
  enemyShots:  null,  // что враг стрелял по нам
  myShips:     [],    // [{cells:[{r,c}], sunk:false}]
  enemyShips:  [],
  isMyTurn:    false,
  showingEnemy: true,
  active:       false,
  roomId:       null,
  opponent:     null,
  shots:        0,
  hits:         0,
  // Для бота (охота)
  botMode:      'hunt', // 'hunt' | 'target'
  botQueue:     [],
  botLastHit:   null,
  botDirection: null,
};

/* ─── ЗВУКИ (Web Audio API, без файлов) ──────────── */
const Sound = (() => {
  let ctx = null;
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }
  function beep(freq, type='sine', duration=0.12, vol=0.3) {
    if (!App.settings.sound) return;
    try {
      const c = getCtx();
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.connect(gain); gain.connect(c.destination);
      osc.frequency.value = freq;
      osc.type = type;
      gain.gain.setValueAtTime(vol, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
      osc.start(c.currentTime);
      osc.stop(c.currentTime + duration);
    } catch(e) {}
  }
  return {
    hit:   () => { beep(180,'sawtooth',.25,.4); setTimeout(()=>beep(120,'square',.3,.3),80); },
    miss:  () => beep(300,'sine',.08,.2),
    sunk:  () => { beep(80,'sawtooth',.5,.5); setTimeout(()=>beep(60,'sawtooth',.4,.4),200); },
    win:   () => { [523,659,784,1047].forEach((f,i)=>setTimeout(()=>beep(f,'sine',.3,.4),i*150)); },
    lose:  () => { [200,180,160].forEach((f,i)=>setTimeout(()=>beep(f,'sawtooth',.4,.3),i*200)); },
    click: () => beep(600,'sine',.05,.15),
    place: () => beep(400,'square',.06,.2),
  };
})();

/* ─── ВИБРАЦИЯ ───────────────────────────────────── */
function vibrate(pattern=[30]) {
  if (App.settings.vibro && navigator.vibrate) navigator.vibrate(pattern);
}

/* ─── УТИЛИТЫ ────────────────────────────────────── */
function makeBoard() {
  return Array.from({length: BOARD_SIZE}, () => new Array(BOARD_SIZE).fill(CELL_EMPTY));
}

function inBounds(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

function cloneBoard(b) {
  return b.map(r => [...r]);
}

function countCells(board, val) {
  return board.flat().filter(v => v === val).length;
}

/* ─── ЛОГИКА КОРАБЛЕЙ ────────────────────────────── */
function canPlace(board, r, c, size, vertical) {
  for (let i = 0; i < size; i++) {
    const nr = vertical ? r + i : r;
    const nc = vertical ? c : c + i;
    if (!inBounds(nr, nc)) return false;
    // Проверяем ячейку и соседей
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const sr = nr + dr, sc = nc + dc;
        if (inBounds(sr, sc) && board[sr][sc] !== CELL_EMPTY) return false;
      }
    }
  }
  return true;
}

function placeShip(board, r, c, size, vertical) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const nr = vertical ? r + i : r;
    const nc = vertical ? c : c + i;
    board[nr][nc] = CELL_SHIP;
    cells.push({r: nr, c: nc});
  }
  return cells;
}

function randomPlaceAll() {
  const board = makeBoard();
  const ships  = [];
  for (const def of SHIP_DEFS) {
    for (let k = 0; k < def.count; k++) {
      let placed = false;
      let tries  = 0;
      while (!placed && tries < 500) {
        tries++;
        const vertical = Math.random() < 0.5;
        const r = Math.floor(Math.random() * BOARD_SIZE);
        const c = Math.floor(Math.random() * BOARD_SIZE);
        if (canPlace(board, r, c, def.size, vertical)) {
          const cells = placeShip(board, r, c, def.size, vertical);
          ships.push({ cells, sunk: false, size: def.size });
          placed = true;
        }
      }
    }
  }
  return { board, ships };
}

function checkSunk(board, ships, r, c) {
  for (const ship of ships) {
    if (ship.sunk) continue;
    if (ship.cells.some(cell => cell.r === r && cell.c === c)) {
      const allHit = ship.cells.every(cell => board[cell.r][cell.c] === CELL_HIT);
      if (allHit) {
        ship.sunk = true;
        // Помечаем потопленные
        ship.cells.forEach(cell => { board[cell.r][cell.c] = CELL_SUNK; });
        // Заблокируем периметр (промахи)
        ship.cells.forEach(({r: sr, c: sc}) => {
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const nr2 = sr+dr, nc2 = sc+dc;
              if (inBounds(nr2, nc2) && board[nr2][nc2] === CELL_EMPTY) {
                board[nr2][nc2] = CELL_MISS;
              }
            }
          }
        });
        return ship;
      }
    }
  }
  return null;
}

function allSunk(ships) {
  return ships.every(s => s.sunk);
}

/* ─── НАВИГАЦИЯ ──────────────────────────────────── */
let currentScreen = 'loading';

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
  currentScreen = name;
}

/* ─── ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ ───────────────────────── */
function initUser() {
  let tgUser = null;
  try {
    if (window.Telegram?.WebApp?.initDataUnsafe?.user) {
      tgUser = Telegram.WebApp.initDataUnsafe.user;
    }
  } catch(e) {}

  const saved = loadJSON('bs_user', null);
  if (tgUser) {
    App.user = {
      id:       tgUser.id,
      name:     tgUser.first_name || 'Игрок',
      username: tgUser.username ? '@' + tgUser.username : '',
      photo:    tgUser.photo_url || null,
      isGuest:  false,
    };
  } else if (saved) {
    App.user = saved;
  } else {
    App.user = {
      id:       'guest_' + Date.now(),
      name:     'Гость',
      username: '',
      photo:    null,
      isGuest:  true,
    };
  }
  saveJSON('bs_user', App.user);
}

/* ─── НАСТРОЙКИ ──────────────────────────────────── */
function initSettings() {
  App.settings = loadJSON('bs_settings', {
    sound:  true,
    vibro:  true,
    hints:  true,
    anim:   true,
    server: '',
  });

  const ids = ['sound','vibro','hints','anim'];
  ids.forEach(id => {
    const el = document.getElementById('setting-' + id);
    if (el) el.checked = !!App.settings[id];
    el?.addEventListener('change', () => {
      App.settings[id] = el.checked;
      saveJSON('bs_settings', App.settings);
    });
  });
  const srv = document.getElementById('setting-server');
  if (srv) {
    srv.value = App.settings.server || '';
    srv.addEventListener('change', () => {
      App.settings.server = srv.value.trim();
      saveJSON('bs_settings', App.settings);
    });
  }

  document.getElementById('btn-reset-stats')?.addEventListener('click', () => {
    showModal('Сбросить статистику?', 'Все данные о победах и боях будут удалены.', [
      { label: 'Отмена', cls: 'btn-ghost', action: closeModal },
      { label: 'Сбросить', cls: 'btn-danger', action: () => {
          App.stats = defaultStats();
          App.history = [];
          saveJSON('bs_stats', App.stats);
          saveJSON('bs_history', App.history);
          updateMenuStats();
          closeModal();
      }},
    ]);
  });
}

function defaultStats() {
  return { wins:0, losses:0, draws:0, totalShots:0, totalHits:0 };
}

/* ─── СТАТИСТИКА ─────────────────────────────────── */
function initStats() {
  App.stats   = loadJSON('bs_stats', defaultStats());
  App.history = loadJSON('bs_history', []);
}

function recordResult(result, shots, hits, opponentName) {
  // result: 'win' | 'loss' | 'draw'
  App.stats[result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws']++;
  App.stats.totalShots += shots;
  App.stats.totalHits  += hits;
  saveJSON('bs_stats', App.stats);

  const entry = {
    result,
    opponent: opponentName || 'Неизвестно',
    shots, hits,
    date: Date.now(),
  };
  App.history.unshift(entry);
  if (App.history.length > 50) App.history.pop();
  saveJSON('bs_history', App.history);
}

function updateMenuStats() {
  setText('stat-wins', App.stats.wins);
  setText('stat-total', App.stats.wins + App.stats.losses + App.stats.draws);
}

/* ─── ЛИДЕРБОРД ──────────────────────────────────── */
function renderLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  if (!list) return;

  // Пробуем загрузить с сервера, иначе локальный
  const localEntry = { ...App.user, wins: App.stats.wins };
  let lb = loadJSON('bs_leaderboard', []);

  // Обновляем/добавляем себя
  const idx = lb.findIndex(e => e.id === App.user.id);
  if (idx >= 0) lb[idx] = localEntry; else lb.push(localEntry);
  lb.sort((a,b) => b.wins - a.wins);
  lb = lb.slice(0,10);
  saveJSON('bs_leaderboard', lb);

  const medals = ['gold','silver','bronze'];
  list.innerHTML = '';
  if (!lb.length) { list.innerHTML = '<p class="empty-state">Пока никого нет</p>'; return; }

  lb.forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = 'lb-item';
    const rankCls = medals[i] || '';
    const isMe = entry.id === App.user.id ? '<small>(вы)</small>' : '';
    div.innerHTML = `
      <div class="lb-rank ${rankCls}">${i < 3 ? ['🥇','🥈','🥉'][i] : i+1}</div>
      <div class="lb-avatar">${(entry.name||'?')[0].toUpperCase()}</div>
      <div class="lb-info">
        <strong>${entry.name || 'Игрок'} ${isMe}</strong>
        <small>${entry.username || ''}</small>
      </div>
      <div class="lb-wins">${entry.wins}</div>
    `;
    list.appendChild(div);
  });
}

function renderStatsScreen() {
  const s = App.stats;
  const total = s.wins + s.losses + s.draws;

  setHTML('stats-avatar', App.user.name[0]?.toUpperCase() || '?');
  setText('stats-name', App.user.name);

  setText('st-wins', s.wins);
  setText('st-losses', s.losses);
  setText('st-draws', s.draws);
  setText('st-total', total);
  setText('st-acc', s.totalShots ? Math.round(s.totalHits/s.totalShots*100)+'%' : '0%');
  setText('st-winrate', total ? Math.round(s.wins/total*100)+'%' : '0%');

  const hl = document.getElementById('history-list');
  if (!hl) return;
  hl.innerHTML = '';
  if (!App.history.length) {
    hl.innerHTML = '<p class="empty-state">Ещё нет сыгранных боёв</p>';
    return;
  }
  App.history.slice(0,20).forEach(h => {
    const div = document.createElement('div');
    div.className = 'history-item';
    const icons = {win:'✅',loss:'❌',draw:'🤝'};
    const labels = {win:'Победа над',loss:'Проигрыш',draw:'Ничья с'};
    const time = new Date(h.date).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
    div.innerHTML = `
      <div class="history-icon">${icons[h.result]}</div>
      <div class="history-info">
        ${labels[h.result]} ${h.opponent}
        <span>Выстрелов: ${h.shots}, Попаданий: ${h.hits}</span>
      </div>
      <div class="history-time">${time}</div>
    `;
    hl.appendChild(div);
  });
}

/* ─── ДОСКА: ОТРИСОВКА ───────────────────────────── */
function renderBoard(boardEl, data, opts = {}) {
  boardEl.innerHTML = '';
  const { clickable, onCellClick, showShips } = opts;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      const val = data[r][c];

      if (val === CELL_SHIP && showShips) cell.classList.add('ship');
      if (val === CELL_HIT)  cell.classList.add('hit');
      if (val === CELL_MISS) cell.classList.add('miss');
      if (val === CELL_SUNK) cell.classList.add('sunk');

      if (clickable && val === CELL_EMPTY) {
        cell.classList.add('hoverable');
        cell.addEventListener('click', () => onCellClick(r, c));
      }
      boardEl.appendChild(cell);
    }
  }
}

function updateCellVisual(boardEl, r, c, val) {
  const cell = boardEl.querySelector(`[data-r="${r}"][data-c="${c}"]`);
  if (!cell) return;
  cell.classList.remove('hit','miss','sunk','hoverable');
  if (val === CELL_HIT)  cell.classList.add('hit');
  if (val === CELL_MISS) cell.classList.add('miss');
  if (val === CELL_SUNK) cell.classList.add('sunk');
}

function buildLabels() {
  ['placement','game'].forEach(prefix => {
    const row = document.getElementById(prefix+'-row-labels');
    const col = document.getElementById(prefix+'-col-labels');
    if (!row || !col) return;

    // Column headers: A–J
    row.innerHTML = '';
    COLS.split('').forEach(l => {
      const d = document.createElement('div');
      d.className = 'board-label';
      d.textContent = l;
      row.appendChild(d);
    });

    // Row numbers: 1–10
    // Fix 5: padding-top in CSS offsets these to align with row 1, not the letter row
    col.innerHTML = '';
    for (let i = 1; i <= 10; i++) {
      const d = document.createElement('div');
      d.className = 'board-label';
      d.textContent = i;
      col.appendChild(d);
    }
  });
}

/* ─── ГЕРОЙСКАЯ АНИМАЦИЯ МЕНЮ ────────────────────── */
function initHeroGrid() {
  const grid = document.getElementById('hero-grid');
  if (!grid) return;
  const cells = [];
  for (let i = 0; i < 60; i++) {
    const d = document.createElement('div');
    d.className = 'hero-grid-cell';
    grid.appendChild(d);
    cells.push(d);
  }
  function animLoop() {
    const cls = Math.random() < 0.3 ? 'hit' : 'active';
    const idx = Math.floor(Math.random() * cells.length);
    const c = cells[idx];
    c.classList.add(cls);
    setTimeout(() => c.classList.remove(cls, 'active', 'hit'), 600 + Math.random()*800);
  }
  setInterval(animLoop, 200);
}

/* ─── РАССТАНОВКА: UI ────────────────────────────── */
const Placement = {
  board:    null,
  ships:    [],
  selected: null,
  vertical: false,

  // drag state
  _drag: null, // { ship, startX, startY, el, clone }
  _lastTap: {}, // id → timestamp for double-tap detection

  init() {
    this.board    = makeBoard();
    this.ships    = [];
    this.selected = null;
    this.vertical = false;
    this._drag    = null;
    this._lastTap = {};

    let id = 0;
    for (const def of SHIP_DEFS) {
      for (let k = 0; k < def.count; k++) {
        this.ships.push({ id: id++, size: def.size, placed: false, vertical: false, cells: [] });
      }
    }
    this.renderDock();
    this.renderBoard();
  },

  renderDock() {
    const dock = document.getElementById('ship-dock');
    if (!dock) return;
    dock.innerHTML = '';
    this.ships.forEach(ship => {
      const wrap = document.createElement('div');
      const isSelected = this.selected?.id === ship.id;
      wrap.className = 'ship-piece'
        + (ship.placed ? ' placed' : '')
        + (isSelected ? ' selected' : '')
        + (ship.vertical ? ' vertical' : '');
      wrap.dataset.id = ship.id;

      for (let i = 0; i < ship.size; i++) {
        const c = document.createElement('div');
        c.className = 'ship-cell';
        wrap.appendChild(c);
      }

      if (!ship.placed) {
        // Одиночный клик/тап — выбор
        wrap.addEventListener('click', (e) => {
          // Игнорируем если это конец drag
          if (this._drag?._wasDrag) return;
          this.selectShip(ship.id);
        });

        // Двойной тап — поворот
        wrap.addEventListener('touchend', (e) => this._handleDoubleTap(e, ship.id));
        wrap.addEventListener('dblclick', (e) => { e.preventDefault(); this.rotateSingleShip(ship.id); });

        // Drag: mouse
        wrap.addEventListener('mousedown', (e) => this._startDrag(e, ship, wrap));

        // Drag: touch
        wrap.addEventListener('touchstart', (e) => this._startDragTouch(e, ship, wrap), { passive: false });
      }

      dock.appendChild(wrap);
    });
  },

  selectShip(id) {
    this.selected = this.ships.find(s => s.id === id) || null;
    Sound.click();
    this.renderDock();
  },

  rotateSingleShip(id) {
    const ship = this.ships.find(s => s.id === id);
    if (!ship || ship.placed) return;
    // Если это выбранный — просто меняем вертикаль
    if (this.selected?.id === id) {
      this.vertical = !this.vertical;
      ship.vertical = this.vertical;
    } else {
      this.selectShip(id);
      this.vertical = !this.vertical;
    }
    Sound.click();
    vibrate([10]);
    this.renderDock();
  },

  _handleDoubleTap(e, id) {
    const now = Date.now();
    const last = this._lastTap[id] || 0;
    if (now - last < 350) {
      // двойной тап
      e.preventDefault();
      this.rotateSingleShip(id);
      this._lastTap[id] = 0;
    } else {
      this._lastTap[id] = now;
    }
  },

  /* ── DRAG: MOUSE ────────────────────────────────── */
  _startDrag(e, ship, el) {
    if (e.button !== 0) return;
    e.preventDefault();
    this._drag = { ship, el, _wasDrag: false };
    this._drag._onMove = (ev) => this._moveDrag(ev.clientX, ev.clientY);
    this._drag._onUp   = (ev) => this._endDrag(ev.clientX, ev.clientY);
    document.addEventListener('mousemove', this._drag._onMove);
    document.addEventListener('mouseup',   this._drag._onUp);
    this.selectShip(ship.id);
  },

  _moveDrag(cx, cy) {
    if (!this._drag) return;
    this._drag._wasDrag = true;
    this._highlightCellUnder(cx, cy);
  },

  _endDrag(cx, cy) {
    if (!this._drag) return;
    document.removeEventListener('mousemove', this._drag._onMove);
    document.removeEventListener('mouseup',   this._drag._onUp);
    this._tryPlaceAt(cx, cy);
    this._drag = null;
    this.clearPreview();
  },

  /* ── DRAG: TOUCH ────────────────────────────────── */
  _startDragTouch(e, ship, el) {
    // Не начинаем drag сразу — ждём движения
    const t = e.touches[0];
    this._drag = {
      ship, el,
      startX: t.clientX, startY: t.clientY,
      _wasDrag: false,
      _onMove: (ev) => {
        ev.preventDefault();
        const tt = ev.touches[0];
        const dx = tt.clientX - this._drag.startX;
        const dy = tt.clientY - this._drag.startY;
        if (!this._drag._wasDrag && Math.hypot(dx,dy) > 8) {
          this._drag._wasDrag = true;
          this.selectShip(ship.id);
        }
        if (this._drag._wasDrag) this._highlightCellUnder(tt.clientX, tt.clientY);
      },
      _onEnd: (ev) => {
        const tt = ev.changedTouches[0];
        document.removeEventListener('touchmove', this._drag._onMove);
        document.removeEventListener('touchend',  this._drag._onEnd);
        if (this._drag._wasDrag) {
          this._tryPlaceAt(tt.clientX, tt.clientY);
        }
        this._drag = null;
        this.clearPreview();
      },
    };
    document.addEventListener('touchmove', this._drag._onMove, { passive: false });
    document.addEventListener('touchend',  this._drag._onEnd);
  },

  _highlightCellUnder(cx, cy) {
    this.clearPreview();
    if (!this.selected) return;
    const rc = this._getCellFromPoint(cx, cy);
    if (!rc) return;
    const { r, c } = rc;
    const valid = canPlace(this.board, r, c, this.selected.size, this.vertical);
    for (let i = 0; i < this.selected.size; i++) {
      const nr = this.vertical ? r+i : r;
      const nc = this.vertical ? c : c+i;
      if (!inBounds(nr, nc)) continue;
      const cell = document.querySelector(`#placement-board [data-r="${nr}"][data-c="${nc}"]`);
      if (cell) cell.classList.add(valid ? 'preview' : 'invalid');
    }
  },

  _tryPlaceAt(cx, cy) {
    if (!this.selected) return;
    const rc = this._getCellFromPoint(cx, cy);
    if (!rc) return;
    const { r, c } = rc;
    if (!canPlace(this.board, r, c, this.selected.size, this.vertical)) {
      vibrate([20,10,20]);
      return;
    }
    this._placeSelectedAt(r, c);
  },

  _getCellFromPoint(cx, cy) {
    const el = document.elementFromPoint(cx, cy);
    if (!el) return null;
    const cell = el.closest('[data-r][data-c]');
    if (!cell) return null;
    const boardEl = document.getElementById('placement-board');
    if (!boardEl.contains(cell)) return null;
    return { r: +cell.dataset.r, c: +cell.dataset.c };
  },

  _placeSelectedAt(r, c) {
    if (!this.selected) return;
    this.selected.vertical = this.vertical;
    const cells = placeShip(this.board, r, c, this.selected.size, this.vertical);
    this.selected.cells  = cells;
    this.selected.placed = true;
    // Автоматически выбираем следующий непоставленный
    this.selected = this.ships.find(s => !s.placed) || null;
    Sound.place(); vibrate([15]);
    this.renderDock();
    this.renderBoard();
  },

  renderBoard() {
    const boardEl = document.getElementById('placement-board');
    if (!boardEl) return;
    boardEl.innerHTML = '';
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.r = r; cell.dataset.c = c;
        const val = this.board[r][c];
        if (val === CELL_SHIP) cell.classList.add('ship');

        // Клик по полю
        cell.addEventListener('click', () => this.handleCellClick(r, c));
        // Ховер (только мышь)
        cell.addEventListener('mouseenter', () => this.handleHover(r, c));
        cell.addEventListener('mouseleave', () => {
          if (!this._drag?._wasDrag) this.clearPreview();
        });
        boardEl.appendChild(cell);
      }
    }
    const ready = document.getElementById('btn-ready');
    if (ready) ready.disabled = !this.allPlaced();
  },

  handleHover(r, c) {
    if (this._drag?._wasDrag) return; // во время drag управляет _highlightCellUnder
    if (!this.selected) return;
    this.clearPreview();
    const valid = canPlace(this.board, r, c, this.selected.size, this.vertical);
    for (let i = 0; i < this.selected.size; i++) {
      const nr = this.vertical ? r+i : r;
      const nc = this.vertical ? c : c+i;
      if (!inBounds(nr, nc)) continue;
      const cell = document.querySelector(`#placement-board [data-r="${nr}"][data-c="${nc}"]`);
      if (cell) cell.classList.add(valid ? 'preview' : 'invalid');
    }
  },

  clearPreview() {
    document.querySelectorAll('#placement-board .preview, #placement-board .invalid')
      .forEach(c => c.classList.remove('preview','invalid'));
  },

  handleCellClick(r, c) {
    if (this._drag?._wasDrag) return; // drag размещает сам
    if (!this.selected) return;
    if (!canPlace(this.board, r, c, this.selected.size, this.vertical)) {
      vibrate([20,10,20]); return;
    }
    this._placeSelectedAt(r, c);
  },

  clear() {
    this.board = makeBoard();
    this.ships.forEach(s => { s.placed = false; s.cells = []; s.vertical = false; });
    this.selected = this.ships[0] || null;
    this.vertical = false;
    this.renderDock();
    this.renderBoard();
  },

  randomize() {
    const { board, ships } = randomPlaceAll();
    this.board = board;
    this.ships.forEach((s, i) => {
      s.placed   = true;
      s.cells    = ships[i]?.cells || [];
      s.vertical = ships[i]?.vertical || false;
    });
    this.selected = null;
    Sound.place();
    this.renderDock();
    this.renderBoard();
  },

  allPlaced() { return this.ships.every(s => s.placed); },

  getShipsForGame() {
    return this.ships.map(s => ({ cells: [...s.cells], sunk: false, size: s.size }));
  },
};

/* ─── ИГРОВОЙ ПРОЦЕСС ────────────────────────────── */
function startGame(mode, myBoard, myShips, enemyBoard, enemyShips, opponent) {
  Game.mode       = mode;
  Game.myBoard    = cloneBoard(myBoard);
  Game.myShips    = JSON.parse(JSON.stringify(myShips));
  Game.enemyBoard = cloneBoard(enemyBoard || makeBoard());
  Game.enemyShips = enemyShips ? JSON.parse(JSON.stringify(enemyShips)) : [];
  Game.myShots    = makeBoard();
  Game.enemyShots = makeBoard();
  Game.isMyTurn   = true;
  Game.showingEnemy = true;
  Game.active     = true;
  Game.shots      = 0;
  Game.hits       = 0;
  Game.opponent   = opponent || { name: 'Бот', username: '' };

  // Для бота расставим его корабли случайно, если не переданы
  if (mode.startsWith('bot') && !enemyShips) {
    const r = randomPlaceAll();
    Game.enemyBoard = r.board;
    Game.enemyShips = r.ships;
  }

  // Обнулим состояние бота
  Game.botMode    = 'hunt';
  Game.botQueue   = [];
  Game.botLastHit = null;
  Game.botDirection = null;

  // UI
  document.getElementById('opp-name').textContent = opponent?.name || 'Бот';
  renderGameBoard();
  updateEnemyFleet();
  showScreen('game');
  updateGameStatus();
}

function renderGameBoard() {
  const boardEl = document.getElementById('game-board');
  if (Game.showingEnemy) {
    // Показываем что мы стреляли (только попадания/промахи, корабли врага скрыты)
    const display = makeBoard();
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const shot = Game.myShots[r][c];
        if (shot === CELL_HIT || shot === CELL_MISS || shot === CELL_SUNK)
          display[r][c] = shot;
      }
    }
    renderBoard(boardEl, display, {
      clickable:     Game.isMyTurn,
      showShips:     false,
      onCellClick:   (r,c) => playerShoot(r, c),
    });
  } else {
    // Показываем наше поле с кораблями и попаданиями врага
    const display = cloneBoard(Game.myBoard);
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const shot = Game.enemyShots[r][c];
        if (shot === CELL_HIT || shot === CELL_MISS || shot === CELL_SUNK)
          display[r][c] = shot;
      }
    }
    renderBoard(boardEl, display, { clickable: false, showShips: true });
  }
  updateShipsLeft();
  updateEnemyFleet();
}

function updateGameStatus() {
  const el = document.getElementById('game-status');
  if (!el) return;
  if (!Game.active) return;
  el.textContent = Game.isMyTurn ? 'Твой ход' : 'Ход соперника';
  el.style.color = Game.isMyTurn ? 'var(--green)' : 'var(--hint)';
}

function updateShipsLeft() {
  const myAlive    = Game.myShips.filter(s => !s.sunk).length;
  const enemyAlive = Game.enemyShips.filter(s => !s.sunk).length;
  setText('my-ships-left',    `${myAlive}`);
  setText('enemy-ships-left', `${enemyAlive}`);
}

/* Fix 3: Enemy remaining fleet miniature display */
function updateEnemyFleet() {
  const container = document.getElementById('enemy-fleet-ships');
  if (!container) return;
  container.innerHTML = '';

  // Sort ships largest first for visual clarity
  const sorted = [...Game.enemyShips].sort((a, b) => b.size - a.size);
  sorted.forEach(ship => {
    const wrap = document.createElement('div');
    wrap.className = 'fleet-ship' + (ship.sunk ? ' sunk' : '');
    for (let i = 0; i < ship.size; i++) {
      const c = document.createElement('div');
      c.className = 'fleet-cell';
      wrap.appendChild(c);
    }
    container.appendChild(wrap);
  });
}

/* ─── ВЫСТРЕЛ ИГРОКА ─────────────────────────────── */
function playerShoot(r, c) {
  if (!Game.active || !Game.isMyTurn) return;
  if (Game.myShots[r][c] !== CELL_EMPTY) return;

  Game.shots++;
  const hit = Game.enemyBoard[r][c] === CELL_SHIP;

  Game.myShots[r][c] = hit ? CELL_HIT : CELL_MISS;
  Game.enemyBoard[r][c] = hit ? CELL_HIT : CELL_MISS;

  if (hit) {
    Game.hits++;
    Game.enemyBoard[r][c] = CELL_HIT;
    Sound.hit(); vibrate([30, 10, 30]);

    const sunk = checkSunk(Game.enemyBoard, Game.enemyShips, r, c);
    if (sunk) {
      for (let rr = 0; rr < BOARD_SIZE; rr++) {
        for (let cc = 0; cc < BOARD_SIZE; cc++) {
          if (Game.enemyBoard[rr][cc] === CELL_SUNK || Game.enemyBoard[rr][cc] === CELL_MISS)
            Game.myShots[rr][cc] = Game.enemyBoard[rr][cc];
        }
      }
      Sound.sunk(); vibrate([50,20,50,20,50]);
    }

    if (allSunk(Game.enemyShips)) {
      endGame('win');
      return;
    }
    // При попадании — ход остаётся у игрока, показываем поле врага
    setShowingField(true);
    renderGameBoard();
  } else {
    Game.myShots[r][c] = CELL_MISS;
    Sound.miss(); vibrate([10]);

    // Промах: переключаем на СВОЁ поле чтобы видеть ход соперника
    Game.isMyTurn = false;
    updateGameStatus();
    setShowingField(false); // показываем своё поле
    renderGameBoard();

    if (Game.mode.startsWith('bot')) {
      setTimeout(botShoot, 800 + Math.random()*600);
    }
  }
}

/* ─── ПЕРЕКЛЮЧЕНИЕ ПОЛЯ (авто + ручное) ─────────── */
function setShowingField(showEnemy) {
  Game.showingEnemy = showEnemy;
  const btnEnemy = document.getElementById('btn-show-enemy');
  const btnMine  = document.getElementById('btn-show-mine');
  if (btnEnemy) btnEnemy.classList.toggle('active', showEnemy);
  if (btnMine)  btnMine.classList.toggle('active', !showEnemy);
}


function botGetDifficulty() {
  if (Game.mode === 'bot-easy')   return 'easy';
  if (Game.mode === 'bot-medium') return 'medium';
  return 'hard';
}

function botShoot() {
  if (!Game.active || Game.isMyTurn) return;

  const diff = botGetDifficulty();
  let r, c;

  if (diff === 'easy') {
    // Случайный незатронутый
    const empty = getEmptyCells(Game.enemyShots);
    if (!empty.length) return;
    [r, c] = empty[Math.floor(Math.random() * empty.length)];
  } else if (diff === 'medium') {
    // Охота + добивание без направления
    if (Game.botQueue.length) {
      [r, c] = Game.botQueue.shift();
      while (Game.enemyShots[r][c] !== CELL_EMPTY) {
        if (!Game.botQueue.length) { [r, c] = randomEmpty(Game.enemyShots); break; }
        [r, c] = Game.botQueue.shift();
      }
    } else {
      [r, c] = randomEmpty(Game.enemyShots);
    }
  } else {
    // Hard: охота с шахматным паттерном + умное добивание с направлением
    if (Game.botQueue.length) {
      [r, c] = Game.botQueue.shift();
      while (Game.botQueue.length && Game.enemyShots[r][c] !== CELL_EMPTY)
        [r, c] = Game.botQueue.shift();
      if (Game.enemyShots[r][c] !== CELL_EMPTY)
        [r, c] = huntChessEmpty(Game.enemyShots);
    } else {
      [r, c] = huntChessEmpty(Game.enemyShots);
    }
  }

  if (r === undefined || c === undefined) return;

  const hit = Game.myBoard[r][c] === CELL_SHIP;
  Game.enemyShots[r][c] = hit ? CELL_HIT : CELL_MISS;

  if (hit) {
    Game.myBoard[r][c] = CELL_HIT;
    Game.botLastHit = {r, c};

    if (diff !== 'easy') {
      // Добавим соседей в очередь
      const neighbors = getNeighbors4(r, c).filter(([nr,nc]) => Game.enemyShots[nr][nc] === CELL_EMPTY);
      if (diff === 'hard' && Game.botDirection) {
        // Продолжаем в направлении
        const [dr, dc] = Game.botDirection;
        const fwd = [r+dr, c+dc], bwd = [r-dr, c-dc];
        Game.botQueue = [];
        if (inBounds(fwd[0],fwd[1]) && Game.enemyShots[fwd[0]][fwd[1]] === CELL_EMPTY)
          Game.botQueue.push(fwd);
        if (inBounds(bwd[0],bwd[1]) && Game.enemyShots[bwd[0]][bwd[1]] === CELL_EMPTY)
          Game.botQueue.push(bwd);
      } else {
        Game.botQueue.push(...neighbors);
        // Попытаемся угадать направление если 2+ попаданий подряд
        if (Game.botQueue.length === 0) Game.botDirection = null;
      }
    }

    const sunk = checkSunk(Game.myBoard, Game.myShips, r, c);
    if (sunk) {
      // Синхронизируем enemyShots
      for (let rr = 0; rr < BOARD_SIZE; rr++) {
        for (let cc = 0; cc < BOARD_SIZE; cc++) {
          if (Game.myBoard[rr][cc] === CELL_SUNK || Game.myBoard[rr][cc] === CELL_MISS)
            Game.enemyShots[rr][cc] = Game.myBoard[rr][cc];
        }
      }
      Game.botQueue = [];
      Game.botLastHit = null;
      Game.botDirection = null;
    }

    if (allSunk(Game.myShips)) {
      renderGameBoard();
      endGame('loss');
      return;
    }
    renderGameBoard();
    // Бот продолжает стрелять при попадании
    setTimeout(botShoot, 700 + Math.random()*500);
  } else {
    renderGameBoard();
    Game.isMyTurn = true;
    updateGameStatus();
    // Бот походил — переключаем обратно на поле врага для игрока
    setShowingField(true);
    renderGameBoard();
  }
}

function getEmptyCells(board) {
  const res = [];
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c < BOARD_SIZE; c++)
      if (board[r][c] === CELL_EMPTY) res.push([r, c]);
  return res;
}

function randomEmpty(board) {
  const e = getEmptyCells(board);
  return e[Math.floor(Math.random() * e.length)] || [0, 0];
}

function huntChessEmpty(board) {
  const chess = [];
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c < BOARD_SIZE; c++)
      if ((r + c) % 2 === 0 && board[r][c] === CELL_EMPTY) chess.push([r, c]);
  if (chess.length) return chess[Math.floor(Math.random() * chess.length)];
  return randomEmpty(board);
}

function getNeighbors4(r, c) {
  return [[r-1,c],[r+1,c],[r,c-1],[r,c+1]].filter(([nr,nc]) => inBounds(nr,nc));
}

/* ─── КОНЕЦ ИГРЫ ─────────────────────────────────── */
function endGame(result) {
  Game.active = false;
  const opp = Game.opponent?.name || 'Соперник';
  recordResult(result, Game.shots, Game.hits, opp);
  updateMenuStats();

  const icon    = { win:'🏆', loss:'💀', draw:'🤝' }[result];
  const title   = { win:'ПОБЕДА!', loss:'ПОРАЖЕНИЕ', draw:'НИЧЬЯ' }[result];
  const sub     = { win:'Все корабли потоплены!', loss:'Твои корабли уничтожены', draw:'Ничья!' }[result];
  const acc     = Game.shots ? Math.round(Game.hits/Game.shots*100)+'%' : '0%';

  setHTML('gameover-icon', icon);
  setText('gameover-title', title);
  setText('gameover-sub', sub);
  setText('go-shots', Game.shots);
  setText('go-hits', Game.hits);
  setText('go-acc', acc);

  if (result === 'win')  { Sound.win(); vibrate([50,30,100,30,200]); }
  if (result === 'loss') { Sound.lose(); vibrate([200]); }

  setTimeout(() => showScreen('gameover'), 800);
}

/* ─── FEEDBACK (не используется, оставлено для совместимости) ─ */
function showFeedback(text, color) {
  // Убрано по запросу — итак видно на поле
}

/* ─── WEBSOCKET: ОНЛАЙН ──────────────────────────── */
const WS = {
  socket: null,
  roomId: null,

  connect(serverUrl) {
    return new Promise((resolve, reject) => {
      try {
        // Динамически подключаем Socket.io-client
        if (!window.io) {
          const s = document.createElement('script');
          s.src = (serverUrl || 'http://localhost:3000') + '/socket.io/socket.io.js';
          s.onload = () => this._init(serverUrl, resolve, reject);
          s.onerror = () => reject(new Error('Не удалось подключиться к серверу'));
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
    this.socket.on('enemy_ready', () => WS.onEnemyReady());
    this.socket.on('turn', (data) => WS.onTurn(data));
    this.socket.on('shot_result', (data) => WS.onShotResult(data));
    this.socket.on('opponent_left', () => {
      showModal('Соперник вышел', 'Засчитана победа!', [
        { label: 'Ок', cls: 'btn-primary', action: () => { closeModal(); endGame('win'); } }
      ]);
    });
  },

  matchmake(mode, friendId) {
    if (!this.socket) return;
    this.socket.emit('matchmake', {
      type: 'matchmake',
      mode,
      friendId,
      playerId:   App.user.id,
      playerName: App.user.name,
    });
  },

  sendShips(field) {
    if (!this.socket) return;
    this.socket.emit('place_ships', { type: 'place_ships', field, roomId: this.roomId });
  },

  sendShot(r, c) {
    if (!this.socket) return;
    this.socket.emit('shoot', { type: 'shoot', roomId: this.roomId, r, c });
  },

  onMatched(data) {
    this.roomId = data.roomId;
    Game.roomId = data.roomId;
    Game.opponent = { name: data.opponent.name, id: data.opponent.id };
    document.getElementById('waiting-title').textContent = `Соперник найден: ${data.opponent.name}`;
    document.getElementById('waiting-sub').textContent  = 'Расставляй корабли!';
    setTimeout(() => startPlacement('online'), 1000);
  },

  onEnemyReady() {
    document.getElementById('waiting-title').textContent = 'Соперник готов!';
  },

  onTurn(data) {
    Game.isMyTurn = data.isMyTurn;
    updateGameStatus();
    renderGameBoard();
  },

  onShotResult(data) {
    const { r, c, hit, sunk, gameOver, winner } = data;
    if (data.shooter === App.user.id) {
      // Наш выстрел — результат
      Game.myShots[r][c] = hit ? (sunk ? CELL_SUNK : CELL_HIT) : CELL_MISS;
    } else {
      // Выстрел соперника по нам
      Game.myBoard[r][c] = hit ? (sunk ? CELL_SUNK : CELL_HIT) : CELL_MISS;
      Game.enemyShots[r][c] = Game.myBoard[r][c];
    }
    renderGameBoard();
    if (gameOver) {
      endGame(winner === App.user.id ? 'win' : 'loss');
    }
  },

  disconnect() {
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
  },
};

/* ─── РАССТАНОВКА ПЕРЕД ОНЛАЙН-ИГРОЙ ────────────── */
let pendingGameMode = null;

function startPlacement(mode) {
  pendingGameMode = mode;
  Placement.init();
  showScreen('placement');
}

/* ─── МОДАЛКА ────────────────────────────────────── */
function showModal(title, body, buttons=[]) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent  = body;
  const btnsEl = document.getElementById('modal-btns');
  btnsEl.innerHTML = '';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (b.cls || 'btn-secondary');
    btn.textContent = b.label;
    btn.addEventListener('click', b.action);
    btnsEl.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

/* ─── ЛОКАЛЬНОЕ ХРАНИЛИЩЕ ────────────────────────── */
function loadJSON(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
  catch(e) { return def; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); }
  catch(e) {}
}

/* ─── DOM УТИЛИТЫ ────────────────────────────────── */
function setText(id, val) { const el = document.getElementById(id); if(el) el.textContent = val; }
function setHTML(id, val) { const el = document.getElementById(id); if(el) el.innerHTML = val; }

/* ─── КНОПКА ЗВУКА ───────────────────────────────── */
function initSoundButton() {
  const btn = document.getElementById('btn-sound-toggle');
  if (!btn) return;

  function updateIcon() {
    const muted = !App.settings.sound;
    btn.classList.toggle('muted', muted);
    const waves = document.getElementById('sound-waves');
    if (waves) waves.style.display = muted ? 'none' : '';
    // Добавляем/убираем перечёркивание
    let line = btn.querySelector('.sound-mute-line');
    if (muted) {
      if (!line) {
        line = document.createElementNS('http://www.w3.org/2000/svg','line');
        line.setAttribute('class','sound-mute-line');
        line.setAttribute('x1','1'); line.setAttribute('y1','1');
        line.setAttribute('x2','23'); line.setAttribute('y2','23');
        btn.querySelector('svg').appendChild(line);
      }
    } else {
      line?.remove();
    }
  }

  btn.addEventListener('click', () => {
    App.settings.sound = !App.settings.sound;
    saveJSON('bs_settings', App.settings);
    // Синхронизируем чекбокс в настройках
    const cb = document.getElementById('setting-sound');
    if (cb) cb.checked = App.settings.sound;
    updateIcon();
    if (App.settings.sound) Sound.click();
  });

  updateIcon();
}


function initTelegram() {
  try {
    if (!window.Telegram?.WebApp) return;
    const tg = Telegram.WebApp;
    tg.ready();
    tg.expand();
    tg.setHeaderColor('secondary_bg_color');
    tg.enableClosingConfirmation();
  } catch(e) {}
}

/* ─── ПРИВЯЗКА КНОПОК НАВИГАЦИИ ─────────────────── */
function bindNav() {
  // Кнопки [data-screen="..."] — переход на экран
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-screen]');
    if (!btn) return;
    const screen = btn.dataset.screen;
    Sound.click();
    if (screen === 'leaderboard') { renderLeaderboard(); }
    if (screen === 'stats')       { renderStatsScreen(); }
    showScreen(screen);
  });

  // Режимы игры
  const modeMap = {
    'mode-bot-easy':   () => startBotGame('bot-easy'),
    'mode-bot-medium': () => startBotGame('bot-medium'),
    'mode-bot-hard':   () => startBotGame('bot-hard'),
    'mode-random':     () => startOnline('random'),
    'mode-friend':     () => startOnline('friend'),
  };
  Object.entries(modeMap).forEach(([id, fn]) => {
    document.getElementById(id)?.addEventListener('click', () => { Sound.click(); fn(); });
  });

  // Расстановка
  document.getElementById('btn-rotate')?.addEventListener('click', () => {
    Placement.vertical = !Placement.vertical;
    Sound.click();
  });
  document.getElementById('btn-random-place')?.addEventListener('click', () => {
    Placement.randomize();
  });
  document.getElementById('btn-clear-place')?.addEventListener('click', () => {
    Placement.clear();
  });
  document.getElementById('btn-ready')?.addEventListener('click', () => {
    if (!Placement.allPlaced()) return;
    Sound.click();
    const myShips = Placement.getShipsForGame();
    if (pendingGameMode === 'online') {
      // Отправляем расстановку на сервер и ждём соперника
      WS.sendShips(Placement.board);
      showScreen('waiting');
      document.getElementById('waiting-title').textContent = 'Ждём соперника…';
      document.getElementById('waiting-sub').textContent   = 'Соперник расставляет корабли';
    } else {
      startGame(pendingGameMode, Placement.board, myShips, null, null,
        { name: 'Бот', username: '' });
    }
  });

  // Переключатель поля в игре
  document.getElementById('btn-show-enemy')?.addEventListener('click', () => {
    Game.showingEnemy = true;
    document.getElementById('btn-show-enemy').classList.add('active');
    document.getElementById('btn-show-mine').classList.remove('active');
    renderGameBoard();
  });
  document.getElementById('btn-show-mine')?.addEventListener('click', () => {
    Game.showingEnemy = false;
    document.getElementById('btn-show-mine').classList.add('active');
    document.getElementById('btn-show-enemy').classList.remove('active');
    renderGameBoard();
  });

  // Сдаться
  document.getElementById('btn-surrender')?.addEventListener('click', () => {
    showModal('Сдаться?', 'Ты хочешь завершить игру?', [
      { label: 'Продолжить', cls: 'btn-ghost', action: closeModal },
      { label: 'Сдаться 🏳️', cls: 'btn-danger', action: () => { closeModal(); endGame('loss'); } },
    ]);
  });

  // Реванш
  document.getElementById('btn-rematch')?.addEventListener('click', () => {
    Sound.click();
    startPlacement(pendingGameMode || 'bot-medium');
  });

  // Копировать ссылку
  document.getElementById('btn-copy-link')?.addEventListener('click', () => {
    const text = document.getElementById('invite-link-text').textContent;
    navigator.clipboard?.writeText(text).then(() => {
      document.getElementById('btn-copy-link').textContent = 'Скопировано!';
      setTimeout(() => document.getElementById('btn-copy-link').textContent = 'Копировать', 2000);
    });
  });

  // Закрыть модалку по overlay
  document.getElementById('modal-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Кнопка отмены ожидания
  document.getElementById('btn-cancel-wait')?.addEventListener('click', () => {
    WS.disconnect();
    showScreen('menu');
  });
}

/* ─── ЗАПУСК ИГРЫ С БОТОМ ────────────────────────── */
function startBotGame(mode) {
  pendingGameMode = mode;
  Placement.init();
  showScreen('placement');
}

/* ─── ЗАПУСК ОНЛАЙН ИГРЫ ─────────────────────────── */
async function startOnline(mode) {
  showScreen('waiting');
  document.getElementById('waiting-title').textContent = 'Подключение…';
  document.getElementById('waiting-sub').textContent   = 'Соединяемся с сервером';

  const serverUrl = App.settings.server || window.location.origin;
  try {
    await WS.connect(serverUrl);
    document.getElementById('waiting-title').textContent = 'Ищем соперника…';
    document.getElementById('waiting-sub').textContent   = 'Это займёт несколько секунд';

    if (mode === 'friend') {
      const roomId = 'room_' + Date.now();
      const link = serverUrl + '/?room=' + roomId;
      document.getElementById('invite-block').classList.remove('hidden');
      document.getElementById('invite-link-text').textContent = link;
      WS.matchmake('friend', roomId);
    } else {
      WS.matchmake('random', null);
    }
  } catch(e) {
    showModal('Нет сервера', 'Онлайн недоступен. Сыграй с ботом?', [
      { label: 'С ботом',   cls: 'btn-primary', action: () => { closeModal(); startBotGame('bot-medium'); }},
      { label: 'В меню',    cls: 'btn-ghost',   action: () => { closeModal(); showScreen('menu'); }},
    ]);
  }
}

/* ─── ОБНОВЛЕНИЕ МЕНЮ ────────────────────────────── */
function updateMenuUI() {
  const u = App.user;
  setText('user-name', u.name);
  setText('user-tag',  u.username || (u.isGuest ? 'гость' : ''));
  const av = document.getElementById('user-avatar');
  if (av) {
    if (u.photo) {
      av.innerHTML = `<img src="${u.photo}" alt="" />`;
    } else {
      av.textContent = (u.name[0] || '?').toUpperCase();
    }
  }
  updateMenuStats();
}

/* ─── СТАРТ ──────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', async () => {
  initTelegram();
  initUser();
  initSettings();
  initStats();
  buildLabels();
  initHeroGrid();
  initSoundButton();
  bindNav();
  updateMenuUI();

  // Загрузочный экран
  await new Promise(r => setTimeout(r, 1200));
  showScreen('menu');

  // Проверим URL параметры (для приглашения по ссылке)
  const params = new URLSearchParams(window.location.search);
  const room   = params.get('room');
  if (room) {
    setTimeout(() => {
      showModal('Приглашение', 'Тебя пригласили в игру! Подключиться?', [
        { label: 'Подключиться', cls: 'btn-primary', action: () => {
            closeModal();
            startOnline('friend_' + room);
        }},
        { label: 'Отмена', cls: 'btn-ghost', action: closeModal },
      ]);
    }, 400);
  }
});
