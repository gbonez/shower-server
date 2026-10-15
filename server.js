'use strict';

// Relay server for Shower Racing rooms. It only tracks room membership (4-character codes,
// up to 20 players) and forwards messages; the host player's game holds all game state.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 20;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const MESSAGES_PER_SECOND = 120;

// code -> { members: Map(id -> { ws, name }), hostId, nextId }
const rooms = new Map();

function makeCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  for (const [id, member] of room.members) {
    if (id !== exceptId) send(member.ws, obj);
  }
}

function cleanName(name) {
  const cleaned = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16);
  return cleaned || 'Player';
}

function peerList(room) {
  return [...room.members].map(([id, member]) => ({ id, name: member.name }));
}

function joinRoom(ws, room, code, name) {
  const id = room.nextId++;
  room.members.set(id, { ws, name });
  ws.room = code;
  ws.id = id;
  send(ws, { t: 'joined', code, id, hostId: room.hostId, peers: peerList(room) });
  broadcast(room, { t: 'peer_joined', id, name }, id);
}

function leaveRoom(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  const code = ws.room;
  ws.room = null;
  if (!room) return;
  room.members.delete(ws.id);
  if (room.members.size === 0) {
    rooms.delete(code);
    return;
  }
  broadcast(room, { t: 'peer_left', id: ws.id });
  if (room.hostId === ws.id) {
    room.hostId = room.members.keys().next().value; // longest-present player takes over
    broadcast(room, { t: 'host_changed', id: room.hostId });
  }
}

function handle(ws, msg) {
  switch (msg.t) {
    case 'host': {
      if (ws.room) return send(ws, { t: 'error', msg: 'Already in a room.' });
      const code = makeCode();
      const room = { members: new Map(), hostId: 1, nextId: 1 };
      rooms.set(code, room);
      joinRoom(ws, room, code, cleanName(msg.name));
      break;
    }
    case 'join': {
      if (ws.room) return send(ws, { t: 'error', msg: 'Already in a room.' });
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', msg: 'Room not found.' });
      if (room.members.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Room is full.' });
      joinRoom(ws, room, code, cleanName(msg.name));
      break;
    }
    case 'msg': {
      const room = ws.room && rooms.get(ws.room);
      if (!room || typeof msg.data !== 'object' || msg.data === null) return;
      const packet = { t: 'msg', from: ws.id, data: msg.data };
      if (msg.to === 'all') {
        broadcast(room, packet, ws.id);
      } else if (typeof msg.to === 'number') {
        const target = room.members.get(msg.to);
        if (target) send(target.ws, packet);
      }
      break;
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('shower-racing relay\n');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.id = 0;
  ws.budget = MESSAGES_PER_SECOND;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    if (ws.budget-- <= 0) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (msg && typeof msg === 'object') handle(ws, msg);
  });
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    ws.budget = MESSAGES_PER_SECOND;
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 1000 * 15);

server.listen(PORT, () => console.log(`Relay listening on ${PORT}`));
