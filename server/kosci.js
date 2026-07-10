'use strict';

const GRACE_MS = 60_000;

module.exports = function registerKosci(io) {

  const diceRooms = new Map();
  const MAX_DICE_PLAYERS = 5;
  const diceNS = io.of('/kosci');

  const CATEGORIES = [
    { key: 'ones',          label: 'Jedynki',      upper: true,  value: 1 },
    { key: 'twos',          label: 'Dwójki',       upper: true,  value: 2 },
    { key: 'threes',        label: 'Trójki',       upper: true,  value: 3 },
    { key: 'fours',         label: 'Czwórki',      upper: true,  value: 4 },
    { key: 'fives',         label: 'Piątki',       upper: true,  value: 5 },
    { key: 'sixes',         label: 'Szóstki',      upper: true,  value: 6 },
    { key: 'threeKind',     label: '3 jednakowe',  upper: false },
    { key: 'fourKind',      label: '4 jednakowe',  upper: false },
    { key: 'fullHouse',     label: 'Full',         upper: false },
    { key: 'smallStraight', label: 'Mały strit',   upper: false },
    { key: 'largeStraight', label: 'Duży strit',   upper: false },
    { key: 'yahtzee',       label: 'Generał',      upper: false },
    { key: 'chance',        label: 'Szansa',       upper: false },
  ];

  function diceCounts(dice) {
    const c = {};
    dice.forEach(d => c[d] = (c[d] || 0) + 1);
    return c;
  }

  function scoreFor(dice, key) {
    const cat = CATEGORIES.find(c => c.key === key);
    if (cat.upper) {
      return (diceCounts(dice)[cat.value] || 0) * cat.value;
    }
    const counts = diceCounts(dice);
    const sum    = dice.reduce((a, b) => a + b, 0);
    const vals   = Object.values(counts);
    const uniqueSorted = [...new Set(dice)].sort((a, b) => a - b);

    switch (key) {
      case 'threeKind': return vals.some(c => c >= 3) ? sum : 0;
      case 'fourKind':  return vals.some(c => c >= 4) ? sum : 0;
      case 'fullHouse': {
        const sv = [...vals].sort();
        return (sv.length === 2 && sv[0] === 2 && sv[1] === 3) ? 25 : 0;
      }
      case 'smallStraight':
        return ['1234','2345','3456'].some(seq =>
          seq.split('').every(ch => uniqueSorted.includes(Number(ch)))
        ) ? 30 : 0;
      case 'largeStraight': {
        const s = uniqueSorted.join('');
        return (s === '12345' || s === '23456') ? 40 : 0;
      }
      case 'yahtzee': return vals.some(c => c === 5) ? 50 : 0;
      case 'chance':  return sum;
      default: return 0;
    }
  }

  function emptyScoreCard() {
    const card = { yahtzeeBonusCount: 0 };
    CATEGORIES.forEach(c => card[c.key] = null);
    return card;
  }

  function upperSum(card) {
    return CATEGORIES.filter(c => c.upper).reduce((a, c) => a + (card[c.key] || 0), 0);
  }

  function totalScore(card) {
    const upper = upperSum(card);
    const bonus = upper >= 63 ? 35 : 0;
    const lower = CATEGORIES.filter(c => !c.upper).reduce((a, c) => a + (card[c.key] || 0), 0);
    return upper + bonus + lower + card.yahtzeeBonusCount * 100;
  }

  function createDiceRoom(id) {
    return {
      id,
      // slots: Map od playerIndex (0..4) → { socketId, token, gracePending }
      slots:        [],
      tokenMap:     {},   // token → slotIndex
      graceTimers:  {},   // slotIndex → timeoutId
      spectators:   [],
      phase:        'waiting',
      dice:         [1, 1, 1, 1, 1],
      held:         [false, false, false, false, false],
      rollsLeft:    3,
      turnIndex:    0,
      scores:       {},   // slotIndex → card
      restartVotes: new Set(),
    };
  }

  function activePlayers(room) {
    return room.slots.filter(s => s?.socketId).length;
  }

  function activePlayerCount(room) {
    return activePlayers(room);
  }

  function findOrCreateDiceRoom() {
    for (const [, room] of diceRooms) {
      if (room.phase === 'waiting' && room.slots.length < MAX_DICE_PLAYERS) return room;
    }
    const id = 'droom_' + Math.random().toString(36).slice(2, 8);
    const room = createDiceRoom(id);
    diceRooms.set(id, room);
    return room;
  }

  function diceRoomPublicState(room) {
    // Budujemy tablicę socketId w kolejności slotów — serwer wysyła
    // players jako listę socketId (klient używa indeksu)
    const players = room.slots.map(s => s?.socketId || null);
    return {
      phase:     room.phase,
      dice:      room.dice,
      held:      room.held,
      rollsLeft: room.rollsLeft,
      turnIndex: room.turnIndex,
      players,
      scores:    room.scores,
    };
  }

  function isGameOver(room) {
    return room.slots.every((s, i) =>
      !s || CATEGORIES.every(c => room.scores[i]?.[c.key] !== null)
    );
  }

  function advanceDiceTurn(room) {
    room.dice      = [1, 1, 1, 1, 1];
    room.held      = [false, false, false, false, false];
    room.rollsLeft = 3;
    // Pomiń wolne sloty (gracz wyszedł)
    let next = (room.turnIndex + 1) % room.slots.length;
    let safety = room.slots.length;
    while (!room.slots[next]?.socketId && safety-- > 0) {
      next = (next + 1) % room.slots.length;
    }
    room.turnIndex = next;
  }

  function doDiceRestart(room) {
    room.phase     = 'playing';
    room.dice      = [1, 1, 1, 1, 1];
    room.held      = [false, false, false, false, false];
    room.rollsLeft = 3;
    room.turnIndex = 0;
    room.scores    = {};
    room.slots.forEach((s, i) => { if (s) room.scores[i] = emptyScoreCard(); });
    room.restartVotes.clear();
    diceNS.to(room.id).emit('restart',       diceRoomPublicState(room));
    diceNS.to(room.id).emit('restart_votes', { count: 0 });
  }

  function releaseSlot(room, slotIndex) {
    const slot = room.slots[slotIndex];
    if (!slot) return;
    if (slot.token) delete room.tokenMap[slot.token];
    room.slots[slotIndex] = null;
    delete room.graceTimers[slotIndex];

    const playerNum = slotIndex + 1;
    diceNS.to(room.id).emit('player_left', { player: playerNum });
    diceNS.to(room.id).emit('lobby', {
      players:    activePlayers(room),
      spectators: room.spectators.length,
    });

    if (room.slots.every(s => !s) && room.spectators.length === 0) {
      diceRooms.delete(room.id);
    }
  }

  diceNS.on('connection', (socket) => {
    const clientToken = socket.handshake.auth?.token || null;

    let room       = null;
    let slotIndex  = -1;  // indeks w room.slots, lub -1 jeśli widz
    let playerNum  = null; // 1-based dla klienta

    // Spróbuj rejoin po tokenie
    if (clientToken) {
      for (const [, r] of diceRooms) {
        if (r.tokenMap[clientToken] !== undefined) {
          const idx  = r.tokenMap[clientToken];
          const slot = r.slots[idx];
          if (slot && slot.token === clientToken) {
            if (r.graceTimers[idx] !== undefined) {
              clearTimeout(r.graceTimers[idx]);
              delete r.graceTimers[idx];
            }
            room       = r;
            slotIndex  = idx;
            playerNum  = idx + 1;
            slot.socketId     = socket.id;
            slot.gracePending = false;
            break;
          }
        }
      }
    }

    // Nowe połączenie
    if (!room) {
      room = findOrCreateDiceRoom();
      socket.join(room.id);

      if (room.phase === 'waiting' && room.slots.length < MAX_DICE_PLAYERS) {
        slotIndex = room.slots.length;
        playerNum = slotIndex + 1;
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        room.slots.push({ socketId: socket.id, token, gracePending: false });
        room.tokenMap[token] = slotIndex;
        room.scores[slotIndex] = emptyScoreCard();
      } else {
        room.spectators.push(socket.id);
      }
    } else {
      socket.join(room.id);
    }

    const myToken = slotIndex >= 0 ? room.slots[slotIndex]?.token : null;
    socket.emit('assigned', {
      player:      playerNum || 0,
      roomId:      room.id,
      playerIndex: slotIndex,
      token:       myToken,
    });

    diceNS.to(room.id).emit('lobby', {
      players:    activePlayers(room),
      spectators: room.spectators.length,
    });

    // Odeślij aktualny stan (po rejoin lub nowe wejście do trwającej gry)
    if (room.phase === 'playing' || room.phase === 'over') {
      socket.emit('state', diceRoomPublicState(room));
    }

    socket.on('start_game', () => {
      if (room.phase !== 'waiting' || activePlayers(room) < 2) return;
      room.phase = 'playing';
      diceNS.to(room.id).emit('state', diceRoomPublicState(room));
    });

    socket.on('roll', () => {
      if (room.phase !== 'playing') return;
      if (slotIndex !== room.turnIndex) return;
      if (room.rollsLeft <= 0) return;

      room.dice = room.dice.map((v, i) => room.held[i] ? v : (1 + Math.floor(Math.random() * 6)));
      room.rollsLeft--;
      diceNS.to(room.id).emit('state', diceRoomPublicState(room));
    });

    socket.on('hold', ({ index }) => {
      if (room.phase !== 'playing') return;
      if (slotIndex !== room.turnIndex) return;
      if (room.rollsLeft === 3) return;
      if (index < 0 || index > 4) return;
      room.held[index] = !room.held[index];
      diceNS.to(room.id).emit('state', diceRoomPublicState(room));
    });

    socket.on('score', ({ category }) => {
      if (room.phase !== 'playing') return;
      if (slotIndex !== room.turnIndex) return;
      if (room.rollsLeft === 3) return;
      const card = room.scores[slotIndex];
      if (!card || !CATEGORIES.some(c => c.key === category) || card[category] !== null) return;

      const value = scoreFor(room.dice, category);
      card[category] = value;

      const isYahtzeeRoll = Object.values(diceCounts(room.dice)).some(c => c === 5);
      if (isYahtzeeRoll && category !== 'yahtzee' && card.yahtzee === 50) {
        card.yahtzeeBonusCount++;
      }

      if (isGameOver(room)) {
        room.phase = 'over';
        const totals = room.slots.map((s, i) => ({
          pid:   i,
          total: room.scores[i] ? totalScore(room.scores[i]) : 0,
        }));
        const best = totals.reduce((a, b) => (b.total > a.total ? b : a));
        diceNS.to(room.id).emit('game_over', {
          scores:      room.scores,
          totals,
          winnerIndex: best.pid,
        });
      } else {
        advanceDiceTurn(room);
        diceNS.to(room.id).emit('state', diceRoomPublicState(room));
      }
    });

    socket.on('restart_vote', ({ vote }) => {
      if (slotIndex < 0) return;
      const key = `p${slotIndex}`;
      vote ? room.restartVotes.add(key) : room.restartVotes.delete(key);
      const count = room.restartVotes.size;
      diceNS.to(room.id).emit('restart_votes', { count });
      if (count >= 2) doDiceRestart(room);
    });

    socket.on('disconnect', () => {
      if (slotIndex >= 0) {
        room.restartVotes.delete(`p${slotIndex}`);
        const slot = room.slots[slotIndex];
        if (slot) {
          slot.socketId     = null;
          slot.gracePending = true;

          diceNS.to(room.id).emit('player_away', { player: playerNum });

          room.graceTimers[slotIndex] = setTimeout(() => {
            releaseSlot(room, slotIndex);
          }, GRACE_MS);
        }
      } else {
        room.spectators = room.spectators.filter(id => id !== socket.id);
        diceNS.to(room.id).emit('lobby', {
          players:    activePlayers(room),
          spectators: room.spectators.length,
        });
      }
    });
  });
};