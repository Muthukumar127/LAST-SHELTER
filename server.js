// LAST SHELTER – authoritative multiplayer server (Express + Socket.IO)
const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(); app.use(express.static('public'));
const srv = http.createServer(app), io = new Server(srv);
const rooms = {};
const STEPS = ['tools', 'engine', 'battery', 'tyre', 'fuel', 'brake', 'handbrake', 'seats', 'windshield', 'door1', 'door2', 'door3', 'door4', 'key']; // repair order
const TRUCK = { x: 30, z: -25 }, STORM_MS = 240000, REACH = 4.5, TRUCK_REACH = 8;
const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const code = () => { let c; do c = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.random() * 32 | 0]).join(''); while (rooms[c]); return c; };
const lobby = r => io.to(r.code).emit('lobby', { code: r.code, host: r.host, phase: r.phase,
  players: Object.entries(r.players).map(([id, p]) => ({ id, name: p.name, color: p.color })) });
function join(s, r, name) {
  const used = Object.values(r.players).map(p => p.color);
  const color = [0, 1, 2, 3].find(c => !used.includes(c));
  r.players[s.id] = { name: String(name || '').trim().slice(0, 12) || `Player ${color + 1}`, x: 0, z: 0, ry: 0, a: 'idle', color, held: null };
  s.join(r.code); s.room = r; lobby(r);
}
io.on('connection', s => {
  s.on('create', name => { const c = code(); rooms[c] = { code: c, host: s.id, phase: 'lobby', players: {}, items: [], step: 0, boarded: {} }; join(s, rooms[c], name); });
  s.on('join', (c, name) => {
    const r = rooms[String(c || '').toUpperCase()];
    if (!r) return s.emit('err', 'Room not found');
    if (r.phase !== 'lobby') return s.emit('err', 'Game already started');
    if (Object.keys(r.players).length >= 4) return s.emit('err', 'Room is full (4 max)');
    join(s, r, name);
  });
  s.on('start', () => {
    const r = s.room; if (!r || r.host !== s.id || r.phase !== 'lobby') return;
    r.items = STEPS.map((type, id) => { const a = id / STEPS.length * Math.PI * 2 + 0.4, R = 22 + Math.random() * 40;
      return { id, type, x: Math.cos(a) * R, z: Math.sin(a) * R, state: 0, holder: null }; });
    r.phase = 'play'; r.t0 = Date.now(); r.fixed = [];
    Object.values(r.players).forEach((p, i) => { p.x = -2 + i * 1.5; p.z = -1.5; });
    io.to(r.code).emit('start', { items: r.items, truck: TRUCK, stormMs: STORM_MS });
  });
  s.on('move', m => { const p = s.room?.players[s.id]; if (!p || s.room.phase !== 'play') return;
    p.x = Math.max(-90, Math.min(90, +m.x || 0)); p.z = Math.max(-90, Math.min(90, +m.z || 0)); p.ry = +m.ry || 0; p.a = m.a === 'run' || m.a === 'walk' ? m.a : 'idle'; });
  s.on('pickup', id => { const r = s.room, p = r?.players[s.id], it = r?.items[id];
    if (!p || r.phase !== 'play' || !it || it.state !== 0 || p.held != null || d(p, it) > REACH) return;
    it.state = 1; it.holder = s.id; p.held = id; });
  s.on('drop', () => drop(s.room, s.id));
  s.on('fit', () => { const r = s.room, p = r?.players[s.id]; if (!p || r.phase !== 'play' || p.held == null) return; const it = r.items[p.held];
    if (d(p, slotPos(it.type)) > 2.8) return s.emit('msg', `The ${it.type} doesn't go here – follow the glowing spot`);
    if (it.type === 'key' && r.fixed.length < STEPS.length - 1) return s.emit('msg', 'Fit everything else before the key!');
    it.state = 2; it.holder = null; p.held = null; r.fixed.push(it.type);
    io.to(r.code).emit('msg', `${p.name} fitted the ${it.type} (${r.fixed.length}/${STEPS.length})`); });
  s.on('board', () => { const r = s.room, p = r?.players[s.id];
    if (!p || r.phase !== 'play' || r.fixed.length < STEPS.length || d(p, TRUCK) > TRUCK_REACH) return;
    r.boarded[s.id] = true; checkWin(r); });
  s.on('disconnect', () => { const r = s.room; if (!r) return; drop(r, s.id); delete r.players[s.id]; delete r.boarded[s.id];
    const ids = Object.keys(r.players); if (!ids.length) return void delete rooms[r.code];
    if (r.host === s.id) { r.host = ids[0]; io.to(r.code).emit('msg', `${r.players[ids[0]].name} is now host`); }
    lobby(r); checkWin(r); });
});
const SLOT = { engine: [1.5, 0], battery: [2.05, .7], tyre: [-1.7, 1.3], fuel: [-1.05, .75], brake: [1.7, 1.02], handbrake: [-.1, 0], seats: [-.8, 0], windshield: [.75, 0], door1: [.1, 1.1], door2: [.1, -1.1], door3: [-1.3, 1.1], door4: [-1.3, -1.1], tools: [0, 3.2], key: [.35, .15] };
const slotPos = t => { const [lx, lz] = SLOT[t], c = Math.cos(.5), n = Math.sin(.5); return { x: TRUCK.x + lx * c + lz * n, z: TRUCK.z - lx * n + lz * c }; };
function drop(r, id) { const p = r?.players[id]; if (!p || p.held == null) return; const it = r.items[p.held]; it.state = 0; it.holder = null; it.x = p.x; it.z = p.z; p.held = null; }
function checkWin(r) { const ids = Object.keys(r.players);
  if (r.phase === 'play' && ids.length && ids.every(i => r.boarded[i])) { r.phase = 'won'; io.to(r.code).emit('end', 'won'); } }
setInterval(() => { for (const r of Object.values(rooms)) { if (r.phase !== 'play') continue;
  const storm = Math.min(1, (Date.now() - r.t0) / STORM_MS);
  if (storm >= 1) { r.phase = 'lost'; io.to(r.code).emit('end', 'lost'); continue; }
  io.to(r.code).emit('state', { storm, step: r.fixed.length, fixed: r.fixed, it: r.items.map(i => [i.state, +i.x.toFixed(1), +i.z.toFixed(1), i.holder]), boarded: Object.keys(r.boarded).length,
    p: Object.fromEntries(Object.entries(r.players).map(([id, p]) => [id, [p.x, p.z, p.ry, p.a]])) }); } }, 100);
srv.listen(process.env.PORT || 3000, () => console.log('LAST SHELTER on http://localhost:' + (process.env.PORT || 3000)));
