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
const CELL_EMPTY = 0, CELL_SHIP = 1, CELL_HIT = 2, CELL_MISS = 3, CELL_SUNK = 4;

/* ─── СОСТОЯНИЕ ПРИЛОЖЕНИЯ ───────────────────────── */
const App = { user: null, settings: {}, stats: {}, history: [] };

/* ─── СОСТОЯНИЕ ИГРЫ ─────────────────────────────── */
const Game = {
  mode: null, myBoard: null, enemyBoard: null,
  myShots: null, enemyShots: null,
  myShips: [], enemyShips: [],
  isMyTurn: false, showingEnemy: true,
  active: false, roomId: null, opponent: null,
  shots: 0, hits: 0,
  botMode: 'hunt', botQueue: [], botLastHit: null, botDirection: null,
};

/* ─── ЗВУКИ ──────────────────────────────────────── */
const Sound = (() => {
  let ctx = null;
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }
  function beep(freq, type='sine', dur=0.12, vol=0.3) {
    if (!App.settings.sound) return;
    try {
      const c = getCtx(), osc = c.createOscillator(), g = c.createGain();
      osc.connect(g); g.connect(c.destination);
      osc.frequency.value = freq; osc.type = type;
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      osc.start(c.currentTime); osc.stop(c.currentTime + dur);
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

function vibrate(p=[30]) { if (App.settings.vibro && navigator.vibrate) navigator.vibrate(p); }

/* ─── УТИЛИТЫ ДОСКИ ─────────────────────────────── */
function makeBoard() { return Array.from({length:BOARD_SIZE},()=>new Array(BOARD_SIZE).fill(0)); }
function inBounds(r,c) { return r>=0&&r<BOARD_SIZE&&c>=0&&c<BOARD_SIZE; }
function cloneBoard(b) { return b.map(r=>[...r]); }
function canPlace(board,r,c,size,vert) {
  for (let i=0;i<size;i++) {
    const nr=vert?r+i:r, nc=vert?c:c+i;
    if (!inBounds(nr,nc)) return false;
    for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++) {
      const sr=nr+dr,sc=nc+dc;
      if (inBounds(sr,sc)&&board[sr][sc]!==0) return false;
    }
  }
  return true;
}
function placeShip(board,r,c,size,vert) {
  const cells=[];
  for (let i=0;i<size;i++) {
    const nr=vert?r+i:r,nc=vert?c:c+i;
    board[nr][nc]=CELL_SHIP; cells.push({r:nr,c:nc});
  }
  return cells;
}
function randomPlaceAll() {
  const board=makeBoard(), ships=[];
  for (const def of SHIP_DEFS) for (let k=0;k<def.count;k++) {
    let placed=false,tries=0;
    while (!placed&&tries++<500) {
      const vert=Math.random()<.5, r=Math.floor(Math.random()*BOARD_SIZE), c=Math.floor(Math.random()*BOARD_SIZE);
      if (canPlace(board,r,c,def.size,vert)) {
        ships.push({cells:placeShip(board,r,c,def.size,vert),sunk:false,size:def.size,vertical:vert});
        placed=true;
      }
    }
  }
  return {board,ships};
}
function checkSunk(board,ships,r,c) {
  for (const ship of ships) {
    if (ship.sunk) continue;
    if (!ship.cells.some(cc=>cc.r===r&&cc.c===c)) continue;
    if (ship.cells.every(cc=>board[cc.r][cc.c]===CELL_HIT)) {
      ship.sunk=true;
      ship.cells.forEach(cc=>{
        board[cc.r][cc.c]=CELL_SUNK;
        for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++) {
          const nr=cc.r+dr,nc=cc.c+dc;
          if (inBounds(nr,nc)&&board[nr][nc]===CELL_EMPTY) board[nr][nc]=CELL_MISS;
        }
      });
      return ship;
    }
  }
  return null;
}
function allSunk(ships) { return ships.every(s=>s.sunk); }

/* ─── НАВИГАЦИЯ ──────────────────────────────────── */
let currentScreen='loading';
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  const el=document.getElementById('screen-'+name);
  if (el) el.classList.add('active');
  currentScreen=name;
}

/* ─── ПРОФИЛЬ ────────────────────────────────────── */
function initUser() {
  let tgUser=null;
  try { if (window.Telegram?.WebApp?.initDataUnsafe?.user) tgUser=Telegram.WebApp.initDataUnsafe.user; } catch(e){}
  const saved=loadJSON('bs_user',null);
  if (tgUser) {
    App.user={id:tgUser.id,name:tgUser.first_name||'Игрок',
      username:tgUser.username?'@'+tgUser.username:'',photo:tgUser.photo_url||null,isGuest:false};
  } else if (saved) {
    App.user=saved;
  } else {
    App.user={id:'guest_'+Date.now(),name:'Гость',username:'',photo:null,isGuest:true};
  }
  saveJSON('bs_user',App.user);
}
function initSettings() {
  App.settings=loadJSON('bs_settings',{sound:true,vibro:true,hints:true,anim:true,server:''});
  ['sound','vibro','hints','anim'].forEach(id=>{
    const el=document.getElementById('setting-'+id);
    if (el) { el.checked=!!App.settings[id]; el.addEventListener('change',()=>{App.settings[id]=el.checked;saveJSON('bs_settings',App.settings);}); }
  });
  const srv=document.getElementById('setting-server');
  if (srv) { srv.value=App.settings.server||''; srv.addEventListener('change',()=>{App.settings.server=srv.value.trim();saveJSON('bs_settings',App.settings);}); }
  document.getElementById('btn-reset-stats')?.addEventListener('click',()=>{
    showModal('Сбросить статистику?','Все данные о победах и боях будут удалены.',[
      {label:'Отмена',cls:'btn-ghost',action:closeModal},
      {label:'Сбросить',cls:'btn-danger',action:()=>{
        App.stats=defaultStats();App.history=[];
        saveJSON('bs_stats',App.stats);saveJSON('bs_history',App.history);
        updateMenuStats();closeModal();
      }},
    ]);
  });
}
function defaultStats() { return {wins:0,losses:0,draws:0,totalShots:0,totalHits:0}; }
function initStats() { App.stats=loadJSON('bs_stats',defaultStats()); App.history=loadJSON('bs_history',[]); }
function recordResult(result,shots,hits,opp) {
  App.stats[result==='win'?'wins':result==='loss'?'losses':'draws']++;
  App.stats.totalShots+=shots; App.stats.totalHits+=hits;
  saveJSON('bs_stats',App.stats);
  App.history.unshift({result,opponent:opp||'Неизвестно',shots,hits,date:Date.now()});
  if (App.history.length>50) App.history.pop();
  saveJSON('bs_history',App.history);
}
function updateMenuStats() {
  setText('stat-wins',App.stats.wins);
  setText('stat-total',App.stats.wins+App.stats.losses+App.stats.draws);
}

/* ─── ЛИДЕРБОРД / СТАТИСТИКА ────────────────────── */
function renderLeaderboard() {
  const list=document.getElementById('leaderboard-list');
  if (!list) return;
  let lb=loadJSON('bs_leaderboard',[]);
  const localEntry={...App.user,wins:App.stats.wins};
  const idx=lb.findIndex(e=>e.id===App.user.id);
  if (idx>=0) lb[idx]=localEntry; else lb.push(localEntry);
  lb.sort((a,b)=>b.wins-a.wins); lb=lb.slice(0,10);
  saveJSON('bs_leaderboard',lb);
  const medals=['gold','silver','bronze'];
  list.innerHTML='';
  if (!lb.length){list.innerHTML='<div class="empty-state">Пока никого нет</div>';return;}
  lb.forEach((e,i)=>{
    const d=document.createElement('div'); d.className='lb-item';
    const isMe=e.id===App.user.id?' <span class="me-tag">(вы)</span>':'';
    d.innerHTML=
      `<div class="lb-rank ${medals[i]||''}">${i<3?['🥇','🥈','🥉'][i]:i+1}</div> `+
      `<div class="lb-avatar">${(e.name||'?')[0].toUpperCase()}</div> `+
      `<div class="lb-info"><strong>${e.name||'Игрок'} ${isMe}</strong><small>${e.username||''}</small></div> `+
      `<div class="lb-wins">${e.wins}</div>`
    ;
    list.appendChild(d);
  });
}
function renderStatsScreen() {
  const s=App.stats,total=s.wins+s.losses+s.draws;
  setHTML('stats-avatar',App.user.name[0]?.toUpperCase()||'?');
  setText('stats-name',App.user.name);
  setText('st-wins',s.wins);setText('st-losses',s.losses);setText('st-draws',s.draws);
  setText('st-total',total);
  setText('st-acc',s.totalShots?Math.round(s.totalHits/s.totalShots*100)+'%':'0%');
  setText('st-winrate',total?Math.round(s.wins/total*100)+'%':'0%');
  const hl=document.getElementById('history-list');
  if (!hl) return;
  hl.innerHTML='';
  if (!App.history.length){hl.innerHTML='<div class="empty-state">Ещё нет сыгранных боёв</div>';return;}
  App.history.slice(0,20).forEach(h=>{
    const d=document.createElement('div'); d.className='history-item';
    const icons={win:'✅',loss:'❌',draw:'🤝'}, labels={win:'Победа',loss:'Поражение',draw:'Ничья'};
    const time=new Date(h.date).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
    d.innerHTML=
      `<div class="history-icon">${icons[h.result]}</div> `+
      `<div class="history-info">${labels[h.result]} — ${h.opponent}<span>Выстрелов: ${h.shots}, Попаданий: ${h.hits}</span></div> `+
      `<div class="history-time">${time}</div>`
    ;
    hl.appendChild(d);
  });
}

/* ─── ДОСКА: ОТРИСОВКА ───────────────────────────── */
function renderBoard(boardEl, data, opts={}) {
  boardEl.innerHTML='';
  const {clickable,onCellClick,showShips}=opts;
  for (let r=0;r<BOARD_SIZE;r++) for (let c=0;c<BOARD_SIZE;c++) {
    const cell=document.createElement('div');
    cell.className='cell'; cell.dataset.r=r; cell.dataset.c=c;
    const val=data[r][c];
    if (val===CELL_SHIP&&showShips) cell.classList.add('ship');
    if (val===CELL_HIT)  cell.classList.add('hit');
    if (val===CELL_MISS) cell.classList.add('miss');
    if (val===CELL_SUNK) cell.classList.add('sunk');
    if (clickable&&val===CELL_EMPTY) {
      cell.classList.add('hoverable');
      cell.addEventListener('click',()=>onCellClick(r,c));
    }
    boardEl.appendChild(cell);
  }
}
function buildLabels() {
  ['placement','game','game-enemy'].forEach(prefix=>{
    const row=document.getElementById(prefix+'-row-labels');
    const col=document.getElementById(prefix+'-col-labels');
    if (!row||!col) return;
    row.innerHTML='';
    COLS.split('').forEach(l=>{const d=document.createElement('div');d.className='board-label';d.textContent=l;row.appendChild(d);});
    col.innerHTML='';
    for (let i=1;i<=10;i++){const d=document.createElement('div');d.className='board-label';d.textContent=i;col.appendChild(d);}
  });
}

/* ─── HERO GRID ──────────────────────────────────── */
function initHeroGrid() {
  const grid=document.getElementById('hero-grid');
  if (!grid) return;
  const cells=[];
  for (let i=0;i<60;i++){const d=document.createElement('div');d.className='hero-grid-cell';grid.appendChild(d);cells.push(d);}
  setInterval(()=>{
    const cls=Math.random()<.3?'hit':'active';
    const idx=Math.floor(Math.random()*cells.length);
    cells[idx].classList.add(cls);
    setTimeout(()=>cells[idx].classList.remove(cls,'active','hit'),600+Math.random()*800);
  },200);
}

/* ─── РАССТАНОВКА ────────────────────────────────── */
const Placement = {
  board:null, ships:[], selected:null, vertical:false,
  _drag:null, _lastTap:{},
  init() {
    this.board=makeBoard(); this.ships=[]; this.selected=null; this.vertical=false;
    this._drag=null; this._lastTap={};
    let id=0;
    for (const def of SHIP_DEFS) for (let k=0;k<def.count;k++)
      this.ships.push({id:id++,size:def.size,placed:false,vertical:false,cells:[]});
    this.renderDock(); this.renderBoard();
  },
  renderDock() {
    const dock=document.getElementById('ship-dock');
    if (!dock) return;
    dock.innerHTML='';
    this.ships.forEach(ship=>{
      const wrap=document.createElement('div');
      wrap.className='ship-piece'+(ship.placed?' placed':'')+(this.selected?.id===ship.id?' selected':'')+(ship.vertical?' vertical':'');
      wrap.dataset.id=ship.id;
      for (let i=0;i<ship.size;i++){const c=document.createElement('div');c.className='ship-cell';wrap.appendChild(c);}
      if (!ship.placed) {
        wrap.addEventListener('click',()=>{ if (this._drag?._wasDrag) return; this.selectShip(ship.id); });
        wrap.addEventListener('touchend',(e)=>this._handleDoubleTap(e,ship.id));
        wrap.addEventListener('dblclick',(e)=>{e.preventDefault();this.rotateSingleShip(ship.id);});
        wrap.addEventListener('mousedown',(e)=>this._startDrag(e,ship,wrap));
        wrap.addEventListener('touchstart',(e)=>this._startDragTouch(e,ship,wrap),{passive:false});
      }
      dock.appendChild(wrap);
    });
  },
  selectShip(id) { this.selected=this.ships.find(s=>s.id===id)||null; Sound.click(); this.renderDock(); },
  rotateSingleShip(id) {
    const ship=this.ships.find(s=>s.id===id);
    if (!ship||ship.placed) return;
    if (this.selected?.id!==id) this.selectShip(id);
    this.vertical=!this.vertical;
    Sound.click(); vibrate([10]); this.renderDock();
  },
  _handleDoubleTap(e,id) {
    const now=Date.now(),last=this._lastTap[id]||0;
    if (now-last<350){e.preventDefault();this.rotateSingleShip(id);this._lastTap[id]=0;}
    else this._lastTap[id]=now;
  },
  _startDrag(e,ship,el) {
    if (e.button!==0) return; e.preventDefault();
    this._drag={ship,el,_wasDrag:false};
    this._drag._onMove=(ev)=>this._moveDrag(ev.clientX,ev.clientY);
    this._drag._onUp=(ev)=>this._endDrag(ev.clientX,ev.clientY);
    document.addEventListener('mousemove',this._drag._onMove);
    document.addEventListener('mouseup',this._drag._onUp);
    this.selectShip(ship.id);
  },
  _moveDrag(cx,cy){if(!this._drag)return;this._drag._wasDrag=true;this._highlightCellUnder(cx,cy);},
  _endDrag(cx,cy){
    if(!this._drag)return;
    document.removeEventListener('mousemove',this._drag._onMove);
    document.removeEventListener('mouseup',this._drag._onUp);
    this._tryPlaceAt(cx,cy);this._drag=null;this.clearPreview();
  },
  _startDragTouch(e,ship,el){
    const t=e.touches[0];
    this._drag={ship,el,startX:t.clientX,startY:t.clientY,_wasDrag:false,
      _onMove:(ev)=>{
        ev.preventDefault();
        const tt=ev.touches[0],dx=tt.clientX-this._drag.startX,dy=tt.clientY-this._drag.startY;
        if (!this._drag._wasDrag&&Math.hypot(dx,dy)>8){this._drag._wasDrag=true;this.selectShip(ship.id);}
        if (this._drag._wasDrag) this._highlightCellUnder(tt.clientX,tt.clientY);
      },
      _onEnd:(ev)=>{
        const tt=ev.changedTouches[0];
        document.removeEventListener('touchmove',this._drag._onMove);
        document.removeEventListener('touchend',this._drag._onEnd);
        if (this._drag._wasDrag) this._tryPlaceAt(tt.clientX,tt.clientY);
        this._drag=null;this.clearPreview();
      },
    };
    document.addEventListener('touchmove',this._drag._onMove,{passive:false});
    document.addEventListener('touchend',this._drag._onEnd);
  },
  _highlightCellUnder(cx,cy){
    this.clearPreview();if(!this.selected)return;
    const rc=this._getCellFromPoint(cx,cy);if(!rc)return;
    const{r,c}=rc,valid=canPlace(this.board,r,c,this.selected.size,this.vertical);
    for(let i=0;i<this.selected.size;i++){
      const nr=this.vertical?r+i:r,nc=this.vertical?c:c+i;
      if(!inBounds(nr,nc))continue;
      const cell=document.querySelector(`#placement-board [data-r="${nr}"][data-c="${nc}"]`);
      if(cell)cell.classList.add(valid?'preview':'invalid');
    }
  },
  _tryPlaceAt(cx,cy){
    if(!this.selected)return;
    const rc=this._getCellFromPoint(cx,cy);if(!rc)return;
    const{r,c}=rc;
    if(!canPlace(this.board,r,c,this.selected.size,this.vertical)){vibrate([20,10,20]);return;}
    this._placeSelectedAt(r,c);
  },
  _getCellFromPoint(cx,cy){
    const el=document.elementFromPoint(cx,cy);if(!el)return null;
    const cell=el.closest('[data-r][data-c]');if(!cell)return null;
    const boardEl=document.getElementById('placement-board');
    if(!boardEl||!boardEl.contains(cell))return null;
    return{r:+cell.dataset.r,c:+cell.dataset.c};
  },
  _placeSelectedAt(r,c){
    if(!this.selected)return;
    this.selected.vertical=this.vertical;
    this.selected.cells=placeShip(this.board,r,c,this.selected.size,this.vertical);
    this.selected.placed=true;
    this.selected=this.ships.find(s=>!s.placed)||null;
    Sound.place();vibrate([15]);this.renderDock();this.renderBoard();
  },
  renderBoard(){
    const boardEl=document.getElementById('placement-board');if(!boardEl)return;
    boardEl.innerHTML='';
    for(let r=0;r<BOARD_SIZE;r++) for(let c=0;c<BOARD_SIZE;c++){
      const cell=document.createElement('div');
      cell.className='cell';cell.dataset.r=r;cell.dataset.c=c;
      if(this.board[r][c]===CELL_SHIP)cell.classList.add('ship');
      cell.addEventListener('click',()=>this.handleCellClick(r,c));
      cell.addEventListener('mouseenter',()=>this.handleHover(r,c));
      cell.addEventListener('mouseleave',()=>{if(!this._drag?._wasDrag)this.clearPreview();});
      boardEl.appendChild(cell);
    }
    const ready=document.getElementById('btn-ready');
    if(ready)ready.disabled=!this.allPlaced();
  },
  handleHover(r,c){
    if(this._drag?._wasDrag)return;if(!this.selected)return;
    this.clearPreview();
    const valid=canPlace(this.board,r,c,this.selected.size,this.vertical);
    for(let i=0;i<this.selected.size;i++){
      const nr=this.vertical?r+i:r,nc=this.vertical?c:c+i;
      if(!inBounds(nr,nc))continue;
      const cell=document.querySelector(`#placement-board [data-r="${nr}"][data-c="${nc}"]`);
      if(cell)cell.classList.add(valid?'preview':'invalid');
    }
  },
  clearPreview(){document.querySelectorAll('#placement-board .preview,#placement-board .invalid').forEach(c=>c.classList.remove('preview','invalid'));},
  handleCellClick(r,c){
    if(this._drag?._wasDrag)return;if(!this.selected)return;
    if(!canPlace(this.board,r,c,this.selected.size,this.vertical)){vibrate([20,10,20]);return;}
    this._placeSelectedAt(r,c);
  },
  clear(){
    this.board=makeBoard();
    this.ships.forEach(s=>{s.placed=false;s.cells=[];s.vertical=false;});
    this.selected=this.ships[0]||null;this.vertical=false;
    this.renderDock();this.renderBoard();
  },
  randomize(){
    const{board,ships}=randomPlaceAll();this.board=board;
    this.ships.forEach((s,i)=>{s.placed=true;s.cells=ships[i]?.cells||[];s.vertical=ships[i]?.vertical||false;});
    this.selected=null;Sound.place();this.renderDock();this.renderBoard();
  },
  allPlaced(){return this.ships.every(s=>s.placed);},
  getShipsForGame(){return this.ships.map(s=>({cells:[...s.cells],sunk:false,size:s.size}));},
};

/* ─── ИГРА ───────────────────────────────────────── */
function startGame(mode, myBoard, myShips, isMyTurn, opponent) {
  Game.mode         = mode;
  Game.myBoard      = cloneBoard(myBoard);
  Game.myShips      = JSON.parse(JSON.stringify(myShips));
  Game.enemyBoard   = makeBoard();
  Game.enemyShips   = [];
  Game.myShots      = makeBoard();
  Game.enemyShots   = makeBoard();
  Game.isMyTurn     = isMyTurn !== undefined ? isMyTurn : true;
  Game.showingEnemy = true;
  Game.active       = true;
  Game.shots        = 0;
  Game.hits         = 0;
  Game.opponent     = opponent || {name:'Бот',username:''};
  
  if (mode.startsWith('bot')) {
    const r = randomPlaceAll();
    Game.enemyBoard = r.board;
    Game.enemyShips = r.ships;
    Game.botMode='hunt'; Game.botQueue=[]; Game.botLastHit=null; Game.botDirection=null;
  }
  
  setText('opp-name', opponent?.name||'Бот');
  renderGameBoard();
  updateEnemyFleet();
  showScreen('game');
  updateGameStatus();
}

/* ─── РЕНДЕР ДОСКИ В ИГРЕ ────────────────────────── */
function renderGameBoard() {
  const isDesktop = window.innerWidth >= 1024;
  
  if (isDesktop) {
    renderMyBoard();
    renderEnemyBoard();
    document.getElementById('game-boards-container')?.classList.add('desktop-layout');
    document.getElementById('btn-show-enemy')?.classList.add('hidden');
    document.getElementById('btn-show-mine')?.classList.add('hidden');
  } else {
    document.getElementById('game-boards-container')?.classList.remove('desktop-layout');
    document.getElementById('btn-show-enemy')?.classList.remove('hidden');
    document.getElementById('btn-show-mine')?.classList.remove('hidden');
    
    const boardEl = document.getElementById('game-board');
    if (!boardEl) return;
    if (Game.showingEnemy) {
      const display = makeBoard();
      for (let r=0;r<BOARD_SIZE;r++) for (let c=0;c<BOARD_SIZE;c++) {
        const s=Game.myShots[r][c];
        if(s===CELL_HIT||s===CELL_MISS||s===CELL_SUNK) display[r][c]=s;
      }
      renderBoard(boardEl, display, {
        clickable: Game.isMyTurn,
        showShips: false,
        onCellClick: (r,c)=>playerShoot(r,c),
      });
    } else {
      const display=cloneBoard(Game.myBoard);
      for (let r=0;r<BOARD_SIZE;r++) for (let c=0;c<BOARD_SIZE;c++) {
        const s=Game.enemyShots[r][c];
        if(s===CELL_HIT||s===CELL_MISS||s===CELL_SUNK) display[r][c]=s;
      }
      renderBoard(boardEl, display, {clickable:false,showShips:true});
    }
  }
  updateShipsLeft();
  updateEnemyFleet();
}

function renderMyBoard() {
  const boardEl = document.getElementById('game-board-my');
  if (!boardEl) return;
  const display = cloneBoard(Game.myBoard);
  for (let r=0;r<BOARD_SIZE;r++) for (let c=0;c<BOARD_SIZE;c++) {
    const s=Game.enemyShots[r][c];
    if(s===CELL_HIT||s===CELL_MISS||s===CELL_SUNK) display[r][c]=s;
  }
  const isOpponentTurn = !Game.isMyTurn;
  boardEl.classList.toggle('board-inactive', isOpponentTurn);
  renderBoard(boardEl, display, {clickable:false,showShips:true});
}

function renderEnemyBoard() {
  const boardEl = document.getElementById('game-board-enemy');
  if (!boardEl) return;
  const display = makeBoard();
  for (let r=0;r<BOARD_SIZE;r++) for (let c=0;c<BOARD_SIZE;c++) {
    const s=Game.myShots[r][c];
    if(s===CELL_HIT||s===CELL_MISS||s===CELL_SUNK) display[r][c]=s;
  }
  renderBoard(boardEl, display, {
    clickable: Game.isMyTurn,
    showShips: false,
    onCellClick: (r,c)=>playerShoot(r,c),
  });
}

function setShowingField(showEnemy) {
  Game.showingEnemy=showEnemy;
  document.getElementById('btn-show-enemy')?.classList.toggle('active',showEnemy);
  document.getElementById('btn-show-mine')?.classList.toggle('active',!showEnemy);
}

function updateGameStatus() {
  const el=document.getElementById('game-status');
  if (!el||!Game.active) return;
  el.textContent=Game.isMyTurn?'Твой ход':'Ход соперника';
  el.style.color=Game.isMyTurn?'var(--green)':'var(--hint)';
  
  const isDesktop = window.innerWidth >= 1024;
  if (isDesktop) {
    document.getElementById('game-board-my')?.classList.toggle('board-inactive',!Game.isMyTurn);
    document.getElementById('game-board-enemy')?.classList.toggle('board-clickable',Game.isMyTurn);
  }
}

function updateShipsLeft() {
  const myAlive=Game.myShips.filter(s=>!s.sunk).length;
  const enAlive=Game.enemyShips.filter(s=>!s.sunk).length;
  setText('my-ships-left',`${myAlive}`);
  setText('enemy-ships-left',`${enAlive}`);
}

function updateEnemyFleet() {
  const container=document.getElementById('enemy-fleet-ships');
  if (!container) return;
  container.innerHTML='';
  const sorted=[...Game.enemyShips].sort((a,b)=>b.size-a.size);
  sorted.forEach(ship=>{
    const wrap=document.createElement('div');
    wrap.className='fleet-ship'+(ship.sunk?' sunk':'');
    for (let i=0;i<ship.size;i++){const c=document.createElement('div');c.className='fleet-cell';wrap.appendChild(c);}
    container.appendChild(wrap);
  });
}

/* ─── ВЫСТРЕЛ ИГРОКА ─────────────────────────────── */
function playerShoot(r,c) {
  if (!Game.active||!Game.isMyTurn) return;
  if (Game.myShots[r][c]!==CELL_EMPTY) return;
  
  Game.shots++;
  const hit=Game.enemyBoard[r][c]===CELL_SHIP;
  Game.myShots[r][c]=hit?CELL_HIT:CELL_MISS;
  Game.enemyBoard[r][c]=hit?CELL_HIT:CELL_MISS;
  
  if (hit) {
    Game.hits++;
    Sound.hit();vibrate([30,10,30]);
    const sunk=checkSunk(Game.enemyBoard,Game.enemyShips,r,c);
    if(sunk){
      Sound.sunk();vibrate([50,20,50,20,50]);
      for(let rr=0;rr<BOARD_SIZE;rr++)for(let cc=0;cc<BOARD_SIZE;cc++){
        if(Game.enemyBoard[rr][cc]===CELL_SUNK||Game.enemyBoard[rr][cc]===CELL_MISS)
          Game.myShots[rr][cc]=Game.enemyBoard[rr][cc];
      }
    }
    if (allSunk(Game.enemyShips)){endGame('win');return;}
    if (Game.mode==='online') WS.sendShot(r,c);
    setShowingField(true);renderGameBoard();
  } else {
    Sound.miss();vibrate([10]);
    Game.isMyTurn=false;
    if (Game.mode==='online') WS.sendShot(r,c);
    updateGameStatus();
    setShowingField(false);renderGameBoard();
    if (Game.mode.startsWith('bot')) setTimeout(botShoot,800+Math.random()*600);
  }
}

/* ─── БОТ ────────────────────────────────────────── */
function botGetDiff(){return Game.mode==='bot-easy'?'easy':Game.mode==='bot-medium'?'medium':'hard';}
function botShoot() {
  if (!Game.active||Game.isMyTurn) return;
  const diff=botGetDiff();
  let r,c;
  
  if (diff==='easy'){
    const e=getEmptyCells(Game.enemyShots);if(!e.length)return;
    [r,c]=e[Math.floor(Math.random()*e.length)];
  } else if (diff==='medium'){
    if(Game.botQueue.length){
      [r,c]=Game.botQueue.shift();
      while(Game.enemyShots[r][c]!==CELL_EMPTY){
        if(!Game.botQueue.length){[r,c]=randomEmpty(Game.enemyShots);break;}
        [r,c]=Game.botQueue.shift();
      }
    } else [r,c]=randomEmpty(Game.enemyShots);
  } else {
    if(Game.botQueue.length){
      [r,c]=Game.botQueue.shift();
      while(Game.botQueue.length&&Game.enemyShots[r][c]!==CELL_EMPTY)[r,c]=Game.botQueue.shift();
      if(Game.enemyShots[r][c]!==CELL_EMPTY)[r,c]=huntChessEmpty(Game.enemyShots);
    } else [r,c]=huntChessEmpty(Game.enemyShots);
  }
  
  if(r===undefined||c===undefined)return;
  const hit=Game.myBoard[r][c]===CELL_SHIP;
  Game.enemyShots[r][c]=hit?CELL_HIT:CELL_MISS;
  
  if(hit){
    Game.myBoard[r][c]=CELL_HIT;Game.botLastHit={r,c};
    if(diff!=='easy'){
      const nb=getNeighbors4(r,c).filter(([nr,nc])=>Game.enemyShots[nr][nc]===CELL_EMPTY);
      if(diff==='hard'&&Game.botDirection){
        const[dr,dc]=Game.botDirection,fwd=[r+dr,c+dc],bwd=[r-dr,c-dc];
        Game.botQueue=[];
        if(inBounds(fwd[0],fwd[1])&&Game.enemyShots[fwd[0]][fwd[1]]===CELL_EMPTY)Game.botQueue.push(fwd);
        if(inBounds(bwd[0],bwd[1])&&Game.enemyShots[bwd[0]][bwd[1]]===CELL_EMPTY)Game.botQueue.push(bwd);
      } else {Game.botQueue.push(...nb);if(!Game.botQueue.length)Game.botDirection=null;}
    }
    const sunk=checkSunk(Game.myBoard,Game.myShips,r,c);
    if(sunk){
      for(let rr=0;rr<BOARD_SIZE;rr++)for(let cc=0;cc<BOARD_SIZE;cc++){
        if(Game.myBoard[rr][cc]===CELL_SUNK||Game.myBoard[rr][cc]===CELL_MISS)Game.enemyShots[rr][cc]=Game.myBoard[rr][cc];
      }
      Game.botQueue=[];Game.botLastHit=null;Game.botDirection=null;
    }
    if(allSunk(Game.myShips)){renderGameBoard();endGame('loss');return;}
    renderGameBoard();setTimeout(botShoot,700+Math.random()*500);
  } else {
    renderGameBoard();Game.isMyTurn=true;updateGameStatus();setShowingField(true);renderGameBoard();
  }
}

function getEmptyCells(b){const r=[];for(let i=0;i<BOARD_SIZE;i++)for(let j=0;j<BOARD_SIZE;j++)if(b[i][j]===CELL_EMPTY)r.push([i,j]);return r;}
function randomEmpty(b){const e=getEmptyCells(b);return e[Math.floor(Math.random()*e.length)]||[0,0];}
function huntChessEmpty(b){const c=[];for(let r=0;r<BOARD_SIZE;r++)for(let cc=0;cc<BOARD_SIZE;cc++)if((r+cc)%2===0&&b[r][cc]===CELL_EMPTY)c.push([r,cc]);return c.length?c[Math.floor(Math.random()*c.length)]:randomEmpty(b);}
function getNeighbors4(r,c){return[[r-1,c],[r+1,c],[r,c-1],[r,c+1]].filter(([nr,nc])=>inBounds(nr,nc));}

/* ─── КОНЕЦ ИГРЫ ─────────────────────────────────── */
function endGame(result) {
  Game.active=false;
  recordResult(result,Game.shots,Game.hits,Game.opponent?.name||'Соперник');
  updateMenuStats();
  const icons={win:'🏆',loss:'💀',draw:'🤝'};
  const titles={win:'ПОБЕДА!',loss:'ПОРАЖЕНИЕ',draw:'НИЧЬЯ'};
  const subs={win:'Все корабли потоплены!',loss:'Твои корабли уничтожены',draw:'Ничья!'};
  setHTML('gameover-icon',icons[result]);
  setText('gameover-title',titles[result]);
  setText('gameover-sub',subs[result]);
  setText('go-shots',Game.shots);setText('go-hits',Game.hits);
  setText('go-acc',Game.shots?Math.round(Game.hits/Game.shots*100)+'%':'0%');
  if(result==='win'){Sound.win();vibrate([50,30,100,30,200]);}
  if(result==='loss'){Sound.lose();vibrate([200]);}
  setTimeout(()=>showScreen('gameover'),800);
}

/* ─── WEBSOCKET ──────────────────────────────────── */
const WS = {
  socket: null,
  roomId: null,
  connect(serverUrl) {
    return new Promise((resolve, reject) => {
      try {
        if (!window.io) {
          const s=document.createElement('script');
          s.src=(serverUrl||window.location.origin)+'/socket.io/socket.io.js';
          s.onload=()=>this._init(serverUrl,resolve,reject);
          s.onerror=()=>reject(new Error('Не удалось загрузить Socket.io'));
          document.head.appendChild(s);
        } else {
          this._init(serverUrl,resolve,reject);
        }
      } catch(e){reject(e);}
    });
  },
  _init(serverUrl, resolve, reject) {
    this.socket=io(serverUrl||window.location.origin,{transports:['websocket','polling']});
    this.socket.on('connect',()=>resolve());
    this.socket.on('connect_error',()=>reject(new Error('Ошибка подключения')));
    this.socket.on('disconnect',()=>{
      if(Game.active) showModal('Соединение потеряно','Игра прервана.',[
        {label:'В меню',cls:'btn-primary',action:()=>{closeModal();showScreen('menu');}},
      ]);
    });
    
    // ОБА игрока получают matched и идут в расстановку
    this.socket.on('matched', (data)=>{
      this.roomId=data.roomId;
      Game.roomId=data.roomId;
      Game.opponent={name:data.opponent.name,id:data.opponent.id};
      startPlacement('online');
    });
    
    // Создатель комнаты получает ссылку
    this.socket.on('friend_room_created', (data)=>{
      this.roomId=data.roomId;
      const serverUrl=App.settings.server||window.location.origin;
      const link=serverUrl+'/?room='+data.roomId;
      document.getElementById('invite-link-text').textContent=link;
      document.getElementById('invite-block').classList.remove('hidden');
      setText('waiting-title','Ожидаем соперника…');
      setText('waiting-sub','Поделись ссылкой с другом');
      showScreen('waiting');
    });
    
    // Соперник подключился
    this.socket.on('opponent_joined', (data)=>{
      setText('waiting-sub','Соперник подключился!');
    });
    
    this.socket.on('join_error',(data)=>{
      showModal('Ошибка',''+data.message,[
        {label:'В меню',cls:'btn-primary',action:()=>{closeModal();showScreen('menu');}},
      ]);
    });
    
    // Игрок подтвердил готовность
    this.socket.on('my_ready_confirmed',()=>{
      setText('waiting-title','Готов!');
      setText('waiting-sub','Ждём соперника…');
      showScreen('waiting');
    });
    
    // Соперник готов
    this.socket.on('enemy_ready',()=>{
      setText('waiting-sub','Соперник готов!');
    });
    
    // Игра началась
    this.socket.on('game_start',(data)=>{
      const myShips=Placement.getShipsForGame();
      startGame('online', Placement.board, myShips, data.isMyTurn,
        {name:data.opponentName||Game.opponent?.name||'Соперник'});
    });
    
    // Результат выстрела
    this.socket.on('shot_result',(data)=>{
      const{r,c,hit,sunk,shooter,gameOver,winner}=data;
      if (shooter===App.user.id) {
        if (gameOver) { endGame(winner===App.user.id?'win':'loss'); }
      } else {
        const cellVal=sunk?CELL_SUNK:hit?CELL_HIT:CELL_MISS;
        Game.myBoard[r][c]=cellVal;
        Game.enemyShots[r][c]=cellVal;
        if(sunk){
          for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
            const nr=r+dr,nc=c+dc;
            if(inBounds(nr,nc)&&Game.myBoard[nr][nc]===CELL_EMPTY){
              Game.myBoard[nr][nc]=CELL_MISS;Game.enemyShots[nr][nc]=CELL_MISS;
            }
          }
        }
        renderGameBoard();
        if(gameOver){endGame(winner===App.user.id?'win':'loss');}
      }
    });
    
    // Ход передан
    this.socket.on('turn',(data)=>{
      Game.isMyTurn=data.isMyTurn;
      updateGameStatus();
      setShowingField(data.isMyTurn);
      renderGameBoard();
    });
    
    // Соперник вышел
    this.socket.on('opponent_left',()=>{
      showModal('Соперник вышел','Засчитана победа!',[
        {label:'Ок',cls:'btn-primary',action:()=>{closeModal();endGame('win');}},
      ]);
    });
  },
  sendShot(r,c){if(this.socket&&Game.roomId)this.socket.emit('shoot',{roomId:Game.roomId,r,c});},
  sendShips(field){if(this.socket&&Game.roomId)this.socket.emit('place_ships',{roomId:Game.roomId,field});},
  disconnect(){if(this.socket){this.socket.disconnect();this.socket=null;}this.roomId=null;},
};

/* ─── РАССТАНОВКА: старт ─────────────────────────── */
let pendingGameMode=null;
function startPlacement(mode){
  pendingGameMode=mode;
  Placement.init();
  showScreen('placement');
}

/* ─── ОНЛАЙН СТАРТ ───────────────────────────────── */
async function startOnline(mode) {
  showScreen('waiting');
  setText('waiting-title','Подключение…');
  setText('waiting-sub','Соединяемся с сервером');
  document.getElementById('invite-block').classList.add('hidden');
  const serverUrl=App.settings.server||window.location.origin;
  try {
    await WS.connect(serverUrl);
    if (mode==='random') {
      setText('waiting-title','Ищем соперника…');
      setText('waiting-sub','Это займёт несколько секунд');
      WS.socket.emit('matchmake',{mode:'random',playerId:App.user.id,playerName:App.user.name});
    } else if (mode==='friend') {
      setText('waiting-title','Создаём комнату…');
      setText('waiting-sub','');
      WS.socket.emit('matchmake',{mode:'friend',playerId:App.user.id,playerName:App.user.name});
    }
  } catch(e) {
    showModal('Нет сервера','Онлайн недоступен. Сыграй с ботом?',[
      {label:'С ботом',cls:'btn-primary',action:()=>{closeModal();startBotGame('bot-medium');}},
      {label:'В меню',cls:'btn-ghost',action:()=>{closeModal();showScreen('menu');}},
    ]);
  }
}

async function joinFriendRoom(roomId) {
  showScreen('waiting');
  setText('waiting-title','Подключение…');
  setText('waiting-sub','Входим в комнату');
  const serverUrl=App.settings.server||window.location.origin;
  try {
    await WS.connect(serverUrl);
    WS.socket.emit('matchmake',{mode:'friend',friendId:roomId,playerId:App.user.id,playerName:App.user.name});
  } catch(e) {
    showModal('Ошибка','Не удалось подключиться к серверу',[
      {label:'В меню',cls:'btn-primary',action:()=>{closeModal();showScreen('menu');}},
    ]);
  }
}

function startBotGame(mode){pendingGameMode=mode;Placement.init();showScreen('placement');}

/* ─── БУРГЕР МЕНЮ ────────────────────────────────── */
function initBurger() {
  const btn=document.getElementById('btn-burger');
  const menu=document.getElementById('burger-menu');
  if (!btn||!menu) return;
  btn.addEventListener('click',(e)=>{
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click',(e)=>{
    if (!menu.contains(e.target)&&e.target!==btn) menu.classList.remove('open');
  });
  
  document.getElementById('burger-surrender')?.addEventListener('click',()=>{
    menu.classList.remove('open');
    if (Game.active) {
      showModal('Сдаться?','Ты хочешь завершить игру?',[
        {label:'Продолжить',cls:'btn-ghost',action:closeModal},
        {label:'Сдаться',cls:'btn-danger',action:()=>{closeModal();endGame('loss');}},
      ]);
    }
  });
  
  document.getElementById('burger-sound')?.addEventListener('click',()=>{
    App.settings.sound=!App.settings.sound;
    saveJSON('bs_settings',App.settings);
    updateSoundIcons();
    if(App.settings.sound) Sound.click();
    menu.classList.remove('open');
  });
  
  document.getElementById('burger-stats')?.addEventListener('click',()=>{
    menu.classList.remove('open');
    renderStatsScreen();
    showScreen('stats');
  });
}

function updateSoundIcons() {
  const muted=!App.settings.sound;
  const btnMenu=document.getElementById('btn-sound-toggle');
  if (btnMenu) {
    btnMenu.classList.toggle('muted',muted);
    const waves=document.getElementById('sound-waves');
    if(waves)waves.style.display=muted?'none':'';
    let line=btnMenu.querySelector('.sound-mute-line');
    if(muted){
      if(!line){
        line=document.createElementNS('http://www.w3.org/2000/svg','line');
        line.setAttribute('class','sound-mute-line');
        line.setAttribute('x1','1');line.setAttribute('y1','1');
        line.setAttribute('x2','23');line.setAttribute('y2','23');
        btnMenu.querySelector('svg')?.appendChild(line);
      }
    } else line?.remove();
  }
  const burgerSound=document.getElementById('burger-sound');
  if(burgerSound){
    burgerSound.querySelector('.sound-label').textContent=muted?'Включить звук':'Выключить звук';
  }
  const cbSettings=document.getElementById('setting-sound');
  if(cbSettings)cbSettings.checked=!muted;
}

function initSoundButton() {
  const btn=document.getElementById('btn-sound-toggle');
  if (!btn) return;
  btn.addEventListener('click',()=>{
    App.settings.sound=!App.settings.sound;
    saveJSON('bs_settings',App.settings);
    updateSoundIcons();
    if(App.settings.sound) Sound.click();
  });
  updateSoundIcons();
}

/* ─── МОДАЛКА / ХРАНИЛИЩЕ / DOM ─────────────────── */
function showModal(title,body,buttons=[]) {
  setText('modal-title',title); setText('modal-body',body);
  const btnsEl=document.getElementById('modal-btns'); btnsEl.innerHTML='';
  buttons.forEach(b=>{
    const btn=document.createElement('button');
    btn.className='btn '+(b.cls||'btn-secondary');
    btn.textContent=b.label;
    btn.addEventListener('click',b.action);
    btnsEl.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal(){document.getElementById('modal-overlay').classList.add('hidden');}
function loadJSON(key,def){try{const v=localStorage.getItem(key);return v?JSON.parse(v):def;}catch(e){return def;}}
function saveJSON(key,val){try{localStorage.setItem(key,JSON.stringify(val));}catch(e){}}
function setText(id,val){const el=document.getElementById(id);if(el)el.textContent=val;}
function setHTML(id,val){const el=document.getElementById(id);if(el)el.innerHTML=val;}

/* ─── TELEGRAM ───────────────────────────────────── */
function initTelegram() {
  try {
    if(!window.Telegram?.WebApp)return;
    const tg=Telegram.WebApp;
    tg.ready();tg.expand();tg.setHeaderColor('secondary_bg_color');tg.enableClosingConfirmation();
  } catch(e){}
}

/* ─── НАВИГАЦИЯ ──────────────────────────────────── */
function updateMenuUI() {
  const u=App.user;
  setText('user-name',u.name);
  setText('user-tag',u.username||(u.isGuest?'гость':''));
  const av=document.getElementById('user-avatar');
  if(av){if(u.photo)av.innerHTML=`<img src="${u.photo}" alt=""/>`;else av.textContent=(u.name[0]||'?').toUpperCase();}
  updateMenuStats();
}

function bindNav() {
  document.addEventListener('click',e=>{
    const btn=e.target.closest('[data-screen]');
    if(!btn)return;
    Sound.click();
    const screen=btn.dataset.screen;
    if(screen==='leaderboard') renderLeaderboard();
    if(screen==='stats') renderStatsScreen();
    showScreen(screen);
  });
  
  const modes={
    'mode-bot-easy':   ()=>startBotGame('bot-easy'),
    'mode-bot-medium': ()=>startBotGame('bot-medium'),
    'mode-bot-hard':   ()=>startBotGame('bot-hard'),
    'mode-random':     ()=>startOnline('random'),
    'mode-friend':     ()=>startOnline('friend'),
  };
  Object.entries(modes).forEach(([id,fn])=>{
    document.getElementById(id)?.addEventListener('click',()=>{Sound.click();fn();});
  });
  
  document.getElementById('btn-rotate')?.addEventListener('click',()=>{
    Placement.vertical=!Placement.vertical;Sound.click();
  });
  document.getElementById('btn-random-place')?.addEventListener('click',()=>Placement.randomize());
  document.getElementById('btn-clear-place')?.addEventListener('click',()=>Placement.clear());
  document.getElementById('btn-ready')?.addEventListener('click',()=>{
    if(!Placement.allPlaced())return;
    Sound.click();
    const myShips=Placement.getShipsForGame();
    if(pendingGameMode==='online'){
      WS.sendShips(Placement.board);
    } else {
      startGame(pendingGameMode,Placement.board,myShips,true,{name:'Бот',username:''});
    }
  });
  
  document.getElementById('btn-show-enemy')?.addEventListener('click',()=>{setShowingField(true);renderGameBoard();});
  document.getElementById('btn-show-mine')?.addEventListener('click',()=>{setShowingField(false);renderGameBoard();});
  document.getElementById('btn-surrender')?.addEventListener('click',()=>{
    showModal('Сдаться?','Ты хочешь завершить игру?',[
      {label:'Продолжить',cls:'btn-ghost',action:closeModal},
      {label:'Сдаться',cls:'btn-danger',action:()=>{closeModal();endGame('loss');}},
    ]);
  });
  document.getElementById('btn-rematch')?.addEventListener('click',()=>{
    Sound.click();startPlacement(pendingGameMode||'bot-medium');
  });
  document.getElementById('btn-copy-link')?.addEventListener('click',()=>{
    const text=document.getElementById('invite-link-text').textContent;
    navigator.clipboard?.writeText(text).then(()=>{
      setText('btn-copy-link','Скопировано!');
      setTimeout(()=>setText('btn-copy-link','Копировать'),2000);
    });
  });
  document.getElementById('modal-overlay')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal();});
  document.getElementById('btn-cancel-wait')?.addEventListener('click',()=>{
    WS.disconnect();showScreen('menu');
  });
  
  window.addEventListener('resize',()=>{
    if(Game.active) renderGameBoard();
  });
}

/* ─── СТАРТ ──────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', async()=>{
  initTelegram();
  initUser();
  initSettings();
  initStats();
  buildLabels();
  initHeroGrid();
  initSoundButton();
  initBurger();
  bindNav();
  updateMenuUI();
  await new Promise(r=>setTimeout(r,1200));
  showScreen('menu');
  
  const params=new URLSearchParams(window.location.search);
  const room=params.get('room');
  if (room) {
    setTimeout(()=>{
      showModal('Приглашение','Тебя пригласили в игру! Подключиться?',[
        {label:'Подключиться',cls:'btn-primary',action:()=>{closeModal();joinFriendRoom(room);}},
        {label:'Отмена',cls:'btn-ghost',action:closeModal},
      ]);
    },400);
  }
});