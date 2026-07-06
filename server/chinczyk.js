
// ─────────────────────────────────────────────────────────────────────────────
// CHIŃCZYK — logika serwera
// Plansza: 40 pól wspólnej trasy + 4 kolory × 4 pola domu + 4 bazy startowe
//
// Numeracja wspólnej trasy (0–39), punkty startowe i wejścia do domu:
//   Czerwony: start=0,  baza=[0..3],  wejście po polu 39, dom=[40..43]
//   Niebieski: start=10, baza=[4..7],  wejście po polu 9,  dom=[44..47]
//   Żółty:   start=20, baza=[8..11], wejście po polu 19, dom=[48..51]
//   Zielony: start=30, baza=[12..15],wejście po polu 29, dom=[52..55]
//
// Bezpieczne pola: pole startowe każdego koloru (0,10,20,30) + dom (40-55)
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = ['red','blue','yellow','green'];

const COLOR_CFG = {
  red:    { startField: 0,  homeOffset: 40, baseIds: [0,1,2,3]   },
  blue:   { startField: 10, homeOffset: 44, baseIds: [4,5,6,7]   },
  yellow: { startField: 20, homeOffset: 48, baseIds: [8,9,10,11] },
  green:  { startField: 30, homeOffset: 52, baseIds: [12,13,14,15] },
};

// Pola "bezpieczne" na wspólnej trasie — nie można tam bić
const SAFE_FIELDS = new Set([0, 10, 20, 30]);

function makeGame(playerCount) {
  // Pionki: każdy gracz ma 4 pionki; position:
  //   -1          = baza (czeka na starcie)
  //   0..39       = wspólna trasa
  //   40..55      = domowe pola (zakres zależy od koloru, patrz homeOffset)
  //   56          = meta (wygrana, poza planszą)
  const pieces = {};
  const players = COLORS.slice(0, playerCount);
  for (const color of players) {
    pieces[color] = [
      { id: 0, color, pos: -1 },
      { id: 1, color, pos: -1 },
      { id: 2, color, pos: -1 },
      { id: 3, color, pos: -1 },
    ];
  }
  return {
    phase: 'playing',
    players,
    pieces,
    turnIndex: 0,
    dice: null,          // ostatni wynik rzutu
    sixStreak: 0,        // ile 6-tek pod rząd
    mustRollAgain: false,// po 6 gracz rzuca ponownie
    movablePieces: [],   // które pionki mogą się ruszyć (tablica {color,id,steps})
    winner: null,
  };
}

// Zwraca absolutne pole na "linearnej" trasie gracza (0 = baza, 1..40 = trasa + dom, 41..44 = meta)
// pos -1 = baza
// Dla wyznaczania kolizji używamy wspólnej trasy (0..39); dom (homeOffset+0..+3) jest prywatny.
function getLinearPos(color, pos) {
  // pos -1 = baza
  if (pos === -1) return -1;
  const cfg = COLOR_CFG[color];
  // dom
  if (pos >= cfg.homeOffset && pos < cfg.homeOffset + 4) return null; // prywatne, bez kolizji
  if (pos === 56) return null;
  return pos;
}

// Oblicza nowe pole po ruchu o `steps` kroków
// Zwraca: { newPos, valid }
function calcMove(color, currentPos, steps) {
  const cfg = COLOR_CFG[color];
  const homeStart = cfg.homeOffset;
  const entryField = (cfg.startField + 39) % 40; // pole przed wejściem do domu

  if (currentPos === -1) {
    // Z bazy można wyjść tylko na 6
    if (steps !== 6) return { newPos: -1, valid: false };
    return { newPos: cfg.startField, valid: true };
  }

  // Oblicz ile kroków na wspólnej trasie zostało do wejścia do domu
  // Trasa gracza zaczyna się od cfg.startField
  // "postęp" gracza na trasie: 0 = startField, 39 = pole tuż przed powrotem do domu
  let progress = (currentPos - cfg.startField + 40) % 40;

  // Wejście do domu następuje po okrążeniu (progress >= 40 = "home entry")
  // progress 0..39 = wspólna trasa
  // po polu o progress=39 wchodzimy do domu (slot 0..3)
  // Ile kroków potrzeba żeby dojść do wejścia domu od obecnej pozycji?
  const stepsToHomeEntry = 40 - progress; // po ilu krokach jesteśmy "przy wejściu"

  // Jeśli jesteśmy już w domu
  if (currentPos >= homeStart && currentPos < homeStart + 4) {
    const homeSlot = currentPos - homeStart; // 0..3
    const newSlot  = homeSlot + steps;
    if (newSlot > 3) return { newPos: currentPos, valid: false }; // za daleko
    if (newSlot === 4) return { newPos: 56, valid: true }; // wygrana — ale 4 slotów, więc nigdy tu
    return { newPos: homeStart + newSlot, valid: true };
  }

  if (steps < stepsToHomeEntry) {
    // Ruch na wspólnej trasie
    const newPos = (currentPos + steps) % 40;
    return { newPos, valid: true };
  } else if (steps === stepsToHomeEntry) {
    // Wchodzi dokładnie na "wejście" (slot 0 domu)
    return { newPos: homeStart, valid: true };
  } else {
    // Wchodzi do domu o steps - stepsToHomeEntry kroków
    const homeSlot = steps - stepsToHomeEntry - 1;
    if (homeSlot > 3) return { newPos: currentPos, valid: false }; // za daleko
    return { newPos: homeStart + homeSlot, valid: true };
  }
}

// Zbiera wszystkie możliwe ruchy dla aktywnego gracza
function getMovable(game) {
  const color = game.players[game.turnIndex];
  const cfg   = COLOR_CFG[color];
  const dice  = game.dice;
  if (dice === null) return [];

  const movable = [];

  for (const piece of game.pieces[color]) {
    if (piece.pos === 56) continue; // już w meta

    const { newPos, valid } = calcMove(color, piece.pos, dice);
    if (!valid) continue;

    // Sprawdź czy na polu nie stoi już własny pionek
    const blocked = game.pieces[color].some(p => p.pos === newPos && p.id !== piece.id);
    if (blocked) continue;

    movable.push({ color, id: piece.id, steps: dice, newPos });
  }
  return movable;
}

// Wykonaj ruch
function applyMove(game, color, pieceId) {
  const cfg   = COLOR_CFG[color];
  const piece = game.pieces[color].find(p => p.id === pieceId);
  if (!piece) return;

  const { newPos } = calcMove(color, piece.pos, game.dice);
  const oldPos = piece.pos;
  piece.pos = newPos;

  // Sprawdź bicie — tylko na wspólnej trasie (0..39), nie na bezpiecznych polach, nie w domu
  if (newPos >= 0 && newPos < 40 && !SAFE_FIELDS.has(newPos)) {
    for (const otherColor of game.players) {
      if (otherColor === color) continue;
      for (const op of game.pieces[otherColor]) {
        if (op.pos === newPos) {
          // Zepchnij na bazę
          op.pos = -1;
        }
      }
    }
  }

  // Sprawdź wygraną — wszyscy 4 pionki w meta (56) lub w domu slot 4 (nieużywany — użyjemy 56)
  const homeStart = cfg.homeOffset;
  const allHome = game.pieces[color].every(p => p.pos === 56 || (p.pos >= homeStart && p.pos < homeStart + 4));
  // Wygrywa gdy wszystkie na polach domu (homeStart..homeStart+3) AND newPos jest ostatnim:
  // Faktycznie wygranie = wszystkie 4 pionki na homeStart+3 lub 56
  const won = game.pieces[color].every(p => p.pos === homeStart + 3 || p.pos === 56);
  // Lepiej: wygrana gdy wszystkie 4 w domu (pozycja >= homeStart i < homeStart+4, czyli max homeStart+3)
  const wonCheck = game.pieces[color].every(p => {
    const h = COLOR_CFG[p.color].homeOffset;
    return p.pos >= h && p.pos < h + 4;
  });
  if (wonCheck) {
    game.winner = color;
    game.phase  = 'over';
  }
}

// Przejdź do następnej tury
function nextTurn(game) {
  game.dice         = null;
  game.movablePieces = [];
  game.mustRollAgain = false;
  // sixStreak resetuje się przy zmianie gracza
  game.sixStreak    = 0;
  game.turnIndex    = (game.turnIndex + 1) % game.players.length;
  // Pomijamy graczy którzy już wygrali (wszystkie pionki w domu)
  let safety = game.players.length;
  while (safety-- > 0) {
    const c   = game.players[game.turnIndex];
    const cfg = COLOR_CFG[c];
    const done = game.pieces[c].every(p => p.pos >= cfg.homeOffset && p.pos < cfg.homeOffset + 4);
    if (!done) break;
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = function registerChinczyk(io) {
  const ns = io.of('/chinczyk');

  // Jeden pokój globalny
  let sockets   = new Map(); // socketId → { socket, player (kolor|null), playerIndex }
  let playerMap = {};        // color → socketId
  let game      = null;
  let waitingPlayers = [];   // kolejka kolorów dla nowych graczy
  let lobbyPlayers   = 0;
  let spectators     = 0;
  let restartVotes   = new Set();

  function broadcast(event, data) {
    ns.emit(event, data);
  }

  function stateSnapshot() {
    if (!game) return null;
    return {
      phase:        game.phase,
      players:      game.players,
      pieces:       game.pieces,
      turnIndex:    game.turnIndex,
      dice:         game.dice,
      movablePieces:game.movablePieces,
      mustRollAgain:game.mustRollAgain,
      winner:       game.winner,
    };
  }

  function broadcastState() {
    broadcast('state', stateSnapshot());
  }

  function assignColor() {
    for (const c of COLORS) {
      if (!playerMap[c]) return c;
    }
    return null; // brak wolnych miejsc
  }

  ns.on('connection', (socket) => {
    const color = assignColor();
    let myColor  = color;
    let isPlayer = !!color;

    if (isPlayer) {
      playerMap[color] = socket.id;
      lobbyPlayers++;
      sockets.set(socket.id, { socket, color, isPlayer: true });
    } else {
      spectators++;
      sockets.set(socket.id, { socket, color: null, isPlayer: false });
    }

    socket.emit('assigned', {
      color: myColor,
      isPlayer,
      colorIndex: myColor ? COLORS.indexOf(myColor) : -1,
    });

    broadcast('lobby', { players: lobbyPlayers, spectators });

    // Jeśli gra już trwa — wyślij aktualny stan
    if (game) {
      socket.emit('state', stateSnapshot());
    }

    // ── Start gry ──────────────────────────────────────────────────────────
    socket.on('start_game', () => {
      if (!isPlayer) return;
      if (lobbyPlayers < 2) return;
      if (game && game.phase === 'playing') return;

      const activePlayers = COLORS.filter(c => playerMap[c]);
      game = makeGame(activePlayers.length);
      // nadpisz kolejność kolorów zgodnie z aktualnymi graczami
      game.players = activePlayers;
      // resetuj pionki dla właściwych kolorów
      game.pieces = {};
      for (const c of activePlayers) {
        const cfg = COLOR_CFG[c];
        game.pieces[c] = [0,1,2,3].map(i => ({ id: i, color: c, pos: -1 }));
      }
      restartVotes.clear();
      broadcastState();
    });

    // ── Rzut kostką ───────────────────────────────────────────────────────
    socket.on('roll', () => {
      if (!game || game.phase !== 'playing') return;
      if (!isPlayer || game.players[game.turnIndex] !== myColor) return;
      if (game.dice !== null && !game.mustRollAgain) return; // już rzucił i nie dostał 6

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

      // Brak ruchów — automatycznie przejdź dalej
      if (game.movablePieces.length === 0) {
        if (game.mustRollAgain) {
          // Ma rzucać ponownie (dostał 6) ale nie ma ruchu — rzuca dalej
          game.dice = null;
          broadcastState();
          return;
        }
        broadcastState();
        setTimeout(() => {
          nextTurn(game);
          broadcastState();
        }, 900);
        return;
      }

      // Jeśli jest tylko jeden pionek do ruszenia — zrób ruch automatycznie? Nie — niech kliknie
      broadcastState();
    });

    // ── Ruch pionkiem ──────────────────────────────────────────────────────
    socket.on('move', ({ pieceId }) => {
      if (!game || game.phase !== 'playing') return;
      if (!isPlayer || game.players[game.turnIndex] !== myColor) return;
      if (game.dice === null) return;

      const movable = game.movablePieces.find(m => m.color === myColor && m.id === pieceId);
      if (!movable) return;

      applyMove(game, myColor, pieceId);

      if (game.phase === 'over') {
        broadcastState();
        broadcast('game_over', { winner: game.winner });
        return;
      }

      if (game.mustRollAgain) {
        // Gracz rzuca ponownie (dostał 6 i wykonał ruch)
        game.dice          = null;
        game.movablePieces = [];
        // mustRollAgain zostawiamy true żeby UI pokazało "rzuć ponownie"
        broadcastState();
      } else {
        game.movablePieces = [];
        broadcastState();
        setTimeout(() => {
          nextTurn(game);
          broadcastState();
        }, 600);
      }
    });

    // ── Restart ────────────────────────────────────────────────────────────
    socket.on('restart_vote', ({ vote }) => {
      if (!isPlayer) return;
      if (vote) restartVotes.add(socket.id);
      else restartVotes.delete(socket.id);
      broadcast('restart_votes', { count: restartVotes.size });

      if (restartVotes.size >= lobbyPlayers && lobbyPlayers >= 2) {
        const activePlayers = COLORS.filter(c => playerMap[c]);
        game = makeGame(activePlayers.length);
        game.players = activePlayers;
        game.pieces  = {};
        for (const c of activePlayers) {
          game.pieces[c] = [0,1,2,3].map(i => ({ id: i, color: c, pos: -1 }));
        }
        restartVotes.clear();
        broadcast('restart', stateSnapshot());
      }
    });

    // ── Rozłączenie ────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const info = sockets.get(socket.id);
      if (!info) return;
      sockets.delete(socket.id);

      if (info.isPlayer) {
        delete playerMap[info.color];
        lobbyPlayers--;
        if (game) {
          // Usuń gracza z gry
          game.players = game.players.filter(c => c !== info.color);
          delete game.pieces[info.color];
          // Jeśli była jego tura — przejdź dalej
          if (game.phase === 'playing') {
            if (game.players.length < 2) {
              game.phase = 'waiting';
            } else {
              game.turnIndex = game.turnIndex % game.players.length;
              game.dice = null;
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