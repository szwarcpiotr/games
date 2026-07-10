'use strict';

const TRACK = (function(){
  const T=[];
  for(let r=10;r>=6;r--) T.push([6,r]);
  for(let c=7;c<=10;c++) T.push([c,6]);
  T.push([10,5]);
  for(let c=10;c>=6;c--) T.push([c,4]);
  for(let r=3;r>=0;r--) T.push([6,r]);
  T.push([5,0]);
  for(let r=0;r<=4;r++) T.push([4,r]);
  for(let c=3;c>=0;c--) T.push([c,4]);
  T.push([0,5]);
  for(let c=0;c<=4;c++) T.push([c,6]);
  for(let r=7;r<=10;r++) T.push([4,r]);
  T.push([5,10]);
  return T;
})();

const COLORS = ['red','blue','yellow','green'];

// UWAGA: ruch po trasie jest malejący (pos - steps), dlatego pola startowe
// są przesunięte o -2 względem "naturalnych" indeksów — dzięki temu pole
// wjazdu do domu (tuż przed powrotem na start) nadal wypada we właściwym,
// geometrycznie poprawnym miejscu przy własnym domu danego koloru.
const COLOR_CFG = {
  red:    { startField: 38, homeOffset: 40 },
  blue:   { startField: 8,  homeOffset: 44 },
  yellow: { startField: 18, homeOffset: 48 },
  green:  { startField: 28, homeOffset: 52 },
};

const SAFE_FIELDS = new Set([38, 8, 18, 28]);

// Czas (ms) przez który trzymamy slot gracza po rozłączeniu.
// W tym oknie gracz może wrócić na ten sam kolor.
const GRACE_MS = 60_000;

function calcMove(color, pos, steps) {
  const cfg = COLOR_CFG[color];
  const homeStart = cfg.homeOffset;

  if (pos === -1) {
    if (steps !== 6) return { newPos: -1, valid: false };
    return { newPos: cfg.startField, valid: true };
  }

  if (pos >= homeStart && pos < homeStart + 4) {
    const slot    = pos - homeStart;
    const newSlot = slot + steps;
    if (newSlot === 4) return { newPos: 56, valid: true };
    if (newSlot > 4)   return { newPos: pos, valid: false };
    return { newPos: homeStart + newSlot, valid: true };
  }

  const progress    = (cfg.startField - pos + 40) % 40;
  const stepsToHome = 40 - progress;

  if (steps < stepsToHome) {
    return { newPos: (pos - steps + 40) % 40, valid: true };
  } else if (steps === stepsToHome) {
    return { newPos: homeStart, valid: true };
  } else {
    const slot = steps - stepsToHome - 1;
    if (slot > 3) return { newPos: pos, valid: false };
    return { newPos: homeStart + slot, valid: true };
  }
}

function getMovable(game) {
  const color = game.players[game.turnIndex];
  const dice  = game.dice;
  if (dice === null) return [];

  const movable = [];
  for (const piece of game.pieces[color]) {
    if (piece.pos === 56) continue;
    const { newPos, valid } = calcMove(color, piece.pos, dice);
    if (!valid) continue;
    const blocked = game.pieces[color].some(p => p.id !== piece.id && p.pos === newPos);
    if (blocked) continue;
    movable.push({ color, id: piece.id, newPos });
  }
  return movable;
}

function applyMove(game, color, pieceId) {
  const piece = game.pieces[color].find(p => p.id === pieceId);
  if (!piece) return;

  const { newPos } = calcMove(color, piece.pos, game.dice);
  piece.pos = newPos;

  if (newPos >= 0 && newPos < 40 && !SAFE_FIELDS.has(newPos)) {
    for (const otherColor of game.players) {
      if (otherColor === color) continue;
      for (const op of game.pieces[otherColor]) {
        if (op.pos === newPos) op.pos = -1;
      }
    }
  }

  const cfg = COLOR_CFG[color];
  const h   = cfg.homeOffset;
  const won = game.pieces[color].every(p => p.pos === 56 || p.pos === h + 3);
  if (won) {
    game.winner = color;
    game.phase  = 'over';
  }
}

function nextTurn(game) {
  game.dice          = null;
  game.movablePieces = [];
  game.mustRollAgain = false;
  game.sixStreak     = 0;

  let safety = game.players.length + 1;
  do {
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
    const c   = game.players[game.turnIndex];
    const cfg = COLOR_CFG[c];
    const h   = cfg.homeOffset;
    const done = game.pieces[c].every(p => p.pos === 56 || (p.pos >= h && p.pos < h + 4));
    if (!done) break;
  } while (--safety > 0);
}

// ═══════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════
module.exports = function registerChinczyk(io) {
  const ns = io.of('/chinczyk');

  // color → { socketId, token, gracePending: bool }
  let playerSlots  = {};
  // token → color (dla rejonów)
  let tokenMap     = {};
  // socketId → { socket, color, isPlayer }
  let sockets      = new Map();
  let lobbyPlayers = 0;
  let spectators   = 0;
  let game         = null;
  let restartVotes = new Set();
  // color → timeoutId (grace period)
  let graceTimers  = {};

  function broadcast(ev, data) { ns.emit(ev, data); }

  function snapshot() {
    if (!game) return null;
    return {
      phase:         game.phase,
      players:       game.players,
      pieces:        game.pieces,
      turnIndex:     game.turnIndex,
      dice:          game.dice,
      movablePieces: game.movablePieces,
      mustRollAgain: game.mustRollAgain,
      winner:        game.winner,
    };
  }

  function broadcastState() { broadcast('state', snapshot()); }

  function makeGame(activePlayers) {
    const g = {
      phase:         'playing',
      players:       activePlayers,
      pieces:        {},
      turnIndex:     0,
      dice:          null,
      movablePieces: [],
      mustRollAgain: false,
      sixStreak:     0,
      winner:        null,
    };
    for (const c of activePlayers) {
      g.pieces[c] = [0,1,2,3].map(i => ({ id: i, color: c, pos: -1 }));
    }
    return g;
  }

  function firstFreeColor() {
    return COLORS.find(c => !playerSlots[c]) || null;
  }

  function countActivePlayers() {
    return COLORS.filter(c => playerSlots[c]?.socketId).length;
  }

  // Wyczyść sloty gracza — używane PO upływie grace period (nie natychmiast)
  function releaseSlot(color) {
    const slot = playerSlots[color];
    if (!slot) return;
    if (slot.token) delete tokenMap[slot.token];
    delete playerSlots[color];
    delete graceTimers[color];
    lobbyPlayers--;

    if (game) {
      game.players = game.players.filter(c => c !== color);
      delete game.pieces[color];

      if (game.phase === 'playing') {
        if (game.players.length < 2) {
          game.phase = 'waiting';
        } else {
          game.turnIndex = game.turnIndex % game.players.length;
          game.dice          = null;
          game.movablePieces = [];
        }
      }
    }

    broadcast('player_left', { color });
    broadcast('lobby', { players: lobbyPlayers, spectators });
  }

  ns.on('connection', socket => {
    // Klient może wysłać token z sessionStorage przy połączeniu
    const clientToken = socket.handshake.auth?.token || null;

    let color    = null;
    let isPlayer = false;

    // Spróbuj rejoin po tokenie
    if (clientToken && tokenMap[clientToken]) {
      const prevColor = tokenMap[clientToken];
      const slot      = playerSlots[prevColor];

      if (slot && slot.token === clientToken) {
        // Anuluj grace period — gracz wrócił
        if (graceTimers[prevColor]) {
          clearTimeout(graceTimers[prevColor]);
          delete graceTimers[prevColor];
        }
        color    = prevColor;
        isPlayer = true;
        slot.socketId = socket.id;
        slot.gracePending = false;
      }
    }

    // Nowy gracz
    if (!color) {
      const freeColor = firstFreeColor();
      if (freeColor) {
        color    = freeColor;
        isPlayer = true;
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        playerSlots[color] = { socketId: socket.id, token, gracePending: false };
        tokenMap[token]    = color;
        lobbyPlayers++;
      }
    }

    if (!isPlayer) spectators++;

    sockets.set(socket.id, { color, isPlayer });

    // Wyślij token klientowi (tylko nowym graczom; rejoinujący już mają)
    const myToken = isPlayer ? playerSlots[color]?.token : null;
    socket.emit('assigned', { color, isPlayer, token: myToken });
    broadcast('lobby', { players: lobbyPlayers, spectators });

    if (game) socket.emit('state', snapshot());

    // ── Start ──────────────────────────────────────────────
    socket.on('start_game', () => {
      if (!isPlayer || lobbyPlayers < 2) return;
      if (game && game.phase === 'playing') return;
      const active = COLORS.filter(c => playerSlots[c]?.socketId);
      game = makeGame(active);
      restartVotes.clear();
      broadcastState();
    });

    // ── Rzut ───────────────────────────────────────────────
    socket.on('roll', () => {
      if (!game || game.phase !== 'playing') return;
      if (!isPlayer || game.players[game.turnIndex] !== color) return;
      if (game.dice !== null) return;

      const roll = Math.ceil(Math.random() * 6);
      game.dice  = roll;

      if (roll === 6) {
        game.sixStreak++;
        game.mustRollAgain = true;
      } else {
        game.sixStreak     = 0;
        game.mustRollAgain = false;
      }

      game.movablePieces = getMovable(game);

      if (game.movablePieces.length === 0) {
        if (game.mustRollAgain) {
          game.dice          = null;
          game.mustRollAgain = false;
          broadcastState();
        } else {
          broadcastState();
          setTimeout(() => { nextTurn(game); broadcastState(); }, 900);
        }
        return;
      }

      broadcastState();
    });

    // ── Ruch pionkiem ──────────────────────────────────────
    socket.on('move', ({ pieceId }) => {
      if (!game || game.phase !== 'playing') return;
      if (!isPlayer || game.players[game.turnIndex] !== color) return;
      if (game.dice === null) return;

      const movable = game.movablePieces.find(m => m.color === color && m.id === pieceId);
      if (!movable) return;

      const hadSix = game.mustRollAgain;
      applyMove(game, color, pieceId);

      if (game.phase === 'over') {
        broadcastState();
        broadcast('game_over', { winner: game.winner });
        return;
      }

      game.dice          = null;
      game.movablePieces = [];

      if (hadSix) {
        game.mustRollAgain = false;
        broadcastState();
      } else {
        game.mustRollAgain = false;
        broadcastState();
        setTimeout(() => { nextTurn(game); broadcastState(); }, 600);
      }
    });

    // ── Restart ────────────────────────────────────────────
    socket.on('restart_vote', ({ vote }) => {
      if (!isPlayer) return;
      vote ? restartVotes.add(socket.id) : restartVotes.delete(socket.id);
      broadcast('restart_votes', { count: restartVotes.size });

      const activePlayers = countActivePlayers();
      if (restartVotes.size >= activePlayers && activePlayers >= 2) {
        const active = COLORS.filter(c => playerSlots[c]?.socketId);
        game = makeGame(active);
        restartVotes.clear();
        broadcast('restart', snapshot());
      }
    });

    // ── Rozłączenie ────────────────────────────────────────
    socket.on('disconnect', () => {
      const info = sockets.get(socket.id);
      if (!info) return;
      sockets.delete(socket.id);

      if (info.isPlayer && info.color) {
        restartVotes.delete(socket.id);
        const slot = playerSlots[info.color];

        if (slot) {
          // Oznacz slot jako "grace" — jeszcze go nie zwalniamy
          slot.socketId     = null;
          slot.gracePending = true;

          // Poinformuj innych że gracz chwilowo wyszedł
          broadcast('player_away', { color: info.color });

          // Po GRACE_MS — jeśli nie wrócił, zwolnij slot na dobre
          graceTimers[info.color] = setTimeout(() => {
            releaseSlot(info.color);
          }, GRACE_MS);
        }
      } else if (!info.isPlayer) {
        spectators--;
        broadcast('lobby', { players: lobbyPlayers, spectators });
      }
    });
  });
};