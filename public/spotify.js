// Spotify: PKCE login (no client secret), the Web Playback SDK player, playback control and search.

const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state',
  'playlist-read-private', 'playlist-read-collaborative',
].join(' ');
const TOKEN_KEY = 'nd.spotify.token';
const VERIFIER_KEY = 'nd.spotify.verifier';

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class SpotifyError extends Error {
  constructor(status, message, reason) { super(message); this.status = status; this.reason = reason; }
}

export class Spotify {
  constructor(clientId, redirectUri) {
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    this.tok = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    this.player = null;
    this.deviceId = null; // the in-browser player's device id once ready
    this.playerState = 'off'; // off | loading | ready | error
    this.playerError = '';
    this.paused = true;
    this.onChange = () => {};
  }

  get loggedIn() { return !!(this.tok && this.tok.refresh); }

  async login() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    localStorage.setItem(VERIFIER_KEY, verifier);
    const q = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: challenge, redirect_uri: this.redirectUri,
    });
    location.href = `https://accounts.spotify.com/authorize?${q}`;
  }

  logout() {
    this.tok = null;
    localStorage.removeItem(TOKEN_KEY);
    if (this.player) this.player.disconnect();
    this.player = null; this.deviceId = null; this.playerState = 'off';
  }

  // Finish the login redirect (?code=...). Returns an error string, or '' when there was nothing to do / it worked.
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const err = params.get('error');
    if (!code && !err) return '';
    history.replaceState(null, '', location.pathname + location.hash);
    if (err) return err === 'access_denied' ? 'Spotify login was cancelled.' : `Spotify said: ${err}`;
    const verifier = localStorage.getItem(VERIFIER_KEY);
    localStorage.removeItem(VERIFIER_KEY);
    try {
      await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: verifier || '' });
      return '';
    } catch (e) {
      return `Spotify login failed: ${e.message}`;
    }
  }

  async tokenRequest(body) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SpotifyError(res.status, data.error_description || data.error || `HTTP ${res.status}`);
    this.tok = {
      access: data.access_token,
      refresh: data.refresh_token || this.tok?.refresh,
      exp: Date.now() + (data.expires_in || 3600) * 1000,
    };
    localStorage.setItem(TOKEN_KEY, JSON.stringify(this.tok));
  }

  async token() {
    if (!this.tok) throw new SpotifyError(401, 'Not logged in to Spotify');
    if (Date.now() > this.tok.exp - 60_000) {
      if (!this.refreshing) {
        this.refreshing = this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tok.refresh })
          .catch((e) => { if (e.status === 400) this.logout(); throw e; })
          .finally(() => { this.refreshing = null; });
      }
      await this.refreshing;
    }
    return this.tok.access;
  }

  async api(path, { method = 'GET', query, body, retry = 2 } = {}) {
    const url = new URL(`https://api.spotify.com/v1${path}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && retry > 0) {
      const wait = Math.min(10, parseInt(res.headers.get('Retry-After') || '2', 10));
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.api(path, { method, query, body, retry: retry - 1 });
    }
    if (res.status === 401 && retry > 0) {
      this.tok.exp = 0;
      return this.api(path, { method, query, body, retry: retry - 1 });
    }
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const e = data?.error || {};
      throw new SpotifyError(res.status, e.message || `Spotify HTTP ${res.status}`, e.reason);
    }
    return data;
  }

  me() { return this.api('/me'); }

  // Search tracks. Development-mode apps get at most 10 results per page.
  async searchTracks(q, { limit = 10, offset = 0 } = {}) {
    const data = await this.api('/search', { query: { q, type: 'track', limit, offset } });
    return data?.tracks?.items || [];
  }

  artist(id) { return this.api(`/artists/${id}`); }

  async myPlaylists() {
    const out = [];
    for (let offset = 0; offset < 200; offset += 50) {
      const data = await this.api('/me/playlists', { query: { limit: 50, offset } });
      out.push(...(data?.items || []));
      if (!data?.next) break;
    }
    return out.filter(Boolean);
  }

  // Tracks of a playlist you own or collaborate on (other playlists return no items to dev-mode apps).
  async playlistTracks(id) {
    const out = [];
    for (let offset = 0; offset < 1000; offset += 50) {
      let data;
      try {
        data = await this.api(`/playlists/${id}/items`, { query: { limit: 50, offset } });
      } catch (e) {
        if (e.status !== 404 || offset) throw e;
        data = await this.api(`/playlists/${id}/tracks`, { query: { limit: 50, offset } });
      }
      const items = data?.items || [];
      for (const it of items) out.push(it.item || it.track);
      if (!data?.next || !items.length) break;
    }
    return out.filter(Boolean);
  }

  async devices() {
    const data = await this.api('/me/player/devices');
    return data?.devices || [];
  }

  // ----- in-browser player -----

  loadPlayer(name) {
    if (this.player || this.playerState === 'loading') return;
    this.playerState = 'loading';
    this.onChange();
    const start = () => {
      const player = new window.Spotify.Player({
        name, volume: 0.85,
        getOAuthToken: (cb) => this.token().then(cb).catch(() => {}),
      });
      player.addListener('ready', ({ device_id }) => { this.deviceId = device_id; this.playerState = 'ready'; this.onChange(); });
      player.addListener('not_ready', () => { this.playerState = 'loading'; this.onChange(); });
      player.addListener('player_state_changed', (s) => { this.paused = !s || s.paused; this.position = s?.position || 0; this.onChange(); });
      const fail = (msg) => ({ message }) => { this.playerState = 'error'; this.playerError = `${msg}: ${message}`; this.onChange(); };
      player.addListener('initialization_error', fail('This browser cannot play Spotify (try Chrome, Edge or Firefox)'));
      player.addListener('authentication_error', fail('Spotify login expired, log in again'));
      player.addListener('account_error', fail('Spotify Premium is needed to play in the browser'));
      player.addListener('playback_error', ({ message }) => { this.playerError = message; this.onChange(); });
      player.connect();
      this.player = player;
    };
    if (window.Spotify?.Player) return start();
    window.onSpotifyWebPlaybackSDKReady = start;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => { this.playerState = 'error'; this.playerError = 'Could not load the Spotify player (blocked by an ad blocker?)'; this.onChange(); };
    document.head.appendChild(s);
  }

  // Browsers only allow sound after a click: call this from a click handler.
  activate() {
    try { this.player?.activateElement?.(); } catch { /* older SDK */ }
  }

  async play(deviceId, uri, positionMs = 0) {
    await this.api('/me/player/play', { method: 'PUT', query: { device_id: deviceId }, body: { uris: [uri], position_ms: positionMs } });
    this.paused = false;
  }

  async pause(deviceId) {
    try { await this.api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId } }); } catch (e) { if (e.status !== 403) throw e; }
    this.paused = true;
  }

  async resume(deviceId) {
    await this.api('/me/player/play', { method: 'PUT', query: { device_id: deviceId } });
    this.paused = false;
  }

  async seek(deviceId, ms) {
    await this.api('/me/player/seek', { method: 'PUT', query: { position_ms: Math.max(0, Math.round(ms)), device_id: deviceId } });
  }
}
