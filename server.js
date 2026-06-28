const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
});

app.use(express.static('public'));

// SPA fallback
app.get('/cymbergaj', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cymbergaj', 'index.html'));
});
app.get('/warcaby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'warcaby', 'index.html'));
});

// ── Stałe fizyki ───────────────────────────────────────────────────────────────
const W            = 900;
const H            = 560;
const PUCK_R       = 14;
const MALLET_R     = 28;
const FRICTION     = 0.995;
const PUCK_STOP    = 0.15;
const MAX_MALLET_V = 18;
const WALL_BOUNCE  = 0.8;
const MALLET_MASS  = 4;
const GOAL_W       = 130;
const GOAL_TOP     = (H - GOAL_W) / 2;
const GOAL_BOT     = (H + GOAL_W) / 2;
const P1_MAX_X     = W / 2 - MALLET_R - 5;
const P2_MIN_X     = W / 2 + MALLET_R + 5;
const TICK_RATE    = 60;

// ── Pokoje ─────────────────────────────────────────────────────────────────────
const rooms = new Map();

function createRoom(id) {
  return {
    id,
    players: [],
    spectators: [],
    state: createState(),
    interval: null,
    inputs: { p1: null, p2: null },
    restartVotes: new Set(),
  };
}

function createState() {
  return {
    puck:  { x: W/2, y: H/2, vx: 4, vy: (Math.random()-0.5)*4 },
    m1:    { x: MALLET_R + 60,     y: H/2, vx: 0, vy: 0 },
    m2:    { x: W - MALLET_R - 60, y: H/2, vx: 0, vy: 0 },
    score: { p1: 0, p2: 0 },
    phase: 'waiting',
  };
}

function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

function resolvePuckMallet(puck, mallet) {
  const minDist = PUCK_R + MALLET_R;
  const dx = puck.x - mallet.x;
  const dy = puck.y - mallet.y;
  const d  = Math.sqrt(dx*dx + dy*dy);
  if (d >= minDist || d < 0.001) return;

  const nx = dx / d;
  const ny = dy / d;
  const overlap = minDist - d;
  puck.x += nx * overlap * 0.8;
  puck.y += ny * overlap * 0.8;

  const dvx = puck.vx - mallet.vx;
  const dvy = puck.vy - mallet.vy;
  const vn  = dvx * nx + dvy * ny;
  if (vn >= 0) return;

  const restitution = 0.82;
  const impulse = -(1 + restitution) * vn / (1 + 1/MALLET_MASS);
  puck.vx += impulse * nx;
  puck.vy += impulse * ny;
  mallet.vx -= (impulse / MALLET_MASS) * nx * 0.2;
  mallet.vy -= (impulse / MALLET_MASS) * ny * 0.2;
}

function tickRoom(room) {
  const s = room.state;
  if (s.phase !== 'playing') return;

  applyInput(s.m1, room.inputs.p1, MALLET_R, P1_MAX_X, MALLET_R, H - MALLET_R);
  applyInput(s.m2, room.inputs.p2, P2_MIN_X, W - MALLET_R, MALLET_R, H - MALLET_R);
  resolvePuckMallet(s.puck, s.m1);
  resolvePuckMallet(s.puck, s.m2);
  updatePuck(room);

  io.to(room.id).emit('state', {
    puck:  { x: s.puck.x, y: s.puck.y, vx: s.puck.vx, vy: s.puck.vy },
    m1:    { x: s.m1.x, y: s.m1.y },
    m2:    { x: s.m2.x, y: s.m2.y },
    score: s.score,
    phase: s.phase,
    t:     Date.now(),
  });
}

function applyInput(mallet, input, minX, maxX, minY, maxY) {
  if (!input) return;
  let dx = input.dx, dy = input.dy;
  const len = Math.sqrt(dx*dx + dy*dy);
  if (len > MAX_MALLET_V) { dx = dx/len*MAX_MALLET_V; dy = dy/len*MAX_MALLET_V; }
  mallet.vx = dx; mallet.vy = dy;
  mallet.x = clamp(mallet.x + dx, minX, maxX);
  mallet.y = clamp(mallet.y + dy, minY, maxY);
}

function updatePuck(room) {
  const s = room.state;
  const p = s.puck;

  p.vx *= FRICTION; p.vy *= FRICTION;
  if (Math.abs(p.vx) < PUCK_STOP) p.vx = 0;
  if (Math.abs(p.vy) < PUCK_STOP) p.vy = 0;
  p.x += p.vx; p.y += p.vy;

  if (p.y - PUCK_R < 0) { p.y = PUCK_R;     p.vy =  Math.abs(p.vy) * WALL_BOUNCE; }
  if (p.y + PUCK_R > H) { p.y = H - PUCK_R; p.vy = -Math.abs(p.vy) * WALL_BOUNCE; }

  if (p.x - PUCK_R < 0) {
    if (p.y > GOAL_TOP && p.y < GOAL_BOT) goalScored(room, 'p2');
    else { p.x = PUCK_R; p.vx = Math.abs(p.vx) * WALL_BOUNCE; }
  }
  if (p.x + PUCK_R > W) {
    if (p.y > GOAL_TOP && p.y < GOAL_BOT) goalScored(room, 'p1');
    else { p.x = W - PUCK_R; p.vx = -Math.abs(p.vx) * WALL_BOUNCE; }
  }
}

function goalScored(room, who) {
  const s = room.state;
  s.score[who]++;
  s.phase = 'goal';
  io.to(room.id).emit('goal', { who, score: s.score });
  setTimeout(() => {
    const dir = who === 'p1' ? -1 : 1;
    s.puck = { x: W/2, y: H/2, vx: dir * 5, vy: (Math.random()-0.5)*4 };
    s.m1   = { x: MALLET_R + 60,     y: H/2, vx: 0, vy: 0 };
    s.m2   = { x: W - MALLET_R - 60, y: H/2, vx: 0, vy: 0 };
    room.inputs = { p1: null, p2: null };
    s.phase = 'playing';
    io.to(room.id).emit('resume');
  }, 2000);
}

function doRestart(room) {
  const s = room.state;
  s.puck  = { x: W/2, y: H/2, vx: 4, vy: (Math.random()-0.5)*4 };
  s.m1    = { x: MALLET_R + 60,     y: H/2, vx: 0, vy: 0 };
  s.m2    = { x: W - MALLET_R - 60, y: H/2, vx: 0, vy: 0 };
  s.score = { p1: 0, p2: 0 };
  s.phase = 'playing';
  room.inputs = { p1: null, p2: null };
  room.restartVotes.clear();
  io.to(room.id).emit('restart');
  io.to(room.id).emit('restart_votes', { count: 0 });
}

function startRoom(room) {
  if (room.interval) return;
  room.state.phase = 'playing';
  room.interval = setInterval(() => tickRoom(room), 1000 / TICK_RATE);
  io.to(room.id).emit('start', { score: room.state.score });
}

function stopRoom(room) {
  if (room.interval) { clearInterval(room.interval); room.interval = null; }
  room.state.phase = 'waiting';
}

function findOrCreateRoom() {
  for (const [, room] of rooms) {
    if (room.players.length < 2) return room;
  }
  const id = 'room_' + Math.random().toString(36).slice(2, 8);
  const room = createRoom(id);
  rooms.set(id, room);
  return room;
}

// ── Socket.io ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const room = findOrCreateRoom();
  socket.join(room.id);
  let playerNum = null;

  if (room.players.length < 2) {
    playerNum = room.players.length + 1;
    room.players.push(socket.id);
    socket.emit('assigned', { player: playerNum, roomId: room.id });
  } else {
    room.spectators.push(socket.id);
    socket.emit('assigned', { player: 0, roomId: room.id });
  }

  io.to(room.id).emit('lobby', {
    players: room.players.length,
    spectators: room.spectators.length,
  });

  if (room.players.length === 2) startRoom(room);

  socket.on('input', (data) => {
    if (playerNum === 1) room.inputs.p1 = data;
    if (playerNum === 2) room.inputs.p2 = data;
  });

  socket.on('restart_vote', ({ vote }) => {
    if (!playerNum) return;
    const key = `p${playerNum}`;
    if (vote) room.restartVotes.add(key);
    else      room.restartVotes.delete(key);
    const count = room.restartVotes.size;
    io.to(room.id).emit('restart_votes', { count });
    if (count >= 2) doRestart(room);
  });

  socket.on('disconnect', () => {
    if (playerNum) {
      room.players = room.players.filter(id => id !== socket.id);
      room.restartVotes.delete(`p${playerNum}`);
      stopRoom(room);
      io.to(room.id).emit('player_left', { player: playerNum });
      if (room.players.length === 0 && room.spectators.length === 0) {
        rooms.delete(room.id);
      }
    } else {
      room.spectators = room.spectators.filter(id => id !== socket.id);
    }
    io.to(room.id).emit('lobby', {
      players: room.players.length,
      spectators: room.spectators.length,
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ══════════════════════════════════════════════════════════════════════════════
// WARCABY
// ══════════════════════════════════════════════════════════════════════════════
const checkersRooms = new Map();

function createCheckersRoom(id) {
  return {
    id,
    players:      [],
    spectators:   [],
    board:        initCheckersBoard(),
    turn:         1,       // 1 lub 2
    phase:        'waiting',
    restartVotes: new Set(),
  };
}

function initCheckersBoard() {
  const b = Array.from({ length: 8 }, () => new Array(8).fill(null));
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        if (r < 3) b[r][c] = { player: 2, king: false };
        if (r > 4) b[r][c] = { player: 1, king: false };
      }
    }
  }
  return b;
}

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

function getAllMoves(board, player) {
  const moves = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || p.player !== player) continue;
      moves.push(...getMovesForPiece(r, c, board, player, p.king));
    }
  }
  return moves;
}

function getMovesForPiece(row, col, board, player, isKing) {
  const moves = [];
  const dirs  = isKing
    ? [[-1,-1],[-1,1],[1,-1],[1,1]]
    : player === 1 ? [[1,-1],[1,1]] : [[-1,-1],[-1,1]];

  for (const [dr, dc] of dirs) {
    const nr = row + dr, nc = col + dc;
    if (!inBounds(nr, nc)) continue;
    if (!board[nr][nc]) {
      moves.push({ from: {row, col}, to: {row: nr, col: nc}, captures: [] });
    } else if (board[nr][nc].player !== player) {
      const jr = nr + dr, jc = nc + dc;
      if (inBounds(jr, jc) && !board[jr][jc]) {
        moves.push({ from: {row, col}, to: {row: jr, col: jc}, captures: [{row: nr, col: nc}] });
      }
    }
  }
  return moves;
}

function applyMove(board, move) {
  const b     = board.map(r => r.map(c => c ? { ...c } : null));
  const piece = b[move.from.row][move.from.col];
  b[move.to.row][move.to.col]     = piece;
  b[move.from.row][move.from.col] = null;
  for (const cap of move.captures) b[cap.row][cap.col] = null;
  // Damka
  if (piece.player === 1 && move.to.row === 7) piece.king = true;
  if (piece.player === 2 && move.to.row === 0) piece.king = true;
  return b;
}

function checkWinner(board) {
  const has1 = board.flat().some(p => p && p.player === 1);
  const has2 = board.flat().some(p => p && p.player === 2);
  if (!has1) return 2;
  if (!has2) return 1;
  return null;
}

function findOrCreateCheckersRoom() {
  for (const [, room] of checkersRooms) {
    if (room.players.length < 2) return room;
  }
  const id   = 'croom_' + Math.random().toString(36).slice(2, 8);
  const room = createCheckersRoom(id);
  checkersRooms.set(id, room);
  return room;
}

function doCheckersRestart(room) {
  room.board        = initCheckersBoard();
  room.turn         = 1;
  room.phase        = 'playing';
  room.restartVotes.clear();
  io.to(room.id).emit('restart',       { boardState: room.board, turn: room.turn });
  io.to(room.id).emit('restart_votes', { count: 0 });
}

// Namespace /warcaby
const warcabyNS = io.of('/warcaby');

warcabyNS.on('connection', (socket) => {
  const room = findOrCreateCheckersRoom();
  socket.join(room.id);
  let playerNum = null;

  if (room.players.length < 2) {
    playerNum = room.players.length + 1;
    room.players.push(socket.id);
    socket.emit('assigned', { player: playerNum, roomId: room.id });
  } else {
    room.spectators.push(socket.id);
    socket.emit('assigned', { player: 0, roomId: room.id });
  }

  warcabyNS.to(room.id).emit('lobby', { players: room.players.length, spectators: room.spectators.length });

  if (room.players.length === 2) {
    room.phase = 'playing';
    warcabyNS.to(room.id).emit('start', { boardState: room.board, turn: room.turn });
  }

  socket.on('move', (move) => {
    if (room.phase !== 'playing' || playerNum !== room.turn) return;

    // Weryfikacja — czy ruch jest w liście legalnych
    const allMoves   = getAllMoves(room.board, room.turn);
    const hasCapture = allMoves.some(m => m.captures.length > 0);
    const legal      = allMoves.filter(m =>
      m.from.row === move.from.row && m.from.col === move.from.col &&
      m.to.row  === move.to.row   && m.to.col  === move.to.col   &&
      (!hasCapture || m.captures.length > 0)
    );

    if (legal.length === 0) { socket.emit('invalid_move'); return; }

    room.board = applyMove(room.board, legal[0]);
    room.turn  = room.turn === 1 ? 2 : 1;

    const winner = checkWinner(room.board);
    if (winner) {
      room.phase = 'over';
      warcabyNS.to(room.id).emit('game_over', { winner });
    } else {
      // Sprawdź czy gracz ma jakiekolwiek ruchy
      const nextMoves = getAllMoves(room.board, room.turn);
      if (nextMoves.length === 0) {
        room.phase = 'over';
        warcabyNS.to(room.id).emit('game_over', { winner: room.turn === 1 ? 2 : 1 });
        return;
      }
      warcabyNS.to(room.id).emit('state', { boardState: room.board, turn: room.turn, phase: room.phase });
    }
  });

  socket.on('restart_vote', ({ vote }) => {
    if (!playerNum) return;
    const key = `p${playerNum}`;
    if (vote) room.restartVotes.add(key);
    else      room.restartVotes.delete(key);
    const count = room.restartVotes.size;
    warcabyNS.to(room.id).emit('restart_votes', { count });
    if (count >= 2) doCheckersRestart(room);
  });

  socket.on('disconnect', () => {
    if (playerNum) {
      room.players = room.players.filter(id => id !== socket.id);
      room.restartVotes.delete(`p${playerNum}`);
      room.phase = 'waiting';
      warcabyNS.to(room.id).emit('player_left', { player: playerNum });
      if (room.players.length === 0 && room.spectators.length === 0) {
        checkersRooms.delete(room.id);
      }
    } else {
      room.spectators = room.spectators.filter(id => id !== socket.id);
    }
    warcabyNS.to(room.id).emit('lobby', { players: room.players.length, spectators: room.spectators.length });
  });
});
