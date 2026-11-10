'use strict';

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { transports: ['websocket', 'polling'], maxHttpBufferSize: 12000 });
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true, game: 'kirpich-duo' }));

const TILE = 40;
const COLS = 31;
const ROWS = 21;
const GAME_SECONDS = 220;
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomStore = new Map();

// Static walkable maze, identical for every player. Walls are server-authoritative.
function buildMap() {
  const grid = Array.from({ length: ROWS }, (_, y) =>
    Array.from({ length: COLS }, (_, x) =>
      x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1 ? 1 : 0
    )
  );

  const walls = [
    { x: 7, holes: [3, 4, 10, 11, 17, 18] },
    { x: 13, holes: [5, 6, 12, 13, 18] },
    { x: 19, holes: [2, 3, 9, 10, 16, 17] },
    { x: 25, holes: [5, 6, 12, 13, 18] }
  ];
  for (const wall of walls) {
    for (let y = 2; y <= ROWS - 3; y++) {
      if (!wall.holes.includes(y)) grid[y][wall.x] = 1;
    }
  }
  const horizontalSegments = [
    { y: 7, a: 2, b: 5, holes: [4] },
    { y: 7, a: 9, b: 11, holes: [10] },
    { y: 7, a: 15, b: 17, holes: [16] },
    { y: 7, a: 21, b: 23, holes: [22] },
    { y: 14, a: 2, b: 5, holes: [3] },
    { y: 14, a: 9, b: 11, holes: [10] },
    { y: 14, a: 15, b: 17, holes: [16] },
    { y: 14, a: 21, b: 23, holes: [22] }
  ];
  for (const s of horizontalSegments) {
    for (let x = s.a; x <= s.b; x++) {
      if (!s.holes.includes(x)) grid[s.y][x] = 1;
    }
  }
  return grid;
}
const MAP = buildMap();
const STARTS = [{ x: 2.5 * TILE, y: 2.5 * TILE }, { x: 3.5 * TILE, y: 2.5 * TILE }];
const ENEMY_START = { x: 16.5 * TILE, y: 9.5 * TILE };
const PART_COORDS = [
  { x: 4.5 * TILE, y: 17.5 * TILE },
  { x: 10.5 * TILE, y: 4.5 * TILE },
  { x: 17.5 * TILE, y: 16.5 * TILE },
  { x: 28.5 * TILE, y: 3.5 * TILE }
];
const EXIT = { x: 28.5 * TILE, y: 18.5 * TILE };

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function walkable(tx, ty) { return ty >= 0 && ty < ROWS && tx >= 0 && tx < COLS && MAP[ty][tx] !== 1; }
function canOccupy(x, y, radius = 12) {
  const minX = Math.max(0, Math.floor((x - radius) / TILE));
  const maxX = Math.min(COLS - 1, Math.floor((x + radius) / TILE));
  const minY = Math.max(0, Math.floor((y - radius) / TILE));
  const maxY = Math.min(ROWS - 1, Math.floor((y + radius) / TILE));
  for (let yy = minY; yy <= maxY; yy++) {
    for (let xx = minX; xx <= maxX; xx++) {
      if (walkable(xx, yy)) continue;
      const left = xx * TILE, top = yy * TILE;
      const closestX = Math.max(left, Math.min(x, left + TILE));
      const closestY = Math.max(top, Math.min(y, top + TILE));
      if ((x - closestX) ** 2 + (y - closestY) ** 2 < radius ** 2) return false;
    }
  }
  return true;
}
function moveEntity(entity, dx, dy, speed, dt, radius = 12) {
  const stepX = dx * speed * dt, stepY = dy * speed * dt;
  if (canOccupy(entity.x + stepX, entity.y, radius)) entity.x += stepX;
  if (canOccupy(entity.x, entity.y + stepY, radius)) entity.y += stepY;
}

// Grid shortest path: Кирпич can follow players around walls rather than through them.
function findPath(from, to) {
  const sx = Math.floor(from.x / TILE), sy = Math.floor(from.y / TILE);
  const tx = Math.floor(to.x / TILE), ty = Math.floor(to.y / TILE);
  if (!walkable(sx, sy) || !walkable(tx, ty)) return [];
  const key = (x, y) => y * COLS + x;
  const startKey = key(sx, sy), goalKey = key(tx, ty);
  const queue = [startKey];
  const previous = new Int32Array(ROWS * COLS).fill(-1);
  previous[startKey] = startKey;
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    if (k === goalKey) break;
    const cx = k % COLS, cy = Math.floor(k / COLS);
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
      if (!walkable(nx, ny)) continue;
      const next = key(nx, ny);
      if (previous[next] !== -1) continue;
      previous[next] = k;
      queue.push(next);
    }
  }
  if (previous[goalKey] === -1) return [];
  const reverse = [];
  let current = goalKey;
  while (current !== startKey) {
    reverse.push({ x: ((current % COLS) + .5) * TILE, y: (Math.floor(current / COLS) + .5) * TILE });
    current = previous[current];
  }
  return reverse.reverse();
}

function cleanName(value) {
  const text = typeof value === 'string' ? value.trim().replace(/[\x00-\x1F\x7F<>]/g, '') : '';
  return (text.slice(0, 16) || 'Игрок');
}
function cleanRoomCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5); }
function newCode() {
  for (let i = 0; i < 30; i++) {
    let code = '';
    for (let j = 0; j < 5; j++) code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    if (!roomStore.has(code)) return code;
  }
  throw new Error('Cannot allocate a room code');
}
function newPlayer(socket, name, slot) {
  return { id: socket.id, name: cleanName(name), slot, x: STARTS[slot].x, y: STARTS[slot].y,
    lookX: 1, lookY: 0, downed: false, downTime: 0, revive: 0, invuln: 0,
    stamina: 100, parts: 0, input: { dx: 0, dy: 0, sprint: false, use: false } };
}
function initialEnemy() { return { x: ENEMY_START.x, y: ENEMY_START.y, lookX: 0, lookY: 1, path: [], refresh: 0 }; }
function resetRoom(room) {
  room.phase = 'lobby';
  room.seconds = GAME_SECONDS;
  room.parts = PART_COORDS.map((p, i) => ({ ...p, id: i, taken: false }));
  room.enemy = initialEnemy();
  room.result = null;
  room.players.forEach((p) => Object.assign(p, {
    x: STARTS[p.slot].x, y: STARTS[p.slot].y, downed: false, downTime: 0, revive: 0,
    invuln: 0, stamina: 100, parts: 0, input: { dx: 0, dy: 0, sprint: false, use: false }
  }));
}
function startRoom(room) {
  resetRoom(room);
  room.phase = 'playing';
  room.touched = Date.now();
  io.to(room.code).emit('room:notice', 'Кирпич услышал шум. БЕГИТЕ!');
  broadcastSync(room);
}
function endRoom(room, won, message) {
  if (room.phase !== 'playing') return;
  room.phase = won ? 'won' : 'lost';
  room.result = message;
  room.touched = Date.now();
  io.to(room.code).emit('room:notice', message);
  broadcastSync(room);
}
function serialize(room) {
  return {
    code: room.code, phase: room.phase, hostId: room.hostId,
    players: room.players.map(p => ({ id: p.id, slot: p.slot, name: p.name, x: p.x, y: p.y,
      lookX: p.lookX, lookY: p.lookY, downed: p.downed, downTime: p.downTime,
      revive: p.revive, invuln: p.invuln, stamina: p.stamina, parts: p.parts })),
    enemy: { x: room.enemy.x, y: room.enemy.y, lookX: room.enemy.lookX, lookY: room.enemy.lookY },
    parts: room.parts, exit: EXIT, seconds: room.seconds, result: room.result
  };
}
function broadcastSync(room) {
  const base = { ...serialize(room), map: MAP, tile: TILE, rows: ROWS, cols: COLS };
  for (const player of room.players) {
    io.to(player.id).emit('room:sync', { ...base, yourId: player.id });
  }
}
function leaveRoom(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = roomStore.get(code);
  socket.leave(code);
  socket.data.room = null;
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
  room.touched = Date.now();
  if (!room.players.length) { roomStore.delete(code); return; }
  room.hostId = room.players[0].id;
  resetRoom(room);
  io.to(code).emit('room:notice', 'Напарник отключился. Ждём второго игрока.');
  broadcastSync(room);
}

io.on('connection', (socket) => {
  socket.on('room:create', (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    leaveRoom(socket);
    if (roomStore.size >= 300) return reply({ ok: false, error: 'Сейчас слишком много комнат. Попробуй позже.' });
    const code = newCode();
    const room = { code, phase: 'lobby', hostId: socket.id, players: [newPlayer(socket, data?.name, 0)],
      seconds: GAME_SECONDS, parts: [], enemy: initialEnemy(), result: null, touched: Date.now() };
    resetRoom(room);
    roomStore.set(code, room);
    socket.join(code);
    socket.data.room = code;
    reply({ ok: true, code });
    broadcastSync(room);
  });

  socket.on('room:join', (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const code = cleanRoomCode(data?.code);
    const room = roomStore.get(code);
    if (!room) return reply({ ok: false, error: 'Комната не найдена. Проверь код.' });
    if (room.players.length >= 2) return reply({ ok: false, error: 'Комната уже заполнена.' });
    if (room.phase !== 'lobby') return reply({ ok: false, error: 'Игра уже идёт.' });
    leaveRoom(socket);
    const taken = new Set(room.players.map(p => p.slot));
    const slot = taken.has(0) ? 1 : 0;
    room.players.push(newPlayer(socket, data?.name, slot));
    room.touched = Date.now();
    socket.join(code);
    socket.data.room = code;
    reply({ ok: true, code });
    io.to(code).emit('room:notice', 'Напарник подключился. Можно начинать!');
    broadcastSync(room);
  });

  socket.on('room:start', (_data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const room = roomStore.get(socket.data.room);
    if (!room) return reply({ ok: false, error: 'Комната недоступна.' });
    if (room.hostId !== socket.id) return reply({ ok: false, error: 'Начинает только создатель.' });
    if (room.players.length !== 2) return reply({ ok: false, error: 'Нужно два игрока.' });
    if (room.phase !== 'lobby') return reply({ ok: false, error: 'Уже началось.' });
    startRoom(room);
    reply({ ok: true });
  });

  socket.on('room:restart', (_data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const room = roomStore.get(socket.data.room);
    if (!room || room.hostId !== socket.id) return reply({ ok: false, error: 'Перезапуск доступен создателю.' });
    if (room.players.length !== 2) return reply({ ok: false, error: 'Нужны два игрока.' });
    if (!['won', 'lost'].includes(room.phase)) return reply({ ok: false, error: 'Игра ещё идёт.' });
    startRoom(room);
    reply({ ok: true });
  });

  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('input', (data) => {
    const room = roomStore.get(socket.data.room);
    if (!room || room.phase !== 'playing') return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p) return;
    let dx = Number(data?.dx) || 0, dy = Number(data?.dy) || 0;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) { dx = 0; dy = 0; }
    const length = Math.hypot(dx, dy);
    if (length > 1) { dx /= length; dy /= length; }
    p.input = { dx, dy, sprint: data?.sprint === true, use: data?.use === true };
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

let lastUpdate = performance.now();
let sendAccumulator = 0;
const loop = setInterval(() => {
  const now = performance.now();
  const dt = Math.min(.065, (now - lastUpdate) / 1000);
  lastUpdate = now;
  sendAccumulator += dt;
  const shouldSend = sendAccumulator >= 1 / 15;
  if (shouldSend) sendAccumulator = 0;

  for (const room of roomStore.values()) {
    if (room.phase !== 'playing') continue;
    room.seconds = Math.max(0, room.seconds - dt);
    if (room.seconds <= 0) { endRoom(room, false, 'Время вышло. Кирпич закрыл ворота!'); continue; }

    const allTaken = room.parts.every(p => p.taken);
    for (const p of room.players) {
      p.invuln = Math.max(0, p.invuln - dt);
      if (p.downed) {
        p.downTime -= dt;
        if (p.downTime <= 0) { endRoom(room, false, `${p.name} не дождался помощи.`); break; }
        continue;
      }
      const len = Math.hypot(p.input.dx, p.input.dy);
      const isSprinting = p.input.sprint && len > 0 && p.stamina > 1;
      p.stamina = Math.max(0, Math.min(100, p.stamina + (isSprinting ? -29 : 20) * dt));
      if (len > .01) {
        p.lookX = p.input.dx / len;
        p.lookY = p.input.dy / len;
        moveEntity(p, p.input.dx, p.input.dy, isSprinting ? 218 : 151, dt, 12);
      }
      for (const part of room.parts) {
        if (!part.taken && distance(p, part) < 25) {
          part.taken = true;
          p.parts++;
          io.to(room.code).emit('room:notice', `${p.name} нашёл деталь! ${room.parts.filter(part => part.taken).length}/4`);
          break;
        }
      }
    }
    if (room.phase !== 'playing') continue;

    for (const p of room.players) {
      if (!p.downed) continue;
      const rescuer = room.players.find(other => other.id !== p.id && !other.downed && other.input.use && distance(other, p) <= 62);
      p.revive = rescuer ? Math.min(1.5, p.revive + dt) : Math.max(0, p.revive - dt * 1.7);
      if (p.revive >= 1.5) {
        p.downed = false;
        p.downTime = 0;
        p.revive = 0;
        p.invuln = 3.5;
        io.to(room.code).emit('room:notice', `${rescuer.name} спас напарника!`);
      }
    }

    if (room.players.every(p => p.downed)) { endRoom(room, false, 'Кирпич поймал вас обоих!'); continue; }
    const living = room.players.filter(p => !p.downed && p.invuln <= 0);
    const target = (living.length ? living : room.players.filter(p => !p.downed)).sort((a,b) => distance(room.enemy,a) - distance(room.enemy,b))[0];
    if (target) {
      room.enemy.refresh -= dt;
      if (room.enemy.refresh <= 0 || !room.enemy.path.length) {
        room.enemy.path = findPath(room.enemy, target);
        room.enemy.refresh = .35;
      }
      while (room.enemy.path.length && distance(room.enemy, room.enemy.path[0]) <= 7) room.enemy.path.shift();
      const next = room.enemy.path[0] || target;
      const d = distance(room.enemy, next);
      if (d > 1) {
        const dx = (next.x - room.enemy.x) / d, dy = (next.y - room.enemy.y) / d;
        room.enemy.lookX = dx;
        room.enemy.lookY = dy;
        moveEntity(room.enemy, dx, dy, 84 + room.parts.filter(p => p.taken).length * 7.5, dt, 12);
      }
    }
    for (const p of room.players) {
      if (p.downed || p.invuln > 0) continue;
      if (distance(p, room.enemy) < 29) {
        p.downed = true;
        p.downTime = 19;
        p.revive = 0;
        p.input = { dx: 0, dy: 0, sprint: false, use: false };
        io.to(room.code).emit('room:notice', `${p.name} пойман! Напарник, зажми E рядом с ним!`);
      }
    }
    if (room.players.every(p => p.downed)) { endRoom(room, false, 'Кирпич поймал вас обоих!'); continue; }
    if (allTaken && room.players.every(p => !p.downed && distance(p, EXIT) < 68)) {
      endRoom(room, true, 'Вы сбежали! Кирпич остался сторожить пустой двор.');
    }
    if (shouldSend) io.to(room.code).emit('game:state', serialize(room));
  }
}, 1000 / 30);
loop.unref();

setInterval(() => {
  const expire = Date.now() - 1000 * 60 * 45;
  for (const [code, room] of roomStore) {
    if (room.touched < expire) roomStore.delete(code);
  }
}, 1000 * 60 * 5).unref();

httpServer.listen(PORT, '0.0.0.0', () => console.log(`Kirpich Duo listening on ${PORT}`));

module.exports = { MAP, findPath, STARTS, PART_COORDS, EXIT, canOccupy, httpServer };
