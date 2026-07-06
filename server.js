'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
});

app.use(express.static('public'));

// SPA fallback — każda gra serwuje własny index.html (z ukośnikiem i bez)
app.get('/cymbergaj(/)?', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cymbergaj',  'index.html')));
app.get('/warcaby(/)?',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'warcaby',    'index.html')));
app.get('/kosci(/)?',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'kosci',      'index.html')));
app.get('/chinczyk(/)?',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'chinczyk',   'index.html')));

// ── Rejestracja logiki każdej gry ────────────────────────────────────────────
require('./server/cymbergaj')(io);
require('./server/warcaby')(io);
require('./server/kosci')(io);
require('./server/chinczyk')(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));