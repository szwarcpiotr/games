// ══════════════════════════════════════════════════════════════════════════════
// KOŚCI (Yahtzee)
// ══════════════════════════════════════════════════════════════════════════════
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
      const c = diceCounts(dice);
      return (c[cat.value] || 0) * cat.value;
    }
    const counts = diceCounts(dice);
    const sum    = dice.reduce((a, b) => a + b, 0);
    const vals   = Object.values(counts);
    const uniqueSorted = [...new Set(dice)].sort((a, b) => a - b);

    switch (key) {
      case 'threeKind': return vals.some(c => c >= 3) ? sum : 0;
      case 'fourKind':  return vals.some(c => c >= 4) ? sum : 0;
      case 'fullHouse': {
        const sortedVals = [...vals].sort();
        return (sortedVals.length === 2 && sortedVals[0] === 2 && sortedVals[1] === 3) ? 25 : 0;
      }
      case 'smallStraight': {
        return ['1234', '2345', '3456'].some(seq =>
          seq.split('').every(ch => uniqueSorted.includes(Number(ch)))
        ) ? 30 : 0;
      }
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
      players:      [],     // socket id w kolejności tury
      spectators:   [],
      phase:        'waiting', // waiting | playing | over
      dice:         [1, 1, 1, 1, 1],
      held:         [false, false, false, false, false],
      rollsLeft:    3,
      turnIndex:    0,
      scores:       {},      // socketId -> card
      restartVotes: new Set(),
    };
  }

  function findOrCreateDiceRoom() {
    for (const [, room] of diceRooms) {
      if (room.phase === 'waiting' && room.players.length < MAX_DICE_PLAYERS) return room;
    }
    const id = 'droom_' + Math.random().toString(36).slice(2, 8);
    const room = createDiceRoom(id);
    diceRooms.set(id, room);
    return room;
  }

  function diceRoomPublicState(room) {
    return {
      phase:      room.phase,
      dice:       room.dice,
      held:       room.held,
      rollsLeft:  room.rollsLeft,
      turnIndex:  room.turnIndex,
      players:    room.players,
      scores:     room.scores,
    };
  }

  function isGameOver(room) {
    return room.players.every(pid =>
      CATEGORIES.every(c => room.scores[pid][c.key] !== null)
    );
  }

  function advanceDiceTurn(room) {
    room.dice      = [1, 1, 1, 1, 1];
    room.held      = [false, false, false, false, false];
    room.rollsLeft = 3;
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
  }

  function doDiceRestart(room) {
    room.phase        = 'playing';
    room.dice         = [1, 1, 1, 1, 1];
    room.held         = [false, false, false, false, false];
    room.rollsLeft    = 3;
    room.turnIndex    = 0;
    room.scores       = {};
    room.players.forEach(pid => room.scores[pid] = emptyScoreCard());
    room.restartVotes.clear();
    diceNS.to(room.id).emit('restart', diceRoomPublicState(room));
    diceNS.to(room.id).emit('restart_votes', { count: 0 });
  }

  diceNS.on('connection', (socket) => {
    const room = findOrCreateDiceRoom();
    socket.join(room.id);
    let playerNum = null; // pozycja 1..5, lub null jeśli widz

    if (room.phase === 'waiting' && room.players.length < MAX_DICE_PLAYERS) {
      room.players.push(socket.id);
      room.scores[socket.id] = emptyScoreCard();
      playerNum = room.players.length;
      socket.emit('assigned', { player: playerNum, roomId: room.id, playerIndex: playerNum - 1 });
    } else {
      room.spectators.push(socket.id);
      socket.emit('assigned', { player: 0, roomId: room.id, playerIndex: -1 });
    }

    diceNS.to(room.id).emit('lobby', { players: room.players.length, spectators: room.spectators.length });

    if (room.phase === 'playing' || room.phase === 'over') {
      socket.emit('state', diceRoomPublicState(room));
    }

    socket.on('start_game', () => {
      if (room.phase !== 'waiting' || room.players.length < 2) return;
      room.phase = 'playing';
      diceNS.to(room.id).emit('state', diceRoomPublicState(room));
    });

    socket.on('roll', () => {
      if (room.phase !== 'playing') return;
      const myIndex = room.players.indexOf(socket.id);
      if (myIndex !== room.turnIndex) return;
      if (room.rollsLeft <= 0) return;

      room.dice = room.dice.map((v, i) => room.held[i] ? v : (1 + Math.floor(Math.random() * 6)));
      room.rollsLeft--;
      diceNS.to(room.id).emit('state', diceRoomPublicState(room));
    });

    socket.on('hold', ({ index }) => {
      if (room.phase !== 'playing') return;
      const myIndex = room.players.indexOf(socket.id);
      if (myIndex !== room.turnIndex) return;
      if (room.rollsLeft === 3) return; // nie wykonano jeszcze pierwszego rzutu
      if (index < 0 || index > 4) return;
      room.held[index] = !room.held[index];
      diceNS.to(room.id).emit('state', diceRoomPublicState(room));
    });

    socket.on('score', ({ category }) => {
      if (room.phase !== 'playing') return;
      const myIndex = room.players.indexOf(socket.id);
      if (myIndex !== room.turnIndex) return;
      if (room.rollsLeft === 3) return; // musisz rzucić przynajmniej raz
      const card = room.scores[socket.id];
      if (!card || !CATEGORIES.some(c => c.key === category) || card[category] !== null) return;

      const value = scoreFor(room.dice, category);
      card[category] = value;

      // Premia za kolejnego Generała (jeśli kategoria "yahtzee" już wcześniej zapisana z wynikiem >0)
      const isYahtzeeRoll = Object.values(diceCounts(room.dice)).some(c => c === 5);
      if (isYahtzeeRoll && category !== 'yahtzee' && card.yahtzee === 50) {
        card.yahtzeeBonusCount++;
      }

      if (isGameOver(room)) {
        room.phase = 'over';
        const totals = room.players.map(pid => ({ pid, total: totalScore(room.scores[pid]) }));
        const best = totals.reduce((a, b) => (b.total > a.total ? b : a));
        diceNS.to(room.id).emit('game_over', {
          scores: room.scores,
          totals,
          winnerIndex: room.players.indexOf(best.pid),
        });
      } else {
        advanceDiceTurn(room);
        diceNS.to(room.id).emit('state', diceRoomPublicState(room));
      }
    });

    socket.on('restart_vote', ({ vote }) => {
      if (!playerNum) return;
      const key = `p${playerNum}`;
      if (vote) room.restartVotes.add(key);
      else      room.restartVotes.delete(key);
      const count = room.restartVotes.size;
      diceNS.to(room.id).emit('restart_votes', { count });
      if (count >= 2) doDiceRestart(room);
    });

    socket.on('disconnect', () => {
      if (playerNum) {
        room.players = room.players.filter(id => id !== socket.id);
        delete room.scores[socket.id];
        room.restartVotes.delete(`p${playerNum}`);
        room.phase = 'waiting';
        diceNS.to(room.id).emit('player_left', { player: playerNum });
        if (room.players.length === 0 && room.spectators.length === 0) {
          diceRooms.delete(room.id);
        }
      } else {
        room.spectators = room.spectators.filter(id => id !== socket.id);
      }
      diceNS.to(room.id).emit('lobby', { players: room.players.length, spectators: room.spectators.length });
    });
  });
};