'use strict';

// ═══════════════════════════════════════════════════════════
// TRASA — identyczna jak w kliencie (40 pól)
// ═══════════════════════════════════════════════════════════
// Trasa 40 pól — ruch zgodnie z ruchem wskazówek zegara
const TRACK = (function(){
  const T=[];
  for(let c=6;c<=10;c++) T.push([c,10]);  // 0..4
  for(let r=9;r>=5;r--) T.push([10,r]);   // 5..9
  for(let r=4;r>=0;r--) T.push([10,r]);   // 10..14
  for(let c=9;c>=5;c--) T.push([c,0]);    // 15..19
  for(let c=4;c>=0;c--) T.push([c,0]);    // 20..24
  for(let r=1;r<=5;r++) T.push([0,r]);    // 25..29
  for(let r=6;r<=10;r++) T.push([0,r]);   // 30..34
  for(let c=1;c<=5;c++) T.push([c,10]);   // 35..39
  return T;
})();

const COLORS = ['red','blue','yellow','green'];

const COLOR_CFG = {
  red:    { startField: 0,  homeOffset: 40 },
  blue:   { startField: 10, homeOffset: 44 },
  yellow: { startField: 20, homeOffset: 48 },
  green:  { startField: 30, homeOffset: 52 },
};

// Pola bezpieczne na wspólnej trasie (pola startowe każdego koloru)
const SAFE_FIELDS = new Set([0, 10, 20, 30]);

// ═══════════════════════════════════════════════════════════
// LOGIKA RUCHU
// ═══════════════════════════════════════════════════════════

// Oblicza nową pozycję pionka po `steps` krokach.
// pos: -1=baza, 0..39=trasa, homeOffset..homeOffset+3=dom, 56=meta
function calcMove(color, pos, steps) {
  const cfg = COLOR_CFG[color];
  const homeStart = cfg.homeOffset;

  // Z bazy wychodzi tylko na 6
  if (pos === -1) {
    if (steps !== 6) return { newPos: -1, valid: false };
    return { newPos: cfg.startField, valid: true };
  }

  // Już w domu
  if (pos >= homeStart && pos < homeStart + 4) {
    const slot    = pos - homeStart;
    const newSlot = slot + steps;
    if (newSlot === 4) return { newPos: 56, valid: true }; // meta!
    if (newSlot > 4)   return { newPos: pos, valid: false };
    return { newPos: homeStart + newSlot, valid: true };
  }

  // Na wspólnej trasie:
  // "postęp" gracza = ile kroków zrobił od swojego pola startowego
  const progress = (pos - cfg.startField + 40) % 40;
  // Ile kroków do wejścia do domu (po przejechaniu całej trasy)
  const stepsToHome = 40 - progress;

  if (steps < stepsToHome) {
    // Zostaje na trasie
    return { newPos: (pos + steps) % 40, valid: true };
  } else if (steps === stepsToHome) {
    // Wchodzi na slot 0 domu
    return { newPos: homeStart, valid: true };
  } else {
    // Wchodzi głębiej do domu
    const slot = steps - stepsToHome - 1;
    if (slot > 3) return { newPos: pos, valid: false };
    return { newPos: homeStart + slot, valid: true };
  }
}

// Zbiera wszystkie możliwe ruchy aktywnego gracza
function getMovable(game) {
  const color = game.players[game.turnIndex];
  const dice  = game.dice;
  if (dice === null) return [];

  const movable = [];
  for (const piece of game.pieces[color]) {
    if (piece.pos === 56) continue;

    const { newPos, valid } = calcMove(color, piece.pos, dice);
    if (!valid) continue;

    // Zablokowany przez własnego pionka?
    const blocked = game.pieces[color].some(p => p.id !== piece.id && p.pos === newPos);
    if (blocked) continue;

    movable.push({ color, id: piece.id, newPos });
  }
  return movable;
}

// Wykonuje ruch pionka
function applyMove(game, color, pieceId) {
  const piece = game.pieces[color].find(p => p.id === pieceId);
  if (!piece) return;

  const { newPos } = calcMove(color, piece.pos, game.dice);
  piece.pos = newPos;

  // Bicie — tylko na wspólnej trasie, nie na polach bezpiecznych
  if (newPos >= 0 && newPos < 40 && !SAFE_FIELDS.has(newPos)) {
    for (const otherColor of game.players) {
      if (otherColor === color) continue;
      for (const op of game.pieces[otherColor]) {
        if (op.pos === newPos) {
          op.pos = -1; // cofnij na bazę
        }
      }
    }
  }

  // Sprawdź wygraną: wszystkie 4 pionki w domu (homeStart..homeStart+3) lub meta (56)
  const cfg      = COLOR_CFG[color];
  const h        = cfg.homeOffset;
  const allDone  = game.pieces[color].every(p => p.pos === 56 || (p.pos >= h && p.pos < h + 4));
  // Wygrywa gdy wszystkie 4 na ostatnim slocie domu lub w meta
  const won = game.pieces[color].every(p => p.pos === 56 || p.pos === h + 3);
  if (won) {
    game.winner = color;
    game.phase  = 'over';
  }
}

// Przejdź do tury następnego gracza (pomijaj tych co skończyli)
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

  let playerMap    = {};  // color → socketId
  let sockets      = new Map(); // socketId → { socket, color, isPlayer }
  let lobbyPlayers = 0;
  let spectators   = 0;
  let game         = null;
  let restartVotes = new Set();

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
    return COLORS.find(c => !playerMap[c]) || null;
  }

  ns.on('connection', socket => {
    const color    = firstFreeColor();
    const isPlayer = !!color;

    if (isPlayer) {
      playerMap[color] = socket.id;
      lobbyPlayers++;
    } else {
      spectators++;
    }
    sockets.set(socket.id, { color, isPlayer });

    socket.emit('assigned', { color, isPlayer });
    broadcast('lobby', { players: lobbyPlayers, spectators });

    // Wyślij aktualny stan jeśli gra trwa
    if (game) socket.emit('state', snapshot());

    // ── Start ──────────────────────────────────────────────
    socket.on('start_game', () => {
      if (!isPlayer || lobbyPlayers < 2) return;
      if (game && game.phase === 'playing') return;
      const active = COLORS.filter(c => playerMap[c]);
      game = makeGame(active);
      restartVotes.clear();
      broadcastState();
    });

    // ── Rzut ───────────────────────────────────────────────
    socket.on('roll', () => {
      if (!game || game.phase !== 'playing') return;
      if (!isPlayer || game.players[game.turnIndex] !== color) return;
      // Można rzucać: gdy brak dice lub mustRollAgain
      if (game.dice !== null && !game.mustRollAgain) return;

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

      // Brak ruchów
      if (game.movablePieces.length === 0) {
        if (game.mustRollAgain) {
          // Dostał 6 ale nie ma co ruszyć — niech rzuca dalej
          game.dice = null;
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

      applyMove(game, color, pieceId);

      if (game.phase === 'over') {
        broadcastState();
        broadcast('game_over', { winner: game.winner });
        return;
      }

      if (game.mustRollAgain) {
        // Dostał 6 → ruch wykonany → resetuj dice, niech rzuca znów
        game.dice          = null;
        game.movablePieces = [];
        broadcastState();
      } else {
        game.movablePieces = [];
        broadcastState();
        setTimeout(() => { nextTurn(game); broadcastState(); }, 600);
      }
    });

    // ── Restart ────────────────────────────────────────────
    socket.on('restart_vote', ({ vote }) => {
      if (!isPlayer) return;
      vote ? restartVotes.add(socket.id) : restartVotes.delete(socket.id);
      broadcast('restart_votes', { count: restartVotes.size });

      if (restartVotes.size >= lobbyPlayers && lobbyPlayers >= 2) {
        const active = COLORS.filter(c => playerMap[c]);
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

      if (info.isPlayer) {
        delete playerMap[info.color];
        lobbyPlayers--;
        restartVotes.delete(socket.id);

        if (game) {
          game.players = game.players.filter(c => c !== info.color);
          delete game.pieces[info.color];

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

        broadcast('player_left', { color: info.color });
        broadcast('lobby', { players: lobbyPlayers, spectators });
      } else {
        spectators--;
      }
    });
  });
};