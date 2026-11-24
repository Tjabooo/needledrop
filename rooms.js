// Rooms: one host device runs the game (and Spotify); everyone else joins with a short code and gets their own
// screen. The server is only a relay: it never looks inside the game state. Rooms live in memory; a host that
// comes back after a server restart re-creates its room with the same code, keys and members.
//
//   POST /api/rooms                  {restore?}            → {code, hostKey}
//   GET  /api/rooms/CODE?key=K                             → {room, host, member}
//   GET  /api/rooms/CODE/stream?key=K                      → server-sent events (host or member)
//   POST /api/rooms/CODE/join        {name, born}          → {pid, key}
//   POST /api/rooms/CODE/state       {key, state}          host → every member
//   POST /api/rooms/CODE/act         {key, act}            member → host
//   POST /api/rooms/CODE/profile     {key, name, born}     member → host
//   POST /api/rooms/CODE/leave       {key}                 member leaves
//   POST /api/rooms/CODE/kick        {key, pid}            host removes a member
//   POST /api/rooms/CODE/close       {key}                 host closes the room
import { randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: codes never spell words
const MAX_ROOMS = 300;
const MAX_MEMBERS = 16;
const IDLE_MS = 12 * 3600e3;
const HEARTBEAT_MS = 20e3;
const MAX_BODY = 512 * 1024;
const CREATES_PER_HOUR = 30;

const rooms = new Map();
const creates = new Map(); // ip → [timestamps]

const newKey = () => randomBytes(16).toString('hex');
const newPid = () => randomBytes(5).toString('hex');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const sameKey = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const isCode = (s) => typeof s === 'string' && new RegExp(`^[${ALPHABET}]{4}$`).test(s);

function newCode() {
  for (let i = 0; i < 200; i++) {
    let c = '';
    for (const b of randomBytes(4)) c += ALPHABET[b % ALPHABET.length];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function makeRoom(code, hostKey) {
  const room = { code, hostKey, touched: Date.now(), state: null, members: new Map(), hostStreams: new Set(), memberStreams: new Map() };
  rooms.set(code, room);
  return room;
}

function frame(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
function writeAll(streams, data) { for (const res of streams) res.write(data); }
const online = (room) => [...room.memberStreams].filter(([, s]) => s.size).map(([pid]) => pid);
const memberList = (room) => [...room.members.values()].map(({ pid, name, born, key }) => ({ pid, name, born, key }));

function toHost(room, obj) { writeAll(room.hostStreams, frame(obj)); }
function toMember(room, pid, obj) { const s = room.memberStreams.get(pid); if (s) writeAll(s, frame(obj)); }
function toMembers(room, data) { for (const s of room.memberStreams.values()) writeAll(s, data); }

function memberByKey(room, key) {
  for (const m of room.members.values()) if (sameKey(m.key, key)) return m;
  return null;
}

function dropMemberStreams(room, pid, obj) {
  const s = room.memberStreams.get(pid);
  if (!s) return;
  for (const res of s) { res.write(frame(obj)); res.end(); }
  room.memberStreams.delete(pid);
}

function closeRoom(room) {
  toMembers(room, frame({ type: 'closed' }));
  for (const s of [room.hostStreams, ...room.memberStreams.values()]) for (const res of s) res.end();
  rooms.delete(room.code);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const live = room.hostStreams.size || online(room).length;
    if (!live && now - room.touched > IDLE_MS) closeRoom(room);
  }
  for (const [ip, list] of creates) { const keep = list.filter((t) => now - t < 3600e3); if (keep.length) creates.set(ip, keep); else creates.delete(ip); }
}, 10 * 60e3).unref();

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function stream(req, res, room, who) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\n: ${' '.repeat(2048)}\n\n`); // padding gets the stream past buffering proxies
  room.touched = Date.now();
  let set;
  if (who === 'host') {
    set = room.hostStreams;
    set.add(res);
    res.write(frame({ type: 'hello', members: memberList(room), online: online(room) }));
    toMembers(room, frame({ type: 'host', online: true }));
  } else {
    if (!room.memberStreams.has(who.pid)) room.memberStreams.set(who.pid, new Set());
    set = room.memberStreams.get(who.pid);
    const wasOnline = set.size > 0;
    set.add(res);
    res.write(frame({ type: 'hello', pid: who.pid, name: who.name, host: room.hostStreams.size > 0 }));
    if (room.state) res.write(`data: {"type":"state","state":${room.state}}\n\n`);
    if (!wasOnline) toHost(room, { type: 'presence', online: online(room) });
  }
  const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(beat);
    set.delete(res);
    room.touched = Date.now();
    if (!rooms.has(room.code)) return;
    if (who === 'host') { if (!set.size) toMembers(room, frame({ type: 'host', online: false })); }
    else if (!set.size) { room.memberStreams.delete(who.pid); toHost(room, { type: 'presence', online: online(room) }); }
  });
}

// Returns true when the request was a room request (handled), false otherwise.
export async function handleRooms(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api rooms CODE action
  if (parts[0] !== 'api' || parts[1] !== 'rooms') return false;
  try {
    if (parts.length === 2) {
      if (req.method !== 'POST') return json(res, 405, { error: 'method' }), true;
      const body = await readBody(req);
      const r = body.restore;
      if (r && isCode(r.code) && typeof r.hostKey === 'string' && /^[0-9a-f]{32}$/.test(r.hostKey)) {
        const have = rooms.get(r.code);
        if (have && !sameKey(have.hostKey, r.hostKey)) return json(res, 409, { error: 'code taken' }), true;
        const room = have || makeRoom(r.code, r.hostKey);
        for (const m of (Array.isArray(r.members) ? r.members : []).slice(0, MAX_MEMBERS)) {
          if (typeof m?.pid === 'string' && /^[0-9a-f]{10}$/.test(m.pid) && /^[0-9a-f]{32}$/.test(m.key || '') && !room.members.has(m.pid)) {
            room.members.set(m.pid, { pid: m.pid, key: m.key, name: clean(m.name, 18) || 'Player', born: clean(m.born, 4) });
          }
        }
        return json(res, 200, { code: room.code, hostKey: room.hostKey, restored: true }), true;
      }
      const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
      const list = creates.get(ip) || [];
      if (list.filter((t) => Date.now() - t < 3600e3).length >= CREATES_PER_HOUR) return json(res, 429, { error: 'Too many rooms from here; try again later.' }), true;
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'The server is full right now; try again later.' }), true;
      const code = newCode();
      if (!code) return json(res, 503, { error: 'no free code' }), true;
      list.push(Date.now());
      creates.set(ip, list);
      const room = makeRoom(code, newKey());
      return json(res, 200, { code, hostKey: room.hostKey }), true;
    }

    const code = String(parts[2] || '').toUpperCase();
    const room = isCode(code) ? rooms.get(code) : null;
    const action = parts[3] || '';
    if (!room) return json(res, 404, { error: 'No room with that code.' }), true;

    if (req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      const isHost = sameKey(room.hostKey, key);
      const member = isHost ? null : memberByKey(room, key);
      if (action === '') return json(res, 200, { room: true, host: isHost, member: !!member, hostOnline: room.hostStreams.size > 0, members: room.members.size }), true;
      if (action === 'stream') {
        if (!isHost && !member) return json(res, 403, { error: 'Not in this room.' }), true;
        stream(req, res, room, isHost ? 'host' : member);
        return true;
      }
      return json(res, 404, { error: 'not found' }), true;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' }), true;

    const body = await readBody(req);
    room.touched = Date.now();
    const isHost = sameKey(room.hostKey, body.key);
    const member = isHost ? null : memberByKey(room, body.key);

    switch (action) {
      case 'join': {
        if (room.members.size >= MAX_MEMBERS) return json(res, 409, { error: 'The room is full.' }), true;
        const name = clean(body.name, 18);
        if (!name) return json(res, 400, { error: 'Type a name first.' }), true;
        const m = { pid: newPid(), key: newKey(), name, born: clean(body.born, 4).replace(/\D/g, '') };
        room.members.set(m.pid, m);
        toHost(room, { type: 'join', member: m });
        return json(res, 200, { pid: m.pid, key: m.key, hostOnline: room.hostStreams.size > 0 }), true;
      }
      case 'state': {
        if (!isHost) return json(res, 403, { error: 'Only the host can do that.' }), true;
        const state = JSON.stringify(body.state ?? null);
        room.state = state;
        toMembers(room, `data: {"type":"state","state":${state}}\n\n`);
        return json(res, 200, { ok: true }), true;
      }
      case 'act': {
        if (!member) return json(res, 403, { error: 'Not in this room.' }), true;
        if (!room.hostStreams.size) return json(res, 409, { error: 'The host is offline right now.' }), true;
        toHost(room, { type: 'act', pid: member.pid, act: body.act });
        return json(res, 200, { ok: true }), true;
      }
      case 'profile': {
        if (!member) return json(res, 403, { error: 'Not in this room.' }), true;
        const name = clean(body.name, 18);
        if (name) member.name = name;
        member.born = clean(body.born, 4).replace(/\D/g, '');
        toHost(room, { type: 'profile', pid: member.pid, name: member.name, born: member.born });
        return json(res, 200, { ok: true }), true;
      }
      case 'leave': {
        if (!member) return json(res, 200, { ok: true }), true;
        room.members.delete(member.pid);
        dropMemberStreams(room, member.pid, { type: 'left' });
        toHost(room, { type: 'leave', pid: member.pid });
        toHost(room, { type: 'presence', online: online(room) });
        return json(res, 200, { ok: true }), true;
      }
      case 'kick': {
        if (!isHost) return json(res, 403, { error: 'Only the host can do that.' }), true;
        const pid = String(body.pid || '');
        room.members.delete(pid);
        dropMemberStreams(room, pid, { type: 'kicked' });
        toHost(room, { type: 'presence', online: online(room) });
        return json(res, 200, { ok: true }), true;
      }
      case 'close': {
        if (!isHost) return json(res, 403, { error: 'Only the host can do that.' }), true;
        closeRoom(room);
        return json(res, 200, { ok: true }), true;
      }
      default:
        return json(res, 404, { error: 'not found' }), true;
    }
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    return true;
  }
}

export const _rooms = rooms; // for tests
