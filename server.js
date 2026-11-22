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
  r.players[s.id] = { name: String(name || '').trim().slice(0, 12) || `Player ${color + 1}`, x: 0, z: 0, ry: 0, a: 'idle', color };
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
      return { id, type, x: Math.cos(a) * R, z: Math.sin(a) * R, taken: false }; });
    r.phase = 'play'; r.t0 = Date.now();
    Object.values(r.players).forEach((p, i) => { p.x = -2 + i * 1.5; p.z = 0; });
    io.to(r.code).emit('start', { items: r.items, truck: TRUCK, stormMs: STORM_MS });
  });
  s.on('move', m => { const p = s.room?.players[s.id]; if (!p || s.room.phase !== 'play') return;
    p.x = Math.max(-90, Math.min(90, +m.x || 0)); p.z = Math.max(-90, Math.min(90, +m.z || 0)); p.ry = +m.ry || 0; p.a = m.a === 'run' || m.a === 'walk' ? m.a : 'idle'; });
  s.on('pickup', id => { const r = s.room, p = r?.players[s.id], it = r?.items[id];
    if (!p || r.phase !== 'play' || !it || it.taken || d(p, it) > REACH) return;
    it.taken = true; io.to(r.code).emit('msg', `${p.name} found the ${it.type}!`); });
  s.on('repair', () => { const r = s.room, p = r?.players[s.id];
    if (!p || r.phase !== 'play' || r.step >= STEPS.length || d(p, TRUCK) > TRUCK_REACH) return;
    const need = STEPS[r.step]; if (!r.items.find(i => i.type === need).taken) return s.emit('msg', `Still missing: ${need}`);
    r.step++; io.to(r.code).emit('msg', `${p.name} fixed the ${need} (${r.step}/${STEPS.length})`); });
  s.on('board', () => { const r = s.room, p = r?.players[s.id];
    if (!p || r.phase !== 'play' || r.step < STEPS.length || d(p, TRUCK) > TRUCK_REACH) return;
    r.boarded[s.id] = true; checkWin(r); });
  s.on('disconnect', () => { const r = s.room; if (!r) return; delete r.players[s.id]; delete r.boarded[s.id];
    const ids = Object.keys(r.players); if (!ids.length) return void delete rooms[r.code];
    if (r.host === s.id) { r.host = ids[0]; io.to(r.code).emit('msg', `${r.players[ids[0]].name} is now host`); }
    lobby(r); checkWin(r); });
});
function checkWin(r) { const ids = Object.keys(r.players);
  if (r.phase === 'play' && ids.length && ids.every(i => r.boarded[i])) { r.phase = 'won'; io.to(r.code).emit('end', 'won'); } }
setInterval(() => { for (const r of Object.values(rooms)) { if (r.phase !== 'play') continue;
  const storm = Math.min(1, (Date.now() - r.t0) / STORM_MS);
  if (storm >= 1) { r.phase = 'lost'; io.to(r.code).emit('end', 'lost'); continue; }
  io.to(r.code).emit('state', { storm, step: r.step, taken: r.items.filter(i => i.taken).map(i => i.id), boarded: Object.keys(r.boarded).length,
    p: Object.fromEntries(Object.entries(r.players).map(([id, p]) => [id, [p.x, p.z, p.ry, p.a]])) }); } }, 100);
srv.listen(process.env.PORT || 3000, () => console.log('LAST SHELTER on http://localhost:' + (process.env.PORT || 3000)));
