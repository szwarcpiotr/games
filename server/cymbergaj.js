'use strict';

// ── Stałe fizyki ───────────────────────────────────────────────────────────
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
const GRACE_MS     = 60_000;

module.exports = function registerCymbergaj(io) {
  const ns = io.of('/cymbergaj');

  // ── Pokoje ─────────────────────────────────────────────────────────────────
  const rooms = new Map();

  function createRoom(id) {
    return {
      id,
      // slot: { socketId, token, gracePending }
      slots:       { p1: null, p2: null },
      tokenMap:    {},           // token → 'p1'|'p2'
      graceTimers: {},           // 'p1'|'p2' → timeoutId
      spectators:  [],
      state:       createState(),
      interval:    null,
      inputs:      { p1: null, p2: null },
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

    const nx = dx / d, ny = dy / d;
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

    ns.to(room.id).emit('state', {
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
    ns.to(room.id).emit('goal', { who, score: s.score });
    setTimeout(() => {
      const dir = who === 'p1' ? -1 : 1;
      s.puck = { x: W/2, y: H/2, vx: dir * 5, vy: (Math.random()-0.5)*4 };
      s.m1   = { x: MALLET_R + 60,     y: H/2, vx: 0, vy: 0 };
      s.m2   = { x: W - MALLET_R - 60, y: H/2, vx: 0, vy: 0 };
      room.inputs = { p1: null, p2: null };
      s.phase = 'playing';
      ns.to(room.id).emit('resume');
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
    ns.to(room.id).emit('restart');
    ns.to(room.id).emit('restart_votes', { count: 0 });
  }

  function activePlayers(room) {
    return ['p1','p2'].filter(k => room.slots[k]?.socketId).length;
  }

  function startRoom(room) {
    if (room.interval) return;
    room.state.phase = 'playing';
    room.interval = setInterval(() => tickRoom(room), 1000 / TICK_RATE);
    ns.to(room.id).emit('start', { score: room.state.score });
  }

  function pauseRoom(room) {
    // Zatrzymaj symulację gdy brakuje gracza, ale nie kasuj pokoju
    if (room.interval) { clearInterval(room.interval); room.interval = null; }
    room.state.phase = 'waiting';
    room.inputs = { p1: null, p2: null };
  }

  function releaseSlot(room, slotKey) {
    const slot = room.slots[slotKey];
    if (!slot) return;
    if (slot.token) delete room.tokenMap[slot.token];
    room.slots[slotKey] = null;
    delete room.graceTimers[slotKey];

    const playerNum = slotKey === 'p1' ? 1 : 2;
    ns.to(room.id).emit('player_left', { player: playerNum });
    ns.to(room.id).emit('lobby', {
      players:    activePlayers(room),
      spectators: room.spectators.length,
    });

    // Posprzątaj pusty pokój
    if (!room.slots.p1 && !room.slots.p2 && room.spectators.length === 0) {
      if (room.interval) clearInterval(room.interval);
      rooms.delete(room.id);
    }
  }

  function findOrCreateRoom() {
    for (const [, room] of rooms) {
      if (!room.slots.p1 || !room.slots.p2) return room;
    }
    const id = 'room_' + Math.random().toString(36).slice(2, 8);
    const room = createRoom(id);
    rooms.set(id, room);
    return room;
  }

  // ── Socket.io ──────────────────────────────────────────────────────────────
  ns.on('connection', socket => {
    const clientToken = socket.handshake.auth?.token || null;

    let room      = null;
    let slotKey   = null; // 'p1' | 'p2' | null (widz)
    let playerNum = null; // 1 | 2 | null

    // Spróbuj rejoin po tokenie
    if (clientToken) {
      for (const [, r] of rooms) {
        if (r.tokenMap[clientToken]) {
          const key = r.tokenMap[clientToken];
          const slot = r.slots[key];
          if (slot && slot.token === clientToken) {
            // Anuluj grace period
            if (r.graceTimers[key]) {
              clearTimeout(r.graceTimers[key]);
              delete r.graceTimers[key];
            }
            room      = r;
            slotKey   = key;
            playerNum = key === 'p1' ? 1 : 2;
            slot.socketId     = socket.id;
            slot.gracePending = false;
            break;
          }
        }
      }
    }

    // Nowe połączenie — znajdź/utwórz pokój
    if (!room) {
      room = findOrCreateRoom();
      socket.join(room.id);

      if (!room.slots.p1 || !room.slots.p2) {
        slotKey   = !room.slots.p1 ? 'p1' : 'p2';
        playerNum = slotKey === 'p1' ? 1 : 2;
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        room.slots[slotKey]    = { socketId: socket.id, token, gracePending: false };
        room.tokenMap[token]   = slotKey;
      } else {
        room.spectators.push(socket.id);
      }
    } else {
      socket.join(room.id);
    }

    const myToken = slotKey ? room.slots[slotKey]?.token : null;
    socket.emit('assigned', { player: playerNum || 0, roomId: room.id, token: myToken });

    ns.to(room.id).emit('lobby', {
      players:    activePlayers(room),
      spectators: room.spectators.length,
    });

    // Jeśli oboje gracze są — wznów grę (po rejoin) lub zacznij
    if (activePlayers(room) === 2) {
      if (room.state.phase === 'waiting') startRoom(room);
      // Prześlij aktualny stan (wynik itp.) do powracającego gracza
      socket.emit('state', {
        puck:  room.state.puck,
        m1:    { x: room.state.m1.x, y: room.state.m1.y },
        m2:    { x: room.state.m2.x, y: room.state.m2.y },
        score: room.state.score,
        phase: room.state.phase,
        t:     Date.now(),
      });
    }

    // ── Input ──────────────────────────────────────────────
    socket.on('input', (data) => {
      if (slotKey === 'p1') room.inputs.p1 = data;
      if (slotKey === 'p2') room.inputs.p2 = data;
    });

    // ── Restart ────────────────────────────────────────────
    socket.on('restart_vote', ({ vote }) => {
      if (!slotKey) return;
      vote ? room.restartVotes.add(slotKey) : room.restartVotes.delete(slotKey);
      const count = room.restartVotes.size;
      ns.to(room.id).emit('restart_votes', { count });
      if (count >= 2) doRestart(room);
    });

    // ── Rozłączenie ────────────────────────────────────────
    socket.on('disconnect', () => {
      if (slotKey) {
        room.restartVotes.delete(slotKey);
        const slot = room.slots[slotKey];

        if (slot) {
          slot.socketId     = null;
          slot.gracePending = true;

          // Zatrzymaj symulację — brakuje gracza
          if (room.state.phase === 'playing') pauseRoom(room);

          // Poinformuj że gracz chwilowo wyszedł (ale nie kasuj go jeszcze)
          ns.to(room.id).emit('player_away', { player: playerNum });

          // Grace period
          room.graceTimers[slotKey] = setTimeout(() => {
            releaseSlot(room, slotKey);
          }, GRACE_MS);
        }
      } else {
        room.spectators = room.spectators.filter(id => id !== socket.id);
        ns.to(room.id).emit('lobby', {
          players:    activePlayers(room),
          spectators: room.spectators.length,
        });
      }
    });
  });
};