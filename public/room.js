// Room link: talks to the relay in rooms.js. The host pushes the game to everyone; members send their moves back.

async function call(path, body, method = 'POST') {
  const r = await fetch(path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
  });
  let data = {};
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}

export const createRoom = (restore) => call('/api/rooms', restore ? { restore } : {});
export const roomInfo = (code, key = '') => call(`/api/rooms/${code}?key=${encodeURIComponent(key)}`, null, 'GET');
export const joinRoom = (code, name, born) => call(`/api/rooms/${code}/join`, { name, born });

// One live connection (host or member). onEvent gets every message; onStatus gets 'live' | 'retry' | 'gone'.
export class RoomLink {
  constructor(code, key, { onEvent, onStatus }) {
    Object.assign(this, { code, key, onEvent, onStatus, es: null, closed: false });
    this.sending = null;
    this.queued = undefined;
  }

  open() {
    if (this.closed) return;
    this.es?.close();
    const es = new EventSource(`/api/rooms/${this.code}/stream?key=${encodeURIComponent(this.key)}`);
    this.es = es;
    es.onopen = () => this.onStatus('live');
    es.onmessage = (m) => { try { this.onEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
    es.onerror = async () => {
      if (this.closed || es !== this.es) return;
      if (es.readyState !== EventSource.CLOSED) { this.onStatus('retry'); return; }
      // The server refused the stream: find out whether the room (or our seat in it) is gone.
      let info = null;
      try { info = await roomInfo(this.code, this.key); } catch (e) { if (e.status !== 404) info = { unknown: true }; }
      if (this.closed || es !== this.es) return;
      if (info && (info.unknown || info.host || info.member)) { this.onStatus('retry'); setTimeout(() => this.open(), 2500); }
      else this.onStatus('gone', info);
    };
  }

  post(action, body = {}) { return call(`/api/rooms/${this.code}/${action}`, { key: this.key, ...body }); }

  // Host: send the newest state; while one send is in flight only the latest pending one is kept.
  pushState(state) {
    this.queued = state;
    if (this.sending) return;
    const next = () => {
      if (this.queued === undefined || this.closed) { this.sending = null; return; }
      const s = this.queued;
      this.queued = undefined;
      this.sending = this.post('state', { state: s }).catch(() => {}).then(next);
    };
    next();
  }

  close() { this.closed = true; this.es?.close(); this.es = null; }
}
