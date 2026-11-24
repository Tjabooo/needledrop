// Room relay: host ↔ phones through the server (no browser).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PORT = 8197;
const base = `http://127.0.0.1:${PORT}`;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let server;

const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

// Minimal SSE reader: collects parsed events, next(type) waits for the next one of that type.
function listen(url) {
  const events = [];
  const waiters = [];
  const ctrl = new AbortController();
  const ready = fetch(url, { signal: ctrl.signal }).then(async (r) => {
    if (r.status !== 200) { events.push({ type: '_status', status: r.status }); flush(); return r.status; }
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = block.split('\n').find((l) => l.startsWith('data: '));
            if (line) { events.push(JSON.parse(line.slice(6))); flush(); }
          }
        }
      } catch { /* aborted */ }
      events.push({ type: '_end' }); flush();
    })();
    return 200;
  });
  function flush() {
    for (const w of waiters.splice(0)) {
      const i = events.findIndex((e, n) => n >= w.from && e.type === w.type);
      if (i >= 0) w.resolve(events[i]); else waiters.push(w);
    }
  }
  let seen = 0;
  return {
    ready, events, close: () => ctrl.abort(),
    next(type, ms = 3000) {
      return new Promise((resolve, reject) => {
        const w = { type, from: seen, resolve: (e) => { seen = events.indexOf(e) + 1; resolve(e); } };
        waiters.push(w); flush();
        setTimeout(() => reject(new Error(`no ${type} event`)), ms).unref();
      });
    },
  };
}

before(async () => {
  server = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT: String(PORT), SPOTIFY_CLIENT_ID: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await fetch(base + '/api/health').then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => server.kill());

test('host and phone talk through a room', async () => {
  const { data: room } = await post('/api/rooms', {});
  assert.match(room.code, /^[A-Z]{4}$/);
  assert.match(room.hostKey, /^[0-9a-f]{32}$/);

  const host = listen(`${base}/api/rooms/${room.code}/stream?key=${room.hostKey}`);
  await host.next('hello');

  const bad = await post(`/api/rooms/ZZZZ/join`, { name: 'x' });
  assert.equal(bad.status, 404);
  const noName = await post(`/api/rooms/${room.code}/join`, { name: '  ' });
  assert.equal(noName.status, 400);

  const { data: seat } = await post(`/api/rooms/${room.code.toLowerCase()}/join`, { name: 'Mamma', born: '1973' });
  const join = await host.next('join');
  assert.equal(join.member.name, 'Mamma');
  assert.equal(join.member.pid, seat.pid);

  // no state yet: the phone just gets hello
  const phone = listen(`${base}/api/rooms/${room.code}/stream?key=${seat.key}`);
  const hello = await phone.next('hello');
  assert.equal(hello.host, true);
  assert.deepEqual((await host.next('presence')).online, [seat.pid]);

  // host state reaches the phone; a phone cannot send state
  await post(`/api/rooms/${room.code}/state`, { key: room.hostKey, state: { round: 1 } });
  assert.deepEqual((await phone.next('state')).state, { round: 1 });
  assert.equal((await post(`/api/rooms/${room.code}/state`, { key: seat.key, state: { round: 9 } })).status, 403);

  // a late phone gets the latest state straight away
  const again = listen(`${base}/api/rooms/${room.code}/stream?key=${seat.key}`);
  assert.deepEqual((await again.next('state')).state, { round: 1 });
  again.close();

  // moves go to the host, tagged with the seat
  await post(`/api/rooms/${room.code}/act`, { key: seat.key, act: { a: 'slot', slot: 2 } });
  const act = await host.next('act');
  assert.equal(act.pid, seat.pid);
  assert.deepEqual(act.act, { a: 'slot', slot: 2 });
  assert.equal((await post(`/api/rooms/${room.code}/act`, { key: 'nope', act: {} })).status, 403);

  await post(`/api/rooms/${room.code}/profile`, { key: seat.key, name: 'Mor', born: '1973' });
  assert.equal((await host.next('profile')).name, 'Mor');

  // the host going away is announced, and moves are refused until it is back
  host.close();
  assert.equal((await phone.next('host')).online, false);
  assert.equal((await post(`/api/rooms/${room.code}/act`, { key: seat.key, act: { a: 'next' } })).status, 409);
  const host2 = listen(`${base}/api/rooms/${room.code}/stream?key=${room.hostKey}`);
  const hello2 = await host2.next('hello');
  assert.equal(hello2.members[0].key, seat.key);
  assert.equal((await phone.next('host')).online, true);

  // kick: the phone is told and its key stops working
  await post(`/api/rooms/${room.code}/kick`, { key: room.hostKey, pid: seat.pid });
  await phone.next('kicked');
  const info = await (await fetch(`${base}/api/rooms/${room.code}?key=${seat.key}`)).json();
  assert.equal(info.member, false);
  const refused = listen(`${base}/api/rooms/${room.code}/stream?key=${seat.key}`);
  assert.equal(await refused.ready, 403);

  // close: the room disappears
  await post(`/api/rooms/${room.code}/close`, { key: room.hostKey });
  assert.equal((await fetch(`${base}/api/rooms/${room.code}`)).status, 404);
  host2.close();
  phone.close();
});

test('a host can bring a room back after a server restart', async () => {
  const restore = { code: 'BCDF', hostKey: 'a'.repeat(32), members: [{ pid: 'b'.repeat(10), key: 'c'.repeat(32), name: 'Pappa' }] };
  const { status, data } = await post('/api/rooms', { restore });
  assert.equal(status, 200);
  assert.equal(data.code, 'BCDF');
  const info = await (await fetch(`${base}/api/rooms/BCDF?key=${'c'.repeat(32)}`)).json();
  assert.equal(info.member, true);
  // someone else cannot take it over
  assert.equal((await post('/api/rooms', { restore: { ...restore, hostKey: 'd'.repeat(32) } })).status, 409);
  await post('/api/rooms/BCDF/close', { key: 'a'.repeat(32) });
});
