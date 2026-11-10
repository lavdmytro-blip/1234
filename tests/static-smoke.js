'use strict';
// Offline simulation for environments where npm packages cannot be downloaded.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
const gameJs = fs.readFileSync(path.join(__dirname, '..', 'public/game.js'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const referencedIds = [...gameJs.matchAll(/\$\('([^']+)'\)/g)].map(m=>m[1]);
for (const id of referencedIds) assert(ids.includes(id), `Missing DOM element: ${id}`);
const fakeExpress = () => ({ disable() {}, use() {}, get() {} });
fakeExpress.static = () => () => {};
let io;
class FakeIo {
  constructor() { this.sockets = []; io = this; }
  on(name, fn) { if (name === 'connection') this.connectFn = fn; }
  to(name) {
    return { emit: (event, value) => {
      for (const s of this.sockets) if (s.id === name || s.room === name) s.received.push({ event, value });
    }};
  }
  connect(id) {
    const socket = { id, room: null, data: {}, handlers: {}, received: [],
      on(event,fn) { this.handlers[event] = fn; },
      join(code) { this.room = code; },
      leave(code) { if(this.room === code) this.room=null; },
      send(event, ...args) { return this.handlers[event](...args); },
      last(event) { return this.received.filter(x=>x.event===event).at(-1)?.value; }
    };
    this.sockets.push(socket); this.connectFn(socket); return socket;
  }
}
let ms=0;const loops=[];
const httpServer={listen(port,host,cb){cb()},close(cb){cb?.()}};
const vmModule={exports:{}};
vm.runInNewContext(source,{
  require(mod){
    if(mod==='express')return fakeExpress;
    if(mod==='http')return {createServer:()=>httpServer};
    if(mod==='socket.io')return {Server:FakeIo};
    if(mod==='path')return path;
    throw new Error(`Unexpected import: ${mod}`);
  },
  __dirname:path.join(__dirname,'..'),
  process:{env:{PORT:'3000'}},
  performance:{now:()=>ms},
  setInterval(fn){loops.push(fn);return {unref(){}}},
  console,Date,Math,Int32Array,Map,Set,Number,String,Array,Object,
  module:vmModule,
}, {filename:'server.js'});
const {MAP, STARTS, PART_COORDS, EXIT, findPath, canOccupy}=vmModule.exports;
assert.equal(MAP.length,21);
for(const p of [...PART_COORDS,EXIT]){
  assert(canOccupy(p.x,p.y));
  assert(findPath(STARTS[0],p).length>0,'Objective must be reachable');
}
const a=io.connect('host'), b=io.connect('friend'), c=io.connect('extra');
let created, joined, started;
a.send('room:create',{name:'Кирилл'},r=>created=r);
assert(created.ok && created.code.length===5);
assert.equal(a.last('room:sync').phase,'lobby');
b.send('room:join',{code:created.code,name:'Олег'},r=>joined=r);
assert(joined.ok);
assert.equal(b.last('room:sync').players.length,2);
let rejected;
c.send('room:join',{code:created.code,name:'Лишний'},r=>rejected=r);
assert.equal(rejected.ok,false);
let denied;
b.send('room:start',null,r=>denied=r);
assert.equal(denied.ok,false);
a.send('room:start',null,r=>started=r);
assert.equal(started.ok,true);
assert.equal(a.last('room:sync').phase,'playing');
a.send('input',{dx:1,dy:0,sprint:true,use:false});
for(let i=0;i<30;i++){ms+=33;loops[0]();}
const state=a.last('game:state');
assert(state.players.find(p=>p.id==='host').x>STARTS[0].x+20);
assert.equal(state.parts.length,4);
b.send('disconnect');
assert.equal(a.last('room:sync').phase,'lobby');
assert.equal(a.last('room:sync').players.length,1);
console.log('PASS: all frontend element refs, map access, room creation, 2-player join, host permissions, input movement, disconnect');
