// LAST SHELTER – authoritative multiplayer server (Express + Socket.IO)
const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(); app.use(express.static('public'));
const srv = http.createServer(app), io = new Server(srv);
const rooms = {}, names = new Map(); // names: lowercase username -> socket id (usernames are unique while connected)
const STEPS = ['tools', 'engine', 'battery', 'tyre', 'fuel', 'brake', 'handbrake', 'seats', 'windshield', 'door1', 'door2', 'door3', 'door4', 'key']; // repair order
const WRECK_PARTS = ['engine', 'battery', 'tyre', 'brake', 'seats', 'door3', 'door4']; // these still work on the dead wreck car – strip them
const TRUCK = { x: 30, z: -25 }, TRUCK_TH = .5, WRECK = { x: -34, z: 26, th: 2.2 }, STORM_MS = 240000, REACH = 4.5, TRUCK_REACH = 8;
// ---- drive phase tuning ----
const GOAL = 5000, MAX_CRASH = 3, VMAX = 30, DRIVE_Z0 = 400; // 5 km, 3 crashes = truck dead, top speed 30 u/s (~108 km/h)
const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z), clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mkRnd = seed => () => (seed = seed * 16807 % 2147483647) / 2147483647;
const roadX = zr => Math.sin(zr / 260) * 25 + Math.sin(zr / 97) * 8; // road centre line (zr = metres driven)
const code = () => { let c; do c = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.random() * 32 | 0]).join(''); while (rooms[c]); return c; };
const lobby = r => io.to(r.code).emit('lobby', { code: r.code, host: r.host, phase: r.phase,
  players: Object.entries(r.players).map(([id, p]) => ({ id, name: p.name, color: p.color })) });

// slot = [local x, local y, local z] on the truck (same layout on the wreck)
const SLOT = { engine: [1.5, 1.7, 0], battery: [2.05, 1.95, .7], tyre: [-1.7, .6, 1.3], fuel: [-1.05, 1.7, .75], brake: [1.7, .6, 1.02], handbrake: [-.1, 1.55, 0], seats: [-.8, 1.5, 0], windshield: [.75, 2.4, 0], door1: [.1, 2, 1.1], door2: [.1, 2, -1.1], door3: [-1.3, 2, 1.1], door4: [-1.3, 2, -1.1], tools: [0, .25, 3.2], key: [.35, 1.95, .15] };
const slotAt = (t, B, th) => { const [lx, , lz] = SLOT[t], c = Math.cos(th), n = Math.sin(th); return { x: B.x + lx * c + lz * n, z: B.z - lx * n + lz * c }; };
const slotPos = t => slotAt(t, TRUCK, TRUCK_TH);

// ---- shared scenery (sent to every client, so nothing can spawn inside a rock/dune) ----
const EXCL = [[TRUCK.x, TRUCK.z, 9], [WRECK.x, WRECK.z, 9], [0, 2, 17]]; // truck, wreck, house + porch
const blocked = (x, z, pad = 0) => EXCL.some(([ex, ez, er]) => Math.hypot(x - ex, z - ez) < er + pad);
function genWorld() { const rnd = mkRnd(12345), W = { dunes: [], rocks: [], cacti: [] };
  for (let i = 0; i < 40; i++) { const a = rnd() * 6.28, r = 85 + rnd() * 60, s = 6 + rnd() * 12; W.dunes.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, s }); }
  for (let i = 0; i < 30; i++) { let x, z, s; do { const a = rnd() * 6.28, r = 15 + rnd() * 90; s = 1 + rnd() * 3; x = Math.cos(a) * r; z = Math.sin(a) * r; } while (blocked(x, z, s + 1));
    W.rocks.push({ x, z, s, rx: rnd(), ry: rnd() }); }
  for (let i = 0; i < 16; i++) { let x, z, h; do { h = 1.5 + rnd() * 1.5; const a = rnd() * 6.28, r = 20 + rnd() * 70; x = Math.cos(a) * r; z = Math.sin(a) * r; } while (blocked(x, z, 2));
    W.cacti.push({ x, z, h }); }
  return W; }
const WORLD = genWorld();
function spawnPos(taken) { let x = 25, z = 25;
  for (let k = 0; k < 500; k++) { const a = Math.random() * 6.28, R = 20 + Math.random() * 38; x = Math.cos(a) * R; z = Math.sin(a) * R;
    if (blocked(x, z, 3) || taken.some(t => d(t, { x, z }) < 8)
      || WORLD.rocks.some(q => Math.hypot(q.x - x, q.z - z) < q.s + 2.4)
      || WORLD.cacti.some(q => Math.hypot(q.x - x, q.z - z) < 2.5)
      || WORLD.dunes.some(q => Math.hypot(q.x - x, q.z - z) < q.s * 1.16 + 2.5)) continue;
    return { x, z }; }
  return { x, z }; }

function join(s, r, name) {
  const used = Object.values(r.players).map(p => p.color);
  const color = [0, 1, 2, 3].find(c => !used.includes(c));
  r.players[s.id] = { name: name || `Player ${color + 1}`, x: 0, z: 0, ry: 0, a: 'idle', color, held: null };
  s.join(r.code); s.room = r; lobby(r);
}
io.on('connection', s => {
  s.emit('world', WORLD);
  s.on('setname', (n, ack) => { ack = typeof ack === 'function' ? ack : () => {};
    if (s.room) return ack({ ok: false, err: 'Leave the room first' });
    const name = String(n || '').trim().replace(/\s+/g, ' '), len = [...name].length;
    if (len < 3 || len > 12 || !/^[\p{L}\p{M}\p{N}_ ]+$/u.test(name)) return ack({ ok: false, err: 'Username: 3–12 letters, numbers or _' });
    const k = name.toLowerCase(), owner = names.get(k);
    if (owner && owner !== s.id) return ack({ ok: false, err: 'That username is taken – pick another' });
    if (s.uname) names.delete(s.uname.toLowerCase());
    names.set(k, s.id); s.uname = name; ack({ ok: true, name }); });
  s.on('create', () => { if (!s.uname) return s.emit('err', 'Create a username first'); if (s.room) return;
    const c = code(); rooms[c] = { code: c, host: s.id, phase: 'lobby', players: {}, items: [], step: 0, boarded: {} }; join(s, rooms[c], s.uname); });
  s.on('join', c => {
    if (!s.uname) return s.emit('err', 'Create a username first'); if (s.room) return;
    const r = rooms[String(c || '').toUpperCase()];
    if (!r) return s.emit('err', 'Room not found');
    if (r.phase !== 'lobby') return s.emit('err', 'Game already started');
    if (Object.keys(r.players).length >= 4) return s.emit('err', 'Room is full (4 max)');
    join(s, r, s.uname);
  });
  s.on('start', () => {
    const r = s.room; if (!r || r.host !== s.id || r.phase !== 'lobby') return;
    const taken = [];
    r.items = STEPS.map((type, id) => {
      if (WRECK_PARTS.includes(type)) { const p = slotAt(type, WRECK, WRECK.th); return { id, type, x: p.x, z: p.z, y: SLOT[type][1], state: 0, holder: null, mounted: true }; }
      const p = spawnPos(taken); taken.push(p); return { id, type, x: p.x, z: p.z, y: 1.2, state: 0, holder: null, mounted: false }; });
    r.phase = 'play'; r.t0 = Date.now(); r.fixed = [];
    Object.values(r.players).forEach((p, i) => { p.x = -2 + i * 1.5; p.z = -1.5; });
    io.to(r.code).emit('start', { items: r.items.map(({ id, type, x, z, y, mounted }) => ({ id, type, x, z, y, mounted })), truck: TRUCK, wreck: WRECK, stormMs: STORM_MS });
  });
  s.on('move', m => { const p = s.room?.players[s.id]; if (!p || s.room.phase !== 'play') return;
    p.x = Math.max(-90, Math.min(90, +m.x || 0)); p.z = Math.max(-90, Math.min(90, +m.z || 0)); p.ry = +m.ry || 0; p.a = m.a === 'run' || m.a === 'walk' ? m.a : 'idle'; });
  s.on('pickup', id => { const r = s.room, p = r?.players[s.id], it = r?.items[id];
    if (!p || r.phase !== 'play' || !it || it.state !== 0 || p.held != null || d(p, it) > REACH) return;
    it.state = 1; it.holder = s.id; it.mounted = false; p.held = id; });
  s.on('drop', () => drop(s.room, s.id));
  s.on('fit', () => { const r = s.room, p = r?.players[s.id]; if (!p || r.phase !== 'play' || p.held == null) return; const it = r.items[p.held];
    if (d(p, slotPos(it.type)) > 2.8) return s.emit('msg', `The ${it.type} doesn't go here – follow the glowing spot`);
    if (it.type === 'key' && r.fixed.length < STEPS.length - 1) return s.emit('msg', 'Fit everything else before the key!');
    it.state = 2; it.holder = null; p.held = null; r.fixed.push(it.type);
    io.to(r.code).emit('msg', `${p.name} fitted the ${it.type} (${r.fixed.length}/${STEPS.length})`); });
  s.on('board', () => { const r = s.room, p = r?.players[s.id];
    if (!p || r.phase !== 'play' || r.fixed.length < STEPS.length || d(p, TRUCK) > TRUCK_REACH) return;
    r.boarded[s.id] = true; checkStart(r); });
  s.on('drive_in', m => { const r = s.room; if (!r || r.phase !== 'drive' || r.driver !== s.id) return;
    r.drv.steer = clamp(+m?.steer || 0, -1, 1); r.drv.thr = clamp(+m?.thr || 0, -1, 1); });
  s.on('disconnect', () => {
    if (s.uname && names.get(s.uname.toLowerCase()) === s.id) names.delete(s.uname.toLowerCase());
    const r = s.room; if (!r) return; drop(r, s.id); delete r.players[s.id]; delete r.boarded[s.id];
    const ids = Object.keys(r.players); if (!ids.length) return void delete rooms[r.code];
    if (r.host === s.id) { r.host = ids[0]; io.to(r.code).emit('msg', `${r.players[ids[0]].name} is now host`); }
    if (r.phase === 'drive' && r.driver === s.id) { r.driver = r.host; io.to(r.code).emit('driver', r.driver); r.drv.steer = 0; }
    lobby(r); checkStart(r); });
});
function drop(r, id) { const p = r?.players[id]; if (!p || p.held == null) return; const it = r.items[p.held]; it.state = 0; it.holder = null; it.x = p.x; it.z = p.z; p.held = null; }

// ---------------- drive phase: storm hits, escape 5 km ----------------
function checkStart(r) { const ids = Object.keys(r.players);
  if (r.phase === 'play' && ids.length && ids.every(i => r.boarded[i])) startDrive(r); }
function genObstacles() { const rnd = mkRnd((Date.now() % 2147483000) + 1), L = [];
  const radius = [() => 1.7 + rnd() * .8, () => 1.1, () => 2.3, () => 1.0]; // rock, cactus, wrecked car, barrel
  let zr = 70;
  while (zr < GOAL - 40) {
    const two = rnd() < .25, offs = two ? [-9 + rnd() * 4, 3 + rnd() * 5] : [(rnd() * 2 - 1) * 10];
    for (const off of offs) { const type = rnd() * 4 | 0; L.push([type, +(roadX(zr) + off).toFixed(2), DRIVE_Z0 + zr, +radius[type]().toFixed(2), +(rnd() * 6.28).toFixed(2)]); }
    zr += (34 + rnd() * 26) * (1 - .35 * zr / GOAL); } // denser near the end
  return L; }
function startDrive(r) {
  r.phase = 'drive'; r.driver = r.host; r.obs = genObstacles(); r.hitSet = new Set();
  r.drv = { x: 0, z: DRIVE_Z0, th: -Math.PI / 2, v: 0, crash: 0, stall: 2.5, init: true, inv: 0, steer: 0, thr: 1, hit: [], zs: [], zid: 0, nextZ: 6, att: 0, dead: false, last: Date.now() };
  io.to(r.code).emit('drive_start', { obs: r.obs, z0: DRIVE_Z0, goal: GOAL, maxCrash: MAX_CRASH, driver: r.driver, x: 0, z: DRIVE_Z0, th: r.drv.th });
}
function spawnAhead(r, n) { const D = r.drv;
  for (let k = 0; k < n && D.zs.length < 14; k++) { const z = D.z + 55 + Math.random() * 55; if (z > DRIVE_Z0 + GOAL) return;
    D.zs.push({ id: ++D.zid, x: roadX(z - DRIVE_Z0) + (Math.random() * 2 - 1) * 11, z, age: 0 }); } }
function spawnNear(r, n) { const D = r.drv;
  for (let k = 0; k < n; k++) { const a = Math.random() * 6.28, R = 22 + Math.random() * 10; D.zs.push({ id: ++D.zid, x: D.x + Math.cos(a) * R, z: D.z + Math.sin(a) * R, age: 0 }); } }
function driveTick(r) { const D = r.drv, now = Date.now(), dt = Math.min(.1, (now - D.last) / 1000); D.last = now;
  D.inv -= dt;
  if (D.stall > 0) { D.stall -= dt; D.v = 0; if (D.stall <= 0) D.init = false; }
  else { D.v += (D.thr >= 0 ? 12 * D.thr : 34 * D.thr) * dt; D.v = clamp(D.v - D.v * .04 * dt, 0, VMAX);
    D.th = clamp(D.th - D.steer * 1.3 * dt * Math.min(1, D.v / 7), -Math.PI / 2 - 1.2, -Math.PI / 2 + 1.2); }
  D.x += Math.cos(D.th) * D.v * dt; D.z -= Math.sin(D.th) * D.v * dt;
  const rx = roadX(D.z - DRIVE_Z0), off = D.x - rx; if (Math.abs(off) > 19) { D.x = rx + Math.sign(off) * 19; D.v *= 1 - Math.min(1, 2 * dt); } // soft road edge
  const c = Math.cos(D.th), sn = Math.sin(D.th), local = (x, z) => { const dx = x - D.x, dz = z - D.z; return [dx * c - dz * sn, dx * sn + dz * c]; };
  // obstacle collision (truck = 5.8 x 2.6 box vs circle)
  if (D.inv <= 0 && D.v > 0) { let hit = false;
    for (let i = 0; i < r.obs.length && !hit; i++) { const o = r.obs[i]; if (r.hitSet.has(i) || Math.abs(o[2] - D.z) > 9) continue;
      const [lx, lz] = local(o[1], o[2]); if (Math.hypot(lx - clamp(lx, -2.9, 2.9), lz - clamp(lz, -1.3, 1.3)) < o[3]) hit = true; }
    if (hit) { // truck stops; everything overlapping is smashed so it can restart cleanly
      r.obs.forEach((o, i) => { if (!r.hitSet.has(i) && Math.hypot(o[1] - D.x, o[2] - D.z) < o[3] + 5) { r.hitSet.add(i); D.hit.push(i); } });
      D.crash++; D.v = 0; D.th = -Math.PI / 2; D.z -= 2; D.inv = 6; D.dead = D.crash >= MAX_CRASH; D.stall = D.dead ? 1e9 : 3.5; spawnNear(r, D.dead ? 5 : 2); } }
  // zombies: pop up ahead, chase the truck, kill when it is stopped (or grab it when run over)
  D.nextZ -= dt; if (!D.init && !D.dead && D.nextZ <= 0) { spawnAhead(r, Math.random() < .5 ? 2 : 1); D.nextZ = 4 + Math.random() * 4; }
  const [tc, ts] = [Math.cos(D.th), Math.sin(D.th)]; let touching = 0;
  for (let i = D.zs.length - 1; i >= 0; i--) { const q = D.zs[i]; q.age += dt;
    if (q.age > .9) { const dx = D.x - q.x, dz = D.z - q.z, l = Math.hypot(dx, dz); if (l < 60 && l > .01) { const m = Math.min(8 * dt, l); q.x += dx / l * m; q.z += dz / l * m; } }
    if (q.z < D.z - 90) { D.zs.splice(i, 1); continue; }
    const dx = q.x - D.x, dz = q.z - D.z, lx = dx * tc - dz * ts, lz = dx * ts + dz * tc;
    if (Math.abs(lx) < 3.5 && Math.abs(lz) < 1.9 && q.age > .9) {
      if (D.v >= 8) { D.zs.splice(i, 1); D.v *= .8; D.att += .6; } else touching++; } }
  D.att = touching ? D.att + dt * Math.min(touching, 3) : Math.max(0, D.att - dt * .6);
  if (D.att >= 4) { r.phase = 'lost'; io.to(r.code).emit('end', D.dead ? 'crash' : 'zombie'); return; }
  if (D.z - DRIVE_Z0 >= GOAL) { r.phase = 'won'; io.to(r.code).emit('end', 'won'); return; }
  io.to(r.code).emit('drive', { x: +D.x.toFixed(2), z: +D.z.toFixed(2), th: +D.th.toFixed(3), v: +D.v.toFixed(1), c: D.crash, st: D.stall > 0 ? 1 : 0, ready: D.init ? 1 : 0, d: Math.round(D.z - DRIVE_Z0), hit: D.hit,
    zs: D.zs.map(q => [q.id, +q.x.toFixed(1), +q.z.toFixed(1)]), att: +D.att.toFixed(2), dead: D.dead }); }
setInterval(() => { for (const r of Object.values(rooms)) if (r.phase === 'drive') driveTick(r); }, 33);

setInterval(() => { for (const r of Object.values(rooms)) { if (r.phase !== 'play') continue;
  const storm = Math.min(1, (Date.now() - r.t0) / STORM_MS);
  if (storm >= 1) { r.phase = 'lost'; io.to(r.code).emit('end', 'lost'); continue; }
  io.to(r.code).emit('state', { storm, step: r.fixed.length, fixed: r.fixed, it: r.items.map(i => [i.state, +i.x.toFixed(1), +i.z.toFixed(1), i.holder, i.mounted ? 1 : 0]), boarded: Object.keys(r.boarded).length,
    p: Object.fromEntries(Object.entries(r.players).map(([id, p]) => [id, [p.x, p.z, p.ry, p.a]])) }); } }, 100);
srv.listen(process.env.PORT || 3000, () => console.log('LAST SHELTER on http://localhost:' + (process.env.PORT || 3000)));
