'use strict';

// Relay server for Shower Racing rooms. It only tracks room membership (4-character codes,
// up to 20 players) and forwards messages; the host player's game holds all game state.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 20;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const MESSAGES_PER_SECOND = 120;
const CHAT_MAX_LENGTH = 200;
const CHAT_PER_SECOND = 3;

// code -> { members: Map(id -> { ws, name }), hostId, nextId, createdAt, phase, raceIndex,
//           banned: Map(lowercase name -> name), muted: Set(lowercase name) }
const rooms = new Map();

function log(message) {
  console.log(`${new Date().toISOString()}  ${message}`);
}

function roomTag(code) {
  return `[room ${code}]`;
}

function duration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

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

function cleanChat(text) {
  return String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
}

function peerList(room) {
  return [...room.members].map(([id, member]) => ({ id, name: member.name, muted: room.muted.has(member.name.toLowerCase()) }));
}

function notice(ws, msg) {
  send(ws, { t: 'notice', msg });
}

function banList(room) {
  return [...room.banned.values()].sort((a, b) => a.localeCompare(b));
}

function nameOf(room, id) {
  const member = room.members.get(id);
  return member ? member.name : `#${id}`;
}

function joinRoom(ws, room, code, name) {
  const id = room.nextId++;
  room.members.set(id, { ws, name });
  ws.room = code;
  ws.id = id;
  send(ws, { t: 'joined', code, id, hostId: room.hostId, peers: peerList(room) });
  broadcast(room, { t: 'peer_joined', id, name, muted: room.muted.has(name.toLowerCase()) }, id);
  log(`${roomTag(code)} "${name}" (#${id}) joined, ${room.members.size}/${MAX_PLAYERS} players`);
}

function leaveRoom(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  const code = ws.room;
  ws.room = null;
  if (!room) return;
  const name = nameOf(room, ws.id);
  room.members.delete(ws.id);
  log(`${roomTag(code)} "${name}" (#${ws.id}) left, ${room.members.size}/${MAX_PLAYERS} players`);
  if (room.members.size === 0) {
    rooms.delete(code);
    log(`${roomTag(code)} closed: the last player left (open for ${duration(Date.now() - room.createdAt)}, ${rooms.size} room(s) still open)`);
    return;
  }
  broadcast(room, { t: 'peer_left', id: ws.id });
  if (room.hostId === ws.id) {
    room.hostId = room.members.keys().next().value; // longest-present player takes over
    broadcast(room, { t: 'host_changed', id: room.hostId });
    log(`${roomTag(code)} host left, "${nameOf(room, room.hostId)}" (#${room.hostId}) is the new host`);
  }
}

// The host's game sends the full room state with every change; watching it tells the server when a
// game starts, a race begins or ends, and how the game finished.
function trackState(room, code, state) {
  const phase = String(state.phase || 'lobby');
  const index = Number(state.race_index) || 0;
  const plan = Array.isArray(state.race_plan) ? state.race_plan : [];
  const players = Array.isArray(state.players) ? state.players.length : room.members.size;
  const tag = roomTag(code);
  const label = `race ${index + 1}/${plan.length || '?'}`;
  const template = plan[index] && plan[index].template ? plan[index].template : '?';
  const reason = state.end_reason === 'host' ? 'ended by the host' : 'everyone finished';

  if (phase === 'starting' && room.phase !== 'starting') {
    log(`${tag} host started the game: counting down from ${Math.round(Number(state.countdown) || 5)} s`);
  }
  if (phase === 'lobby' && room.phase === 'starting') {
    log(`${tag} game start cancelled`);
  }
  if (phase === 'racing' && (room.phase === 'lobby' || room.phase === 'starting')) {
    const templates = [...new Set(plan.map((r) => r.template))].join(', ');
    log(`${tag} game started: ${players} player(s), ${plan.length} race(s) [${templates}]`);
  }
  if (phase === 'racing' && (room.phase !== 'racing' || index !== room.raceIndex)) {
    log(`${tag} ${label} started on "${template}"`);
  }
  if (phase === 'between' && room.phase === 'racing') {
    log(`${tag} ${label} finished (${reason})`);
  }
  if (phase === 'final_scores' && room.phase !== 'final_scores') {
    if (room.phase === 'racing') log(`${tag} ${label} finished (${reason})`);
    log(`${tag} game ended: ${state.end_reason === 'host' ? 'ended by the host' : 'reached its natural end'}`);
  }
  if (phase === 'final' && room.phase !== 'final') {
    log(`${tag} final results are showing`);
  }
  if (phase === 'lobby' && room.phase !== 'lobby') {
    log(`${tag} back in the lobby`);
  }
  room.phase = phase;
  room.raceIndex = index;
}

// Moderation. Only the room's host may do this, and never to themselves.
function handleAdmin(ws, msg) {
  const code = ws.room;
  const room = code && rooms.get(code);
  if (!room) return;
  if (room.hostId !== ws.id) return notice(ws, 'Only the host can do that.');
  const tag = roomTag(code);
  const hostName = nameOf(room, ws.id);
  const action = String(msg.action || '');

  if (action === 'bans') return send(ws, { t: 'bans', names: banList(room) });
  if (action === 'unban') {
    const name = String(msg.name || '');
    if (room.banned.delete(name.toLowerCase())) log(`${tag} host "${hostName}" unbanned "${name}"`);
    return send(ws, { t: 'bans', names: banList(room) });
  }

  const targetId = Number(msg.target);
  if (targetId === ws.id) return notice(ws, "You can't do that to yourself.");
  const target = room.members.get(targetId);
  if (!target) return notice(ws, 'That player is no longer here.');
  const targetName = target.name;
  const key = targetName.toLowerCase();

  switch (action) {
    case 'kick':
      log(`${tag} host "${hostName}" kicked "${targetName}" (#${targetId})`);
      send(target.ws, { t: 'kicked', reason: 'You were kicked by the host.' });
      leaveRoom(target.ws);
      break;
    case 'ban': {
      room.banned.set(key, targetName);
      log(`${tag} host "${hostName}" banned "${targetName}" (#${targetId})`);
      for (const [id, member] of [...room.members]) {
        if (id !== ws.id && member.name.toLowerCase() === key) {
          send(member.ws, { t: 'kicked', reason: 'You were banned by the host.' });
          leaveRoom(member.ws);
        }
      }
      send(ws, { t: 'bans', names: banList(room) });
      break;
    }
    case 'mute':
    case 'unmute': {
      const muted = action === 'mute';
      if (muted) room.muted.add(key);
      else room.muted.delete(key);
      log(`${tag} host "${hostName}" ${muted ? 'muted' : 'unmuted'} "${targetName}" (#${targetId})`);
      for (const [id, member] of room.members) {
        if (member.name.toLowerCase() === key) broadcast(room, { t: 'muted', id, muted });
      }
      notice(target.ws, muted ? 'The host muted you.' : 'The host unmuted you.');
      break;
    }
    case 'promote':
      room.hostId = targetId;
      broadcast(room, { t: 'host_changed', id: targetId });
      log(`${tag} host "${hostName}" made "${targetName}" (#${targetId}) the host`);
      break;
  }
}

function handle(ws, msg) {
  switch (msg.t) {
    case 'host': {
      if (ws.room) return send(ws, { t: 'error', msg: 'Already in a room.' });
      const code = makeCode();
      const room = { members: new Map(), hostId: 1, nextId: 1, createdAt: Date.now(), phase: 'lobby', raceIndex: 0,
        banned: new Map(), muted: new Set() };
      rooms.set(code, room);
      const name = cleanName(msg.name);
      log(`${roomTag(code)} created by "${name}" (${rooms.size} room(s) open)`);
      joinRoom(ws, room, code, name);
      break;
    }
    case 'join': {
      if (ws.room) return send(ws, { t: 'error', msg: 'Already in a room.' });
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        log(`join refused: no room "${code}" (${ws.address})`);
        return send(ws, { t: 'error', msg: 'Room not found.' });
      }
      if (room.members.size >= MAX_PLAYERS) {
        log(`${roomTag(code)} join refused: room is full (${ws.address})`);
        return send(ws, { t: 'error', msg: 'Room is full.' });
      }
      const joiningName = cleanName(msg.name);
      if (room.banned.has(joiningName.toLowerCase())) {
        log(`${roomTag(code)} join refused: "${joiningName}" is banned (${ws.address})`);
        return send(ws, { t: 'error', msg: 'You are banned from this room.' });
      }
      joinRoom(ws, room, code, joiningName);
      break;
    }
    case 'admin':
      handleAdmin(ws, msg);
      break;
    case 'chat': {
      const room = ws.room && rooms.get(ws.room);
      const text = cleanChat(msg.text);
      if (!room || text === '') return;
      if (ws.chatBudget-- <= 0) return;
      const name = nameOf(room, ws.id);
      if (room.muted.has(name.toLowerCase())) {
        notice(ws, 'You are muted by the host.');
        log(`${roomTag(ws.room)} muted "${name}" tried to chat: ${text}`);
        return;
      }
      log(`${roomTag(ws.room)} chat <${name}> ${text}`);
      broadcast(room, { t: 'chat', from: ws.id, name, text });
      break;
    }
    case 'msg': {
      const room = ws.room && rooms.get(ws.room);
      if (!room || typeof msg.data !== 'object' || msg.data === null) return;
      if (ws.id === room.hostId && msg.data.k === 'state' && msg.data.s && typeof msg.data.s === 'object') {
        trackState(room, ws.room, msg.data.s);
      }
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

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.room = null;
  ws.id = 0;
  ws.budget = MESSAGES_PER_SECOND;
  ws.chatBudget = CHAT_PER_SECOND;
  ws.address = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  log(`connection opened from ${ws.address} (${wss.clients.size} connected)`);
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
  ws.on('close', () => {
    leaveRoom(ws);
    log(`connection closed from ${ws.address} (${wss.clients.size} connected)`);
  });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    ws.budget = MESSAGES_PER_SECOND;
    if (!ws.isAlive) {
      log(`connection from ${ws.address} timed out${ws.room ? ` (room ${ws.room})` : ''}`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 1000 * 15);

setInterval(() => {
  for (const ws of wss.clients) ws.chatBudget = CHAT_PER_SECOND;
}, 1000);

server.listen(PORT, () => log(`Relay listening on ${PORT}`));
