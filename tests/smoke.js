'use strict';
const assert = require('node:assert/strict');
const { io: client } = require('socket.io-client');
const { once } = require('node:events');

const { MAP, findPath, STARTS, PART_COORDS, EXIT, canOccupy, httpServer } = require('../server');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function call(socket, event, data) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, data, (err, response) => err ? reject(err) : resolve(response));
  });
}
(async () => {
  try {
    if (!httpServer.listening) await once(httpServer, 'listening');
    const port = httpServer.address().port;
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const html = await (await fetch(base)).text();
    assert.ok(html.includes('КИРПИЧ'));
    const frontend = await (await fetch(base + '/game.js')).text();
    assert.ok(frontend.includes('room:join'));
    // Check every quest location and exit is accessible by a grid path.
    for (const p of [...PART_COORDS, EXIT]) {
      assert.ok(canOccupy(p.x, p.y), `Location obstructed: ${p.x},${p.y}`);
      assert.ok(findPath(STARTS[0], p).length > 0, `Location unreachable: ${p.x},${p.y}`);
    }
    assert.equal(MAP.length, 21);
    const a = client(base, { transports: ['websocket'], autoConnect: false });
    const b = client(base, { transports: ['websocket'], autoConnect: false });
    const c = client(base, { transports: ['websocket'], autoConnect: false });
    const connections = [a,b,c].map(sock => new Promise(resolve => sock.once('connect', resolve)));
    a.connect(); b.connect(); c.connect();
    await Promise.all(connections);
    let hostSync = null, guestSync = null, latestState = null;
    a.on('room:sync', state => hostSync = state);
    b.on('room:sync', state => guestSync = state);
    a.on('game:state', state => latestState = state);
    const created = await call(a, 'room:create', { name: 'Василий' });
    assert.equal(created.ok, true);
    assert.equal(created.code.length, 5);
    await sleep(100);
    assert.equal(hostSync?.phase, 'lobby');
    assert.equal(hostSync?.players.length, 1);
    const joined = await call(b, 'room:join', { code: created.code, name: 'Петрович' });
    assert.equal(joined.ok, true);
    await sleep(100);
    assert.equal(guestSync?.players.length, 2);
    assert.equal(hostSync?.players.length, 2);
    const overfill = await call(c, 'room:join', { code: created.code, name: 'Лишний' });
    assert.equal(overfill.ok, false);
    const guestStart = await call(b, 'room:start', null);
    assert.equal(guestStart.ok, false);
    const started = await call(a, 'room:start', null);
    assert.equal(started.ok, true);
    await sleep(150);
    assert.equal(hostSync?.phase, 'playing');
    assert.equal(guestSync?.phase, 'playing');
    assert.equal(latestState?.players.length, 2);
    assert.equal(latestState?.parts.length, 4);
    const startX = latestState.players.find(p => p.id === a.id).x;
    a.emit('input', { dx: 1, dy: 0, sprint: true, use: false });
    await sleep(350);
    a.emit('input', { dx: 0, dy: 0, sprint: false, use: false });
    assert.ok(latestState.players.find(p => p.id === a.id).x > startX, 'Player did not move');
    b.disconnect();
    await sleep(130);
    assert.equal(hostSync?.phase, 'lobby', 'Host did not return to lobby');
    assert.equal(hostSync?.players.length, 1);
    a.disconnect(); c.disconnect();
    console.log('PASS: health, assets, reachable objectives, rooms, 2-player sync, movement, disconnection');
    await new Promise(resolve => httpServer.close(resolve));
  } catch (err) {
    console.error('FAIL:', err);
    process.exitCode = 1;
    httpServer.close();
  }
})();
