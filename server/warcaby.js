'use strict';

const GRACE_MS = 60_000;

module.exports = function registerWarcaby(io) {

  const checkersRooms = new Map();
  const warcabyNS = io.of('/warcaby');

  function createCheckersRoom(id) {
    return {
      id,
      // slots: { p1: {socketId, token, gracePending}, p2: ... }
      slots:        { p1: null, p2: null },
      tokenMap:     {},   // token → 'p1'|'p2'
      graceTimers:  {},   // 'p1'|'p2' → timeoutId
      spectators:   [],
      board:        initCheckersBoard(),
      turn:         1,
      phase:        'waiting',
      mustContinue: null,
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

  function getAllMoves(board, player, continuationSquare = null) {
    const moves = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p || p.player !== player) continue;
        const isContinuation = !!(continuationSquare && continuationSquare.row === r && continuationSquare.col === c);
        moves.push(...getMovesForPiece(r, c, board, player, p.king, isContinuation));
      }
    }
    return moves;
  }

  function getMovesForPiece(row, col, board, player, isKing, isContinuation = false) {
    const moves = [];
    const moveDirs = isKing
      ? [[-1,-1],[-1,1],[1,-1],[1,1]]
      : player === 1 ? [[-1,-1],[-1,1]] : [[1,-1],[1,1]];

    if (!isContinuation) {
      for (const [dr, dc] of moveDirs) {
        const nr = row + dr, nc = col + dc;
        if (inBounds(nr, nc) && !board[nr][nc]) {
          moves.push({ from: {row, col}, to: {row: nr, col: nc}, captures: [] });
        }
      }
    }

    const captureDirs = (isKing || isContinuation)
      ? [[-1,-1],[-1,1],[1,-1],[1,1]]
      : moveDirs;

    for (const [dr, dc] of captureDirs) {
      const nr = row + dr, nc = col + dc;
      if (!inBounds(nr, nc)) continue;
      if (board[nr][nc] && board[nr][nc].player !== player) {
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
    if (piece.player === 1 && move.to.row === 0) piece.king = true;
    if (piece.player === 2 && move.to.row === 7) piece.king = true;
    return b;
  }

  function checkWinner(board) {
    const has1 = board.flat().some(p => p && p.player === 1);
    const has2 = board.flat().some(p => p && p.player === 2);
    if (!has1) return 2;
    if (!has2) return 1;
    return null;
  }

  function activePlayers(room) {
    return ['p1','p2'].filter(k => room.slots[k]?.socketId).length;
  }

  function findOrCreateCheckersRoom() {
    for (const [, room] of checkersRooms) {
      if (!room.slots.p1 || !room.slots.p2) return room;
    }
    const id   = 'croom_' + Math.random().toString(36).slice(2, 8);
    const room = createCheckersRoom(id);
    checkersRooms.set(id, room);
    return room;
  }

  function releaseSlot(room, slotKey) {
    const slot = room.slots[slotKey];
    if (!slot) return;
    if (slot.token) delete room.tokenMap[slot.token];
    room.slots[slotKey] = null;
    delete room.graceTimers[slotKey];

    const playerNum = slotKey === 'p1' ? 1 : 2;
    room.phase = 'waiting';
    warcabyNS.to(room.id).emit('player_left', { player: playerNum });
    warcabyNS.to(room.id).emit('lobby', {
      players:    activePlayers(room),
      spectators: room.spectators.length,
    });

    if (!room.slots.p1 && !room.slots.p2 && room.spectators.length === 0) {
      checkersRooms.delete(room.id);
    }
  }

  function doCheckersRestart(room) {
    room.board        = initCheckersBoard();
    room.turn         = 1;
    room.phase        = 'playing';
    room.mustContinue = null;
    room.restartVotes.clear();
    warcabyNS.to(room.id).emit('restart',       { boardState: room.board, turn: room.turn });
    warcabyNS.to(room.id).emit('restart_votes', { count: 0 });
  }

  warcabyNS.on('connection', (socket) => {
    const clientToken = socket.handshake.auth?.token || null;

    let room      = null;
    let slotKey   = null;
    let playerNum = null;

    // Spróbuj rejoin po tokenie
    if (clientToken) {
      for (const [, r] of checkersRooms) {
        if (r.tokenMap[clientToken]) {
          const key  = r.tokenMap[clientToken];
          const slot = r.slots[key];
          if (slot && slot.token === clientToken) {
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

    // Nowe połączenie
    if (!room) {
      room = findOrCreateCheckersRoom();
      socket.join(room.id);

      if (!room.slots.p1 || !room.slots.p2) {
        slotKey   = !room.slots.p1 ? 'p1' : 'p2';
        playerNum = slotKey === 'p1' ? 1 : 2;
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        room.slots[slotKey]  = { socketId: socket.id, token, gracePending: false };
        room.tokenMap[token] = slotKey;
      } else {
        room.spectators.push(socket.id);
      }
    } else {
      socket.join(room.id);
    }

    const myToken = slotKey ? room.slots[slotKey]?.token : null;
    socket.emit('assigned', { player: playerNum || 0, roomId: room.id, token: myToken });

    warcabyNS.to(room.id).emit('lobby', {
      players:    activePlayers(room),
      spectators: room.spectators.length,
    });

    // Wznów grę po rejoin
    if (activePlayers(room) === 2 && room.phase === 'waiting' && room.board) {
      room.phase = 'playing';
      warcabyNS.to(room.id).emit('start', { boardState: room.board, turn: room.turn });
    } else if (room.phase === 'playing') {
      // Odeślij aktualny stan powracającemu graczowi
      socket.emit('start', { boardState: room.board, turn: room.turn });
      socket.emit('state', {
        boardState:   room.board,
        turn:         room.turn,
        phase:        room.phase,
        mustContinue: room.mustContinue,
      });
    }

    socket.on('move', (move) => {
      if (room.phase !== 'playing' || playerNum !== room.turn) return;

      if (room.mustContinue &&
          (move.from.row !== room.mustContinue.row || move.from.col !== room.mustContinue.col)) {
        socket.emit('invalid_move');
        return;
      }

      const allMoves   = getAllMoves(room.board, room.turn, room.mustContinue);
      const hasCapture = allMoves.some(m => m.captures.length > 0);
      const legal      = allMoves.filter(m =>
        m.from.row === move.from.row && m.from.col === move.from.col &&
        m.to.row  === move.to.row   && m.to.col  === move.to.col   &&
        (!hasCapture || m.captures.length > 0)
      );

      if (legal.length === 0) { socket.emit('invalid_move'); return; }

      const movedPlayer = room.turn;
      room.board = applyMove(room.board, legal[0]);

      let mustContinue = null;
      if (legal[0].captures.length > 0) {
        const landedPiece = room.board[legal[0].to.row][legal[0].to.col];
        const furtherCaptures = getMovesForPiece(
          legal[0].to.row, legal[0].to.col, room.board, movedPlayer, landedPiece.king, true
        ).filter(m => m.captures.length > 0);
        if (furtherCaptures.length > 0) {
          mustContinue = { row: legal[0].to.row, col: legal[0].to.col };
        }
      }

      room.turn         = mustContinue ? movedPlayer : (movedPlayer === 1 ? 2 : 1);
      room.mustContinue = mustContinue;

      const winner = checkWinner(room.board);
      if (winner) {
        room.phase = 'over';
        warcabyNS.to(room.id).emit('game_over', { winner });
      } else {
        if (!mustContinue) {
          const nextMoves = getAllMoves(room.board, room.turn);
          if (nextMoves.length === 0) {
            room.phase = 'over';
            warcabyNS.to(room.id).emit('game_over', { winner: room.turn === 1 ? 2 : 1 });
            return;
          }
        }
        warcabyNS.to(room.id).emit('state', {
          boardState: room.board,
          turn:       room.turn,
          phase:      room.phase,
          mustContinue,
        });
      }
    });

    socket.on('restart_vote', ({ vote }) => {
      if (!slotKey) return;
      vote ? room.restartVotes.add(slotKey) : room.restartVotes.delete(slotKey);
      const count = room.restartVotes.size;
      warcabyNS.to(room.id).emit('restart_votes', { count });
      if (count >= 2) doCheckersRestart(room);
    });

    socket.on('disconnect', () => {
      if (slotKey) {
        room.restartVotes.delete(slotKey);
        const slot = room.slots[slotKey];
        if (slot) {
          slot.socketId     = null;
          slot.gracePending = true;

          warcabyNS.to(room.id).emit('player_away', { player: playerNum });

          room.graceTimers[slotKey] = setTimeout(() => {
            releaseSlot(room, slotKey);
          }, GRACE_MS);
        }
      } else {
        room.spectators = room.spectators.filter(id => id !== socket.id);
        warcabyNS.to(room.id).emit('lobby', {
          players:    activePlayers(room),
          spectators: room.spectators.length,
        });
      }
    });
  });
};