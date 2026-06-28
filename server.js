const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
});

app.use(express.static('public'));

// ── Stałe fizyki (muszą być identyczne z klientem dla przewidywalności) ────────
const W           = 900;
const H           = 560;
const PUCK_R      = 14;
const MALLET_R    = 28;
const FRICTION    = 0.995;
const PUCK_STOP   = 0.15;
const MAX_MALLET_V= 18;
const WALL_BOUNCE = 0.8;
const MALLET_MASS = 4;
const GOAL_W      = 130;
const GOAL_TOP    = (H - GOAL_W) / 2;
const GOAL_BOT    = (H + GOAL_W) / 2;
const P1_MAX_X    = W / 2 - MALLET_R - 5;
const P2_MIN_X    = W / 2 + MALLET_R + 5;
const TICK_RATE   = 60; // Hz

// ── Pokoje ─────────────────────────────────────────────────────────────────────
const rooms = new Map();

function createRoom(id) {
  return {
    id,
    players: [],      // max 2 socketId
    spectators: [],
    state: createState(),
    interval: null,
    inputs: { p1: null, p2: null }, // ostatni znany input gracza
  };
}

function createState() {
  return {
    puck: { x: W/2, y: H/2, vx: 4, vy: (Math.random()-0.5)*4 },
    m1:   { x: MALLET_R + 60,     y: H/2, vx: 0, vy: 0 },
    m2:   { x: W - MALLET_R - 60, y: H/2, vx: 0, vy: 0 },
    score: { p1: 0, p2: 0 },
    phase: 'waiting', // waiting | playing | goal
    goalTimeout: 0,
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

  // Aplikuj inputy graczy → przesuń malletki
  applyInput(s.m1, room.inputs.p1, MALLET_R, P1_MAX_X, MALLET_R, H - MALLET_R);
  applyInput(s.m2, room.inputs.p2, P2_MIN_X, W - MALLET_R, MALLET_R, H - MALLET_R);

  resolvePuckMallet(s.puck, s.m1);
  resolvePuckMallet(s.puck, s.m2);
  updatePuck(room);

  // Wyślij stan do wszystkich w pokoju
  const snapshot = {
    puck:  { x: s.puck.x, y: s.puck.y, vx: s.puck.vx, vy: s.puck.vy },
    m1:    { x: s.m1.x,   y: s.m1.y },
    m2:    { x: s.m2.x,   y: s.m2.y },
    score: s.score,
    phase: s.phase,
    t:     Date.now(),
  };
  io.to(room.id).emit('state', snapshot);
}

function applyInput(mallet, input, minX, maxX, minY, maxY) {
  if (!input) return;
  let dx = input.dx;
  let dy = input.dy;
  const len = Math.sqrt(dx*dx + dy*dy);
  if (len > MAX_MALLET_V) { dx = dx/len*MAX_MALLET_V; dy = dy/len*MAX_MALLET_V; }
  mallet.vx = dx;
  mallet.vy = dy;
  mallet.x = clamp(mallet.x + dx, minX, maxX);
  mallet.y = clamp(mallet.y + dy, minY, maxY);
}

function updatePuck(room) {
  const s = room.state;
  const p = s.puck;

  p.vx *= FRICTION;
  p.vy *= FRICTION;
  if (Math.abs(p.vx) < PUCK_STOP) p.vx = 0;
  if (Math.abs(p.vy) < PUCK_STOP) p.vy = 0;

  p.x += p.vx;
  p.y += p.vy;

  if (p.y - PUCK_R < 0)  { p.y = PUCK_R;      p.vy =  Math.abs(p.vy) * WALL_BOUNCE; }
  if (p.y + PUCK_R > H)  { p.y = H - PUCK_R;  p.vy = -Math.abs(p.vy) * WALL_BOUNCE; }

  if (p.x - PUCK_R < 0) {
    if (p.y > GOAL_TOP && p.y < GOAL_BOT) {
      goalScored(room, 'p2');
    } else {
      p.x = PUCK_R; p.vx = Math.abs(p.vx) * WALL_BOUNCE;
    }
  }
  if (p.x + PUCK_R > W) {
    if (p.y > GOAL_TOP && p.y < GOAL_BOT) {
      goalScored(room, 'p1');
    } else {
      p.x = W - PUCK_R; p.vx = -Math.abs(p.vx) * WALL_BOUNCE;
    }
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

// Znajdź lub utwórz pokój z wolnym miejscem
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
    playerNum = room.players.length + 1; // 1 lub 2
    room.players.push(socket.id);
    socket.emit('assigned', { player: playerNum, roomId: room.id });
  } else {
    room.spectators.push(socket.id);
    socket.emit('assigned', { player: 0, roomId: room.id }); // 0 = widz
  }

  // Powiadom pokój o liczbie graczy
  io.to(room.id).emit('lobby', {
    players: room.players.length,
    spectators: room.spectators.length,
  });

  // Start gdy mamy 2 graczy
  if (room.players.length === 2) {
    startRoom(room);
  }

  // Input od gracza
  socket.on('input', (data) => {
    if (playerNum === 1) room.inputs.p1 = data;
    if (playerNum === 2) room.inputs.p2 = data;
  });

  socket.on('disconnect', () => {
    if (playerNum) {
      room.players = room.players.filter(id => id !== socket.id);
      stopRoom(room);
      io.to(room.id).emit('player_left', { player: playerNum });
      // Usuń pokój jeśli wszyscy wyszli
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
server.listen(PORT, () => {
  console.log(`Cymbergaj server running on port ${PORT}`);
});
