import * as G from './game.js';
import { Spotify } from './spotify.js';
import { t, lang, pickLang, followLang, poss, decade } from './i18n.js';
import { qrSvg } from './qr.js';
import { RoomLink, createRoom, joinRoom } from './room.js';

const $app = document.getElementById('app');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast(t('Browser storage is full: {msg}', { msg: e.message })); } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const REDIRECT = location.origin + '/';
const EXTREME_RE = /death|black metal|grind|deathcore|blackened|brutal|gore/i;

let config = { spotifyClientId: '' };
let library = [];
let setup = store.get('nd.setup', null) || { players: [], packs: [], settings: { ...G.DEFAULT_SETTINGS }, device: 'browser' };
setup.settings = { ...G.DEFAULT_SETTINGS, ...setup.settings };
let game = store.get('nd.game', null);
let undoStack = store.get('nd.undo', []);
let cache = store.get('nd.cache', {});
let sp = null;
const ui = {
  view: game && game.phase !== 'over' ? 'game' : 'setup',
  busy: '', toast: '', modal: null, challenger: null, devices: [], me: null,
  builder: { genres: ['rock'], other: '', decades: [], owner: 'all' },
  playing: false, peek: false,
};

// Rooms: 'local' = one screen for the whole table (the original game), 'host' = this device runs the game and
// Spotify while players follow on their own phones, 'guest' = this phone shows a host's game.
let role = 'local';
let hostRoom = store.get('nd.room', null); // host: { code, hostKey, members: { pid: { pid, key, name, born } } }
let guestSeat = store.get('nd.guest', null); // guest: { code, pid, key, name, born }
let link = null;
let remote = null; // guest: the latest state from the host
const room = { status: '', online: [], hostOnline: true, lastSent: '' };
const pathCode = (location.pathname.match(/^\/([a-z]{4})\/?$/i) || [])[1]?.toUpperCase() || '';

const saveSetup = () => store.set('nd.setup', setup);
const saveGame = () => { if (role === 'guest') return; store.set('nd.game', game); store.set('nd.undo', undoStack.slice(-25)); };
const saveCache = () => store.set('nd.cache', cache);

let toastTimer;
function toast(msg, ms = 4200) {
  ui.toast = msg;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast = ''; render(); }, ms);
}

function yearColor(y) {
  const h = 8 + ((Math.min(2026, Math.max(1955, y)) - 1955) / 71) * 290;
  return `hsl(${h.toFixed(0)} 78% 62%)`;
}

// ---------- Spotify glue ----------

// ?demo: no Spotify at all, silent. For trying the game flow and for screenshots.
const DEMO = new URLSearchParams(location.search).has('demo');
class DemoSpotify {
  loggedIn = true; playerState = 'ready'; deviceId = 'demo'; paused = true; onChange() {}
  activate() {} loadPlayer() {} logout() {} async handleRedirect() { return ''; }
  async me() { return { display_name: t('demo mode (no sound)') }; } async devices() { return []; }
  async searchTracks(q) {
    const m = q.match(/track:"([^"]*)" artist:"([^"]*)"/);
    if (!m) return [];
    const song = library.find((s) => G.coreTitle(s.t) === G.coreTitle(m[1]));
    return song ? [{ uri: 'demo:' + song.k, name: song.t, artists: [{ name: song.a }], album: { release_date: String(song.y), album_type: 'album', images: [] } }] : [];
  }
  async play() { this.paused = false; } async pause() { this.paused = true; } async resume() { this.paused = false; }
}

function makeSpotify() {
  if (DEMO) { sp = new DemoSpotify(); return; }
  const id = (store.get('nd.clientId', '') || config.spotifyClientId || '').trim();
  sp = id ? new Spotify(id, REDIRECT) : null;
  if (sp) sp.onChange = () => { if (setup.device === 'browser') ui.playing = !sp.paused; render(); };
}

function deviceId() {
  if (!sp) return null;
  return setup.device && setup.device !== 'browser' ? setup.device : sp.deviceId;
}

function explain(e) {
  if (e.status === 404) return t('Spotify could not find the player. Open Spotify on this device, or pick "This browser" in setup.');
  if (e.status === 403) return t('Spotify refused playback (Premium needed, or the account is not added to the app).');
  if (e.reason === 'QUOTA_EXCEEDED') return t('Spotify rate limit for this app reached; wait a minute.');
  return t(e.message || String(e));
}

async function refreshDevices() {
  if (!sp?.loggedIn) return;
  try { ui.devices = await sp.devices(); } catch (e) { toast(explain(e)); }
  render();
}

const cleanQ = (s) => String(s).replace(/\s*[[(][^\])]*[\])]/g, ' ').replace(/["]/g, ' ').trim();

// Turn a song (library line or search result) into something playable, or null.
async function resolveSong(song) {
  if (song.uri) {
    if (song.checked) return song;
    const c = { ...song, checked: true };
    try {
      if (setup.settings.exclude.includes('extreme') && c.artistId) {
        const key = 'artist:' + c.artistId;
        if (!cache[key]) { const a = await sp.artist(c.artistId); cache[key] = { genres: a?.genres || [] }; saveCache(); }
        if (cache[key].genres.some((g) => EXTREME_RE.test(g))) return null;
      }
      const first = c.a.split(',')[0];
      const tracks = await sp.searchTracks(`track:"${cleanQ(c.t)}" artist:"${cleanQ(first)}"`);
      c.y = G.earliestYear(c, tracks);
    } catch (e) { if (e.status === 401) throw e; }
    return c;
  }
  if (cache[song.k]?.uri) return { ...song, ...cache[song.k] };
  if (cache[song.k]?.missing && Date.now() - cache[song.k].missing < 7 * 864e5) return null;
  let tracks = await sp.searchTracks(`track:"${cleanQ(song.t)}" artist:"${cleanQ(song.a)}"`);
  let m = G.bestMatch(song, tracks);
  if (!m) { tracks = await sp.searchTracks(`${cleanQ(song.t)} ${cleanQ(song.a)}`); m = G.bestMatch(song, tracks); }
  if (!m) { cache[song.k] = { missing: Date.now() }; saveCache(); return null; }
  cache[song.k] = { uri: m.uri, img: m.album?.images?.[0]?.url || '', dur: m.duration_ms || 0 };
  saveCache();
  return { ...song, ...cache[song.k] };
}

async function drawFor(playerIndex) {
  const p = game.players[playerIndex];
  for (let attempt = 0; attempt < 15; attempt++) {
    const all = G.buildPool(setup.packs, library, game.settings, { owner: game.teams ? null : p.id, used: game.used });
    // Generation war: songs from the other team's youth (the whole deck once those run out).
    const decs = G.warDecades(game, playerIndex);
    const era = decs ? all.filter((s) => decs.some((d) => s.y >= d && s.y <= d + 9)) : all;
    const pool = era.length ? era : all;
    if (!pool.length) throw new Error(game.settings.ownTaste ? t('Out of songs for {name}: add more song packs in setup.', { name: p.name }) : t('Out of songs: add more song packs in setup.'));
    const song = G.pick(pool);
    const card = await resolveSong(song);
    if (card) return card;
    game.used.push(song.k);
  }
  throw new Error(t('Spotify did not find the last songs it was asked for. Try again.'));
}

function startPosition(card) {
  const dur = card.dur || 180000;
  if (game.settings.startAt === '30' && dur > 75000) return 30000;
  if (game.settings.startAt === 'random' && dur > 90000) return Math.round(dur * (0.15 + Math.random() * 0.35));
  return 0;
}

async function playCard(card, pos = startPosition(card)) {
  const dev = deviceId();
  if (!dev) { toast(setup.device === 'browser' ? t('The browser player is still starting. Press play in a moment.') : t('Pick a Spotify device in setup.')); return false; }
  try {
    await sp.play(dev, card.uri, pos);
    ui.started = card.k; // only once this song really started: a failed start must not "resume" the last Spotify song
    ui.playing = true;
  } catch (e) { toast(explain(e)); render(); return false; }
  render();
  return true;
}

async function togglePlay() {
  const card = game?.turn?.card;
  if (!card) return;
  sp.activate();
  if (game.phase === 'sprint') {
    if (sprint.on) { stopSprint(); await stopMusic(); render(); } else runSprint();
    return;
  }
  if (game.phase === 'buzzed') return;
  const dev = deviceId();
  try {
    if (ui.playing) { await sp.pause(dev); ui.playing = false; }
    else if (ui.started === card.k) { await (sp.resumeTrack ? sp.resumeTrack(dev, card.uri) : sp.resume(dev)); ui.playing = true; }
    else { await playCard(card); }
  } catch (e) { toast(explain(e)); }
  render();
}

async function replay() {
  const card = game?.turn?.card;
  if (!card) return;
  sp.activate();
  if (game.phase === 'sprint') { runSprint(); return; }
  if (game.phase === 'buzzed') return;
  try { await sp.play(deviceId(), card.uri, 0); ui.started = card.k; ui.playing = true; } catch (e) { toast(explain(e)); }
  render();
}

async function stopMusic() {
  if (sp?.loggedIn && ui.playing) { try { await sp.pause(deviceId()); } catch { /* ignore */ } }
  ui.playing = false;
}

// ---------- Intro sprint clips (host only) ----------
// Plays the song in growing clips (G.SPRINT_CLIPS seconds, a short pause between them), then keeps it playing.
// Any change of phase (a buzz, the reveal, undo) or a new run stops the old loop.

const sprint = { run: 0, on: false, gap: false };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIP_GAP = 2500;

function stopSprint() {
  sprint.run++;
  sprint.on = false;
  sprint.gap = false;
}

async function runSprint() {
  if (role === 'guest' || game?.phase !== 'sprint') return;
  const run = ++sprint.run;
  const card = game.turn.card;
  const live = () => sprint.run === run && game?.phase === 'sprint' && game.turn?.card?.k === card.k;
  sprint.on = true;
  while (live()) {
    const len = G.SPRINT_CLIPS[game.turn.level];
    sprint.gap = false;
    render();
    if (!(await playCard(card, game.turn.pos || 0))) { if (live()) { sprint.on = false; render(); } return; }
    if (!live() || len == null) return; // after the last clip the song just plays on
    await wait(len * 1000);
    if (!live()) return;
    try { await sp.pause(deviceId()); } catch { /* ignore */ }
    ui.playing = false;
    if (!live()) return;
    sprint.gap = true;
    render();
    await wait(CLIP_GAP);
    if (!live()) return;
    G.setSprintLevel(game, game.turn.level + 1);
    saveGame();
  }
}

// After a sprint move: wrong buzz = the clips go on; reveal = play the song for everyone.
function afterSprint() {
  if (game?.phase === 'sprint') runSprint();
  else if (game?.phase === 'reveal') { stopSprint(); playCard(game.turn.card, game.turn.pos || 0); }
}

async function doBuzz(pid) {
  if (game?.phase !== 'sprint' || ui.busy) return;
  snapshot();
  if (!G.buzz(game, pid)) { undoStack.pop(); return; }
  stopSprint();
  saveGame();
  render();
  await stopMusic();
  render();
}

function doSprintLock() {
  if (game?.phase !== 'buzzed') return;
  act(() => G.sprintLock(game));
  afterSprint();
}

function doSprintBuy(pid) {
  if (!G.canSprintBuy(game, pid)) return;
  act(() => G.sprintBuy(game, pid));
  afterSprint();
}

function giveUp() {
  if (game?.phase === 'guess') { act(() => G.revealAuction(game)); return; }
  if (game?.phase !== 'sprint' && game?.phase !== 'buzzed') return;
  act(() => G.sprintGiveUp(game));
  afterSprint();
}

// Year auction: reveal on its own once everyone has a year in.
function guessFor(pid, year) {
  if (game?.phase !== 'guess') return false;
  snapshot();
  if (!G.guessYear(game, pid, year)) { undoStack.pop(); return false; }
  if (!G.pendingGuessers(game).length) G.revealAuction(game);
  saveGame();
  render();
  return true;
}

// ---------- game flow ----------

function snapshot() {
  undoStack.push(JSON.stringify(game));
  if (undoStack.length > 25) undoStack.shift();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) { toast(t('Nothing to undo')); return; }
  game = JSON.parse(prev);
  ui.challenger = null;
  stopSprint();
  saveGame();
  toast(t('Undone'));
  if (game.phase === 'sprint') runSprint();
}

function preflight() {
  if (!sp) { toast(t('Connect Spotify first (top of the page).')); return false; }
  if (!sp.loggedIn) { toast('Log in to Spotify first.'); return false; }
  if (!setup.players.length) { toast(t('Add at least one player.')); return false; }
  if (setup.players.some((p) => !p.name.trim())) { toast(t('Every player needs a name.')); return false; }
  if (setup.settings.war && !G.generationTeams(setup.players)) { toast(t('Generation war needs a birth year for every player, and two generations at least 10 years apart.'), 7000); return false; }
  const pool = G.buildPool(setup.packs, library, setup.settings, {});
  if (pool.length < setup.players.length * (setup.settings.target + 2)) {
    toast(t('Only {n} songs in your packs: add a few more so nobody runs dry.', { n: pool.length }));
    return pool.length > setup.players.length * 2;
  }
  return true;
}

async function startGame() {
  // Chips picked but never added as a pack: use that selection instead of refusing to start.
  if (!setup.packs.some((p) => !p.off)) {
    await addPack();
    if (!setup.packs.some((p) => !p.off)) return;
  }
  if (!preflight()) return;
  sp.activate();
  game = G.newGame(setup);
  undoStack = [];
  ui.view = 'game';
  ui.busy = t('Dealing a starting card to everyone…');
  render();
  try {
    for (let i = 0; i < game.players.length; i++) G.dealStarter(game, i, await drawFor(i));
    game.phase = 'draw';
    saveGame();
    await beginTurn();
  } catch (e) {
    ui.busy = '';
    toast(explain(e), 8000);
    render();
  }
}

async function beginTurn() {
  ui.busy = t('Finding a record…');
  ui.challenger = null;
  render();
  try {
    const card = await drawFor(game.current);
    G.startTurn(game, card);
    game.turn.pos = startPosition(card);
    ui.busy = '';
    ui.started = card.k;
    saveGame();
    render();
    if (game.phase === 'sprint') runSprint();
    else await playCard(card, game.turn.pos);
  } catch (e) {
    ui.busy = '';
    toast(explain(e), 8000);
    render();
  }
}

async function skipSong() {
  if (!G.canSkip(game)) return;
  snapshot();
  ui.busy = t('Spinning another one…');
  render();
  try {
    const card = await drawFor(game.current); // the current card is already in game.used
    stopSprint();
    G.skip(game, card);
    game.turn.pos = startPosition(card);
    ui.busy = '';
    ui.started = card.k;
    saveGame();
    render();
    if (game.phase === 'sprint') runSprint();
    else await playCard(card, game.turn.pos);
  } catch (e) {
    game = JSON.parse(undoStack.pop());
    ui.busy = '';
    toast(explain(e));
  }
}

function act(fn) {
  snapshot();
  fn();
  saveGame();
  render();
}

async function nextTurn() {
  stopSprint();
  act(() => G.nextTurn(game));
  if (game.phase === 'over') { await stopMusic(); render(); return; }
  await beginTurn();
}

// ---------- setup actions ----------

function addPlayer() {
  const used = setup.players.map((p) => p.color);
  const color = G.COLORS.find((c) => !used.includes(c)) || G.COLORS[setup.players.length % G.COLORS.length];
  setup.players.push({ id: uid(), name: '', born: '', color });
  saveSetup();
  render();
  const inputs = $app.querySelectorAll('.player-row input[data-field="name"]');
  inputs[inputs.length - 1]?.focus();
}

function builderCount() {
  const b = ui.builder;
  if (b.other.trim()) return null;
  return G.packSongs({ src: 'lib', genres: b.genres, decades: b.decades }, library, setup.settings).length;
}

async function addPack() {
  const b = ui.builder;
  const other = b.other.trim();
  const pack = other
    ? { id: uid(), src: 'spotify', genre: other, decades: b.decades.slice().sort(), owner: b.owner }
    : { id: uid(), src: 'lib', genres: G.packGenreIds({ genres: b.genres }), decades: b.decades.slice().sort(), owner: b.owner };
  if (setup.packs.some((p) => p.src === pack.src && G.packLabel(p).toLowerCase() === G.packLabel(pack).toLowerCase() && p.owner === pack.owner)) {
    toast(t('That pack is already in the list.'));
    return;
  }
  if (pack.src === 'spotify') {
    if (!sp?.loggedIn) { toast(t('Log in to Spotify to search other genres.')); return; }
    await loadSearchPack(pack);
    if (!pack.songs.length) { toast(t('Spotify had nothing for "{genre}" in those years. Try another spelling (e.g. "eurodance", "swedish pop", "grunge").', { genre: other }), 7000); return; }
  }
  setup.packs.push(pack);
  b.other = '';
  saveSetup();
  render();
}

async function loadSearchPack(pack) {
  const decades = pack.decades.length ? pack.decades : G.DECADES;
  const songs = [];
  const seen = new Set();
  // "eurodance, grunge" searches each genre.
  for (const g of pack.genre.replace(/"/g, '').split(',').map((x) => x.trim()).filter(Boolean)) for (const d of decades) {
    const range = `${d}-${Math.min(d + 9, new Date().getFullYear())}`;
    let q = `genre:"${g}" year:${range}`;
    for (let page = 0; page < 6; page++) {
      ui.busy = t('Searching Spotify for {genre} from the {decade}… {n} songs', { genre: g, decade: decade(d), n: songs.length });
      render();
      let items;
      try { items = await sp.searchTracks(q, { offset: page * 10 }); } catch (e) { toast(explain(e)); break; }
      if (!items.length && page === 0 && q.startsWith('genre:')) { q = `${g} year:${range}`; page = -1; continue; }
      for (const s of G.songsFromTracks(items, { decades: [d] })) if (!seen.has(s.k)) { seen.add(s.k); songs.push(s); }
      if (items.length < 10) break;
    }
  }
  ui.busy = '';
  pack.songs = songs;
}

async function reloadPack(id) {
  const pack = setup.packs.find((p) => p.id === id);
  if (!pack || pack.src !== 'spotify') return;
  if (!sp?.loggedIn) { toast('Log in to Spotify first.'); return; }
  await loadSearchPack(pack);
  saveSetup();
  render();
}

async function openPlaylists() {
  if (!sp?.loggedIn) { toast('Log in to Spotify first.'); return; }
  ui.busy = t('Fetching your playlists…');
  render();
  try {
    const lists = await sp.myPlaylists();
    ui.modal = { type: 'playlists', lists };
  } catch (e) { toast(explain(e)); }
  ui.busy = '';
  render();
}

async function addPlaylist(id) {
  const pl = ui.modal?.lists?.find((l) => l.id === id);
  ui.modal = null;
  ui.busy = t('Reading {name}…', { name: pl?.name || t('playlist') });
  render();
  try {
    const tracks = await sp.playlistTracks(id);
    const songs = G.songsFromTracks(tracks, { src: 'playlist' });
    if (!songs.length) toast(t('Spotify returned no songs: only playlists you made (or collaborate on) can be read.'), 7000);
    else {
      setup.packs.push({ id: uid(), src: 'playlist', genre: pl?.name || 'Playlist', name: pl?.name, playlistId: id, decades: [], owner: ui.builder.owner, songs });
      saveSetup();
    }
  } catch (e) { toast(explain(e)); }
  ui.busy = '';
  render();
}

function addEras() {
  let added = 0;
  for (const p of setup.players) {
    const decades = G.formativeDecades(p.born);
    if (!decades.length) continue;
    if (setup.packs.some((x) => x.src === 'lib' && x.genre === 'all' && x.owner === p.id)) continue;
    setup.packs.push({ id: uid(), src: 'lib', genre: 'all', decades, owner: p.id });
    added++;
  }
  saveSetup();
  toast(added === 1 ? t('Added 1 "growing up" pack. Edit or remove it if you like.') : added ? t('Added {n} "growing up" packs. Edit or remove any of them.', { n: added }) : t('Fill in birth years first (or they already have one).'));
}

async function copySetupLink() {
  const url = `${location.origin}/#s=${G.encodeSetup(setup)}`;
  try { await navigator.clipboard.writeText(url); toast(t('Setup link copied: open it on another device to get the same players, packs and rules.')); }
  catch { ui.modal = { type: 'link', url }; render(); }
}

// ---------- rooms: host ----------

const roomUrl = (code) => `${location.origin}/${code}?l=${lang}`; // ?l: phones start in this screen's language
const saveRoom = () => store.set('nd.room', hostRoom);

async function openRoom() {
  ui.busy = t('Opening a room…');
  render();
  try {
    const r = await createRoom();
    hostRoom = { code: r.code, hostKey: r.hostKey, members: {} };
    saveRoom();
    connectHost();
    ui.modal = { type: 'room' };
  } catch (e) { toast(t(e.message)); }
  ui.busy = '';
  render();
}

function connectHost() {
  role = 'host';
  link?.close();
  room.lastSent = '';
  link = new RoomLink(hostRoom.code, hostRoom.hostKey, {
    onEvent: onHostEvent,
    onStatus: async (s) => {
      room.status = s;
      if (s === 'gone') {
        // The server restarted or the room expired: bring it back with the same code and seats.
        try {
          await createRoom({ code: hostRoom.code, hostKey: hostRoom.hostKey, members: Object.values(hostRoom.members) });
          link?.open();
        } catch (e) {
          if (e.status === 409) { forgetRoom(); toast(t('The room code was taken while you were away. Open a new room.'), 7000); }
          else setTimeout(() => link?.open(), 5000);
        }
      }
      render();
    },
  });
  link.open();
}

function addRemotePlayer(m) {
  if (setup.players.some((p) => p.remote === m.pid)) return false;
  const used = setup.players.map((p) => p.color);
  const color = G.COLORS.find((c) => !used.includes(c)) || G.COLORS[setup.players.length % G.COLORS.length];
  setup.players.push({ id: uid(), name: m.name, born: m.born || '', color, remote: m.pid });
  saveSetup();
  return true;
}

function onHostEvent(ev) {
  switch (ev.type) {
    case 'hello':
      room.online = ev.online || [];
      for (const m of ev.members || []) { hostRoom.members[m.pid] = m; addRemotePlayer(m); }
      saveRoom();
      room.lastSent = ''; // (re)connected: send the full state again
      break;
    case 'join':
      hostRoom.members[ev.member.pid] = ev.member;
      saveRoom();
      if (addRemotePlayer(ev.member)) toast(t('{name} joined on their phone.', { name: ev.member.name }));
      break;
    case 'profile': {
      if (hostRoom.members[ev.pid]) Object.assign(hostRoom.members[ev.pid], { name: ev.name, born: ev.born });
      saveRoom();
      const p = setup.players.find((x) => x.remote === ev.pid);
      if (p) { p.name = ev.name; p.born = ev.born; saveSetup(); }
      const gp = game?.players.find((x) => x.remote === ev.pid);
      if (gp) { gp.name = ev.name; saveGame(); }
      break;
    }
    case 'leave': {
      const m = hostRoom.members[ev.pid];
      delete hostRoom.members[ev.pid];
      saveRoom();
      setup.players = setup.players.filter((p) => p.remote !== ev.pid);
      saveSetup();
      if (m) toast(t('{name} left the room.', { name: m.name }));
      break;
    }
    case 'presence': room.online = ev.online || []; break;
    case 'act': onRemoteAct(ev.pid, ev.act); return;
    default: return;
  }
  render();
}

// A move from a player's phone. Only their own moves count, and only when the game is at that step.
function onRemoteAct(pid, m) {
  if (!game || !m || typeof m.a !== 'string' || ui.busy || game.phase === 'over') return;
  const p = game.players.find((x) => x.remote === pid);
  if (!p) return;
  if (G.allPlay(game)) { onRemoteAllPlay(p, m); return; }
  const active = G.activePlayer(game).id === p.id;
  const turn = game.turn;
  switch (m.a) {
    case 'draw': if (active && game.phase === 'draw') beginTurn(); return;
    case 'play': if (active && turn) togglePlay(); return;
    case 'replay': if (active && turn) replay(); return;
    case 'skip': if (active) skipSong(); return;
    case 'buy': if (active && G.canBuy(game)) act(() => G.buy(game)); return;
    case 'slot': {
      const slot = Number(m.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot > G.activePlayer(game).timeline.length) return;
      if (game.phase === 'listen' && active) act(() => G.chooseSlot(game, slot));
      else if (game.phase === 'challenge' && !active) {
        snapshot();
        G.removeChallenge(game, p.id);
        if (!G.addChallenge(game, p.id, slot)) game = JSON.parse(undoStack.pop());
        saveGame(); render(); autoReveal();
      }
      return;
    }
    case 'unchallenge': if (game.phase === 'challenge') act(() => G.removeChallenge(game, p.id)); return;
    case 'pass': if (!active && game.phase === 'challenge') { act(() => G.passChallenge(game, p.id)); autoReveal(); } return;
    case 'lock': if (active && game.phase === 'listen') { act(() => G.lockIn(game)); autoReveal(); } return;
    case 'reveal': if (active && game.phase === 'challenge' && !(roomGame() && G.pendingChallengers(game).length)) { ui.challenger = null; act(() => G.reveal(game)); } return;
    case 'named': if (active && game.phase === 'reveal') act(() => G.setNamed(game, !game.turn.named)); return;
    case 'next': if (active && game.phase === 'reveal') nextTurn(); return;
    default:
  }
}

// Year auction / Intro sprint: every song is everyone's, so any phone may start, skip or move on.
function onRemoteAllPlay(p, m) {
  const turn = game.turn;
  switch (m.a) {
    case 'draw': if (game.phase === 'draw') beginTurn(); return;
    case 'play': if (turn) togglePlay(); return;
    case 'replay': if (turn) replay(); return;
    case 'skip': if (G.canSkip(game)) skipSong(); return;
    case 'next': if (game.phase === 'reveal') nextTurn(); return;
    case 'guess': guessFor(p.id, m.year); return;
    case 'revealGuesses': if (game.phase === 'guess' && Object.keys(turn.guesses).length) giveUp(); return;
    case 'buzz': doBuzz(p.id); return;
    case 'sbuy': doSprintBuy(p.id); return;
    case 'slot': {
      const slot = Number(m.slot);
      if (game.phase !== 'buzzed' || turn.buzz !== p.id || !Number.isInteger(slot) || slot < 0 || slot > p.timeline.length) return;
      act(() => G.chooseSlot(game, slot));
      return;
    }
    case 'lock': if (game.phase === 'buzzed' && turn.buzz === p.id) doSprintLock(); return;
    default:
  }
}

// What the phones see. The song stays hidden until the reveal; the deck and history stay on this device.
function roomState() {
  let g = null;
  if (game) {
    const { used, log, ...rest } = game;
    g = rest.turn && rest.phase !== 'reveal' ? { ...rest, turn: { ...rest.turn, card: null } } : rest;
    // Auction years stay secret until the reveal: phones only learn who has guessed.
    if (g.turn && g.phase === 'guess') g.turn.guesses = Object.fromEntries(Object.keys(g.turn.guesses || {}).map((k) => [k, true]));
  }
  const s = setup.settings;
  return {
    players: setup.players.map(({ id, name, color, remote: r }) => ({ id, name, color, remote: r || null })),
    settings: { target: s.target, startTokens: s.startTokens, challenges: s.challenges, nameBonus: s.nameBonus, equalTurns: s.equalTurns, mode: s.mode, war: s.war },
    packs: setup.packs.filter((p) => !p.off).map(({ songs, ...p }) => p),
    game: g, playing: !!ui.playing, busy: !!(ui.busy && game), lang, sprint: { on: sprint.on, gap: sprint.gap },
  };
}

function syncRoom() {
  if (role !== 'host' || !link) return;
  const s = JSON.stringify(roomState());
  if (s === room.lastSent) return;
  room.lastSent = s;
  link.pushState(JSON.parse(s));
}

function forgetRoom() {
  link?.close();
  link = null;
  hostRoom = null;
  localStorage.removeItem('nd.room');
  role = 'local';
  room.online = [];
  // Players who joined by phone stay in the game, played from this screen from now on.
  for (const p of setup.players) delete p.remote;
  saveSetup();
  if (game) { for (const p of game.players) delete p.remote; saveGame(); }
}

async function closeRoom() {
  if (!confirm(t('Close the room? Everyone on their phone is disconnected; their players stay in the game on this screen.'))) return;
  try { await link?.post('close'); } catch { /* gone already */ }
  forgetRoom();
  ui.modal = null;
  render();
}

// ---------- rooms: guest ----------

async function joinGo() {
  const code = ($app.querySelector('#joinCode')?.value || '').trim().toUpperCase();
  const name = ($app.querySelector('#joinName')?.value || '').trim();
  const born = ($app.querySelector('#joinBorn')?.value || '').replace(/\D/g, '');
  if (!/^[A-Z]{4}$/.test(code)) { toast(t('The room code is four letters.')); return; }
  if (!name) { toast(t('Type your name first.')); return; }
  store.set('nd.myName', { name, born });
  ui.busy = t('Joining…');
  render();
  try {
    const r = await joinRoom(code, name, born);
    if (role === 'host') { link?.close(); link = null; }
    guestSeat = { code, pid: r.pid, key: r.key, name, born };
    store.set('nd.guest', guestSeat);
    connectGuest();
  } catch (e) {
    toast(e.status === 404 ? t('No room with that code. Check the letters on the host screen.') : t(e.message));
  }
  ui.busy = '';
  render();
}

function connectGuest() {
  role = 'guest';
  remote = null;
  game = null;
  ui.view = 'guest';
  ui.modal = null;
  link?.close();
  link = new RoomLink(guestSeat.code, guestSeat.key, {
    onEvent: onGuestEvent,
    onStatus: (s, info) => {
      room.status = s;
      if (s === 'gone') { endGuest(info?.room ? t('You are no longer in that room.') : t('That room is closed.')); return; }
      render();
    },
  });
  link.open();
  if (location.pathname !== '/' + guestSeat.code) history.replaceState(null, '', '/' + guestSeat.code);
}

function myPlayerId() {
  if (role !== 'guest' || !remote || !guestSeat) return null;
  const mine = (p) => p.remote === guestSeat.pid;
  return (remote.game?.players.find(mine) || remote.players.find(mine))?.id || null;
}

// Room games: whoever's move it is has the controls. A phone plays only its own player; the host screen plays the
// players at the table, plus anyone whose phone isn't connected right now (so a dead phone never stalls the game).
const roomGame = () => !!game?.players.some((p) => p.remote);
const hostMayPlay = (p) => !!p && (!p.remote || !room.online.includes(p.remote));
const mayAct = (playerId) => role === 'guest'
  ? !!playerId && playerId === myPlayerId()
  : !game || hostMayPlay(game.players.find((x) => x.id === playerId));

// Room games wait until everyone who could challenge has said yes or no, then reveal on their own.
function autoReveal() {
  if (role === 'guest' || !game || game.phase !== 'challenge' || !roomGame()) return;
  if (G.pendingChallengers(game).length) return;
  ui.challenger = null;
  G.reveal(game);
  saveGame();
  render();
}

function onGuestEvent(ev) {
  switch (ev.type) {
    case 'hello': room.hostOnline = !!ev.host; break;
    case 'host': room.hostOnline = !!ev.online; break;
    case 'state': {
      const before = remote?.game;
      remote = ev.state || null;
      game = remote?.game || null;
      if (followLang(remote?.lang)) document.title = t(TITLE);
      ui.playing = !!remote?.playing;
      if (game?.phase !== 'challenge') ui.challenger = null;
      // Buzz when it becomes this phone's turn.
      const me = myPlayerId();
      const mineNow = game && me && G.activePlayer(game)?.id === me && (game.phase === 'listen' || game.phase === 'draw');
      const mineBefore = before && me && before.players[before.current]?.id === me && (before.phase === 'listen' || before.phase === 'draw') && before.round === game?.round;
      if (mineNow && !mineBefore) navigator.vibrate?.([120, 60, 120]);
      const askNow = game && me && G.pendingChallengers(game).some((x) => x.id === me);
      const askBefore = before && me && before.phase === 'challenge' && before.round === game?.round && before.current === game?.current;
      if (askNow && !askBefore) navigator.vibrate?.([80, 40, 80, 40, 80]);
      // All-play modes: buzz every phone when a new song starts.
      const songNow = game && G.allPlay(game) && (game.phase === 'guess' || game.phase === 'sprint');
      if (songNow && before && before.phase !== game.phase && (before.phase === 'draw' || before.phase === 'reveal')) navigator.vibrate?.(90);
      if (game?.phase !== 'guess') ui.lastGuess = null;
      break;
    }
    case 'kicked': endGuest(t('The host removed you from the room.')); return;
    case 'closed': endGuest(t('The host closed the room.')); return;
    default: return;
  }
  render();
}

function endGuest(msg) {
  link?.close();
  link = null;
  guestSeat = null;
  remote = null;
  localStorage.removeItem('nd.guest');
  role = 'local';
  game = store.get('nd.game', null); // this device's own game, untouched while it was a guest
  undoStack = store.get('nd.undo', []);
  ui.view = 'setup';
  ui.challenger = null;
  history.replaceState(null, '', '/');
  startSpotify();
  if (msg) toast(msg, 7000); else render();
}

async function leaveRoom() {
  if (!confirm(t('Leave the room?'))) return;
  try { await link?.post('leave'); } catch { /* host side cleans up anyway */ }
  endGuest('');
}

async function saveProfile() {
  const name = ($app.querySelector('#meName')?.value || '').trim();
  const born = ($app.querySelector('#meBorn')?.value || '').replace(/\D/g, '');
  if (!name) { toast(t('Type your name first.')); return; }
  try {
    await link.post('profile', { name, born });
    Object.assign(guestSeat, { name, born });
    store.set('nd.guest', guestSeat);
    store.set('nd.myName', { name, born });
    toast(t('Saved'));
  } catch (e) { toast(t(e.message)); }
}

function sendAct(a, extra = {}) {
  if (!link) return;
  link.post('act', { act: { a, ...extra } }).catch((e) => toast(t(e.message)));
}

// ---------- rendering ----------

function render() {
  let html;
  if (ui.view === 'join') html = renderJoin();
  else if (role === 'guest') html = remote?.game ? renderGame() : renderLobby();
  else html = ui.view === 'game' && game ? renderGame() : renderSetup();
  const busy = ui.busy || (role === 'guest' && remote?.busy ? t('Finding a record…') : '');
  const kept = {};
  for (const el of $app.querySelectorAll('input[data-keep]')) kept[el.dataset.keep] = el.value;
  const focus = document.activeElement?.dataset?.keep;
  $app.innerHTML = html + renderModal() + (ui.toast ? `<div class="toast" role="status">${esc(ui.toast)}</div>` : '') +
    (busy ? `<div class="busy"><div class="busy-disc"></div><p>${esc(busy)}</p></div>` : '');
  for (const el of $app.querySelectorAll('input[data-keep]')) if (kept[el.dataset.keep] && !el.value) el.value = kept[el.dataset.keep];
  if (focus) $app.querySelector(`input[data-keep="${focus}"]`)?.focus();
  const sel = $app.querySelector('.gap.selected, .card.new');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  syncRoom();
}

function hostBanner() {
  if (role !== 'guest') return '';
  if (room.status === 'retry') return `<div class="netnote">${t('Reconnecting…')}</div>`;
  if (!room.hostOnline) return `<div class="netnote">${t('The host screen is offline. Waiting for it to come back…')}</div>`;
  return '';
}

function roomChip() {
  if (role !== 'host' || !hostRoom) return '';
  const n = room.online.length;
  return `<button class="btn ghost small roomchip ${room.status === 'retry' ? 'warn' : ''}" data-action="roomModal" title="${t('Room: let more people join')}">
    <span class="rc-code">${esc(hostRoom.code)}</span><span class="rc-n">📱 ${n}</span></button>`;
}

function roomPanel() {
  if (role === 'guest') return '';
  if (role !== 'host' || !hostRoom) {
    return `<section class="panel room">
      <h2>${t('Everyone on their own phone')}</h2>
      <p>${t('Optional. Open a room and everyone joins from their phone with a code: they see the game and place their own cards. The music still plays from this device.')}</p>
      <div class="inline"><button class="btn ghost" data-action="openRoom">${t('Open a room')}</button></div>
    </section>`;
  }
  const url = roomUrl(hostRoom.code);
  const phones = setup.players.filter((p) => p.remote).length;
  return `<section class="panel room open">
    <div class="head"><h2>${t('Room')}</h2><span class="meta">${room.status === 'retry' ? t('reconnecting…') : t('{n} on phones · {online} online', { n: phones, online: room.online.length })}</span></div>
    <div class="room-box">
      <div class="qr">${qrSvg(url)}</div>
      <div class="room-side">
        <span class="room-code">${esc(hostRoom.code)}</span>
        <code class="copy" data-action="copy" data-text="${esc(url)}">${esc(url.replace(/^https?:\/\//, ''))}</code>
        <p class="hint">${t('Scan or open the link and type a name. Everyone who joins shows up under Players. Playing from this screen too? Add yourself there.')}</p>
        <div class="inline"><button class="btn ghost small" data-action="roomModal">${t('Show big')}</button><button class="btn ghost small" data-action="closeRoom">${t('Close room')}</button></div>
      </div>
    </div>
  </section>`;
}

function renderJoin() {
  const saved = store.get('nd.myName', { name: '', born: '' });
  return `<div class="join">
    <header class="top">${logo()}${langSwitch()}</header>
    <section class="panel join-card">
      <h1>${t('Join a game')}</h1>
      <p class="lead">${t('Play along on your own phone. The music plays on the host screen.')}</p>
      <label class="field">${t('Room code')}<input id="joinCode" value="${esc(ui.joinCode || '')}" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD" class="code-in"></label>
      <label class="field">${t('Your name')}<input id="joinName" value="${esc(saved.name)}" maxlength="18" autocomplete="nickname"></label>
      <label class="field">${t('Born (optional)')}<input id="joinBorn" value="${esc(saved.born)}" inputmode="numeric" maxlength="4" placeholder="${t('e.g. 1990')}"><small class="hint">${t('Helps the host pick songs from your era.')}</small></label>
      <div class="inline"><button class="btn big" data-action="joinGo">${t('Join')}</button>${pathCode ? '' : `<button class="btn ghost" data-action="joinCancel">${t('Back')}</button>`}</div>
    </section>
  </div>`;
}

function renderLobby() {
  if (!remote) {
    return `<div class="guest"><header class="gtop">${logo(true)}<div class="gmenu">${langSwitch()}<button class="btn ghost small" data-action="leave">${t('Leave')}</button></div></header>
      ${hostBanner()}<main class="lobby"><div class="busy-disc"></div><p class="lead">${t('Connecting to room {code}…', { code: esc(guestSeat?.code || '') })}</p></main></div>`;
  }
  const me = remote.players.find((p) => p.remote === guestSeat.pid);
  const s = remote.settings;
  const color = me?.color || 'var(--hot)';
  const rules = [
    t('Mode: {mode}', { mode: t(MODE_LABEL[s.mode] || MODE_LABEL.classic) }),
    ...(s.war ? [t('Generation war: teams by birth year')] : []),
    t('First to {n} cards wins', { n: s.target }),
    s.startTokens === 1 ? t('Everyone starts with 1 token') : t('Everyone starts with {n} tokens', { n: s.startTokens }),
    ...((s.mode || 'classic') === 'classic' ? [s.challenges ? t('Challenges on') : t('Challenges off'), s.nameBonus ? t('Name it for a token: on') : t('Name it for a token: off')] : []),
  ];
  const owner = (id) => remote.players.find((p) => p.id === id);
  return `<div class="guest">
    <header class="gtop">${logo(true)}<span class="meta">${t('Room {code}', { code: esc(guestSeat.code) })}</span>
      <div class="gmenu">${langSwitch()}<button class="btn ghost small" data-action="leave">${t('Leave')}</button></div></header>
    ${hostBanner()}
    <main class="lobby">
      <p class="eyebrow" style="--pc:${color}">${t("You're in")}</p>
      <h1 class="who" style="--pc:${color}">${esc(me?.name || guestSeat.name)}</h1>
      <p class="lead">${t('Waiting for the host to start the game. Songs play from the host; you place your own cards here.')}</p>
      <section class="panel">
        <h2>${t('Players')}</h2>
        <div class="roster">${remote.players.map((p) => `<span class="pchip ${p.remote === guestSeat.pid ? 'me' : ''}" style="--pc:${p.color}">${esc(p.name || t('Unnamed'))}${p.remote ? ' <i class="ph" title="' + t('on a phone') + '">📱</i>' : ''}</span>`).join('')}</div>
      </section>
      <section class="panel">
        <h2>${t('Rules')}</h2>
        <ul class="rules-list">${rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        ${remote.packs.length ? `<h3>${t('Songs')}</h3><ul class="rules-list">${remote.packs.map((p) => `<li>${esc(packName(p))}${p.owner && p.owner !== 'all' && owner(p.owner) ? ` <span class="owner" style="--oc:${owner(p.owner).color}">${esc(owner(p.owner).name)}</span>` : ''}</li>`).join('')}</ul>` : ''}
      </section>
      <section class="panel">
        <h2>${t('You')}</h2>
        <div class="inline wrap"><input id="meName" value="${esc(me?.name || guestSeat.name)}" maxlength="18" placeholder="${t('Your name')}">
          <input id="meBorn" value="${esc(guestSeat.born || '')}" inputmode="numeric" maxlength="4" placeholder="${t('Born')}" class="born">
          <button class="btn ghost" data-action="saveProfile">${t('Save')}</button></div>
      </section>
    </main>
  </div>`;
}

function logo(small) {
  return `<div class="logo ${small ? 'small' : ''}"><span class="logo-disc"></span><span>Needle<b>drop</b></span></div>`;
}

// Translator alias for functions where `t` is the current turn.
const tr = t;
const TITLE = 'Needledrop: guess the year';

// Pack names in the current language (game.js builds the English one, which also serves as the duplicate check key).
const packName = (p) => G.packLabel(p, t, decade);

function langSwitch() {
  const next = lang === 'sv' ? 'EN' : 'SV';
  return `<button class="btn ghost small lang" data-action="lang" title="${lang === 'sv' ? 'Switch to English' : 'Byt till svenska'}" aria-label="${t('Language')}: ${next}">${next}</button>`;
}

function spotifyPanel() {
  if (!sp) {
    return `<section class="panel spotify-setup">
      <h2>${t('Connect Spotify')}</h2>
      <p>${t('Songs play through Spotify (Premium) on this device. Spotify needs a free app key once:')}</p>
      <ol>
        <li>${t('Open {link} and log in.', { link: '<a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>' })}</li>
        <li>${t('<b>Create app</b>: any name, tick <b>Web API</b> and <b>Web Playback SDK</b>, and add this Redirect URI:')}
          <code class="copy" data-action="copy" data-text="${esc(REDIRECT)}">${esc(REDIRECT)}</code></li>
        <li>${t("Paste the app's <b>Client ID</b> here:")}</li>
      </ol>
      <div class="inline"><input id="clientId" placeholder="Client ID" autocomplete="off" spellcheck="false"><button class="btn" data-action="saveClient">${t('Save')}</button></div>
    </section>`;
  }
  if (!sp.loggedIn) {
    return `<section class="panel spotify-setup compact">
      <h2>Spotify</h2>
      <p>${t('Log in with the Premium account that should play the music.')}</p>
      <div class="inline"><button class="btn spotify" data-action="login">${t('Log in with Spotify')}</button>
      <button class="btn ghost small" data-action="forgetClient">${t('Change app key')}</button></div>
    </section>`;
  }
  const state = t({ off: 'starting…', loading: 'starting…', ready: 'ready', error: 'error' }[sp.playerState]);
  const opts = [`<option value="browser" ${setup.device === 'browser' ? 'selected' : ''}>${t('This browser ({state})', { state })}</option>`]
    .concat(ui.devices.filter((d) => d.name !== 'Needledrop').map((d) => `<option value="${esc(d.id)}" ${setup.device === d.id ? 'selected' : ''}>${esc(d.name)} (${esc(d.type)})</option>`));
  if (setup.device !== 'browser' && !ui.devices.some((d) => d.id === setup.device)) opts.push(`<option value="${esc(setup.device)}" selected>${t('Saved device (not seen right now)')}</option>`);
  return `<section class="panel spotify-setup compact">
    <h2>Spotify</h2>
    <p class="ok">${ui.me?.display_name ? t('Logged in as {name}.', { name: `<b>${esc(ui.me.display_name)}</b>` }) : t('Logged in.')}</p>
    <label class="field">${t('Play on')}
      <span class="inline"><select data-action="device">${opts.join('')}</select>
      <button class="btn ghost small" data-action="devices" title="${t('Look for Spotify apps on this network')}">↻</button></span>
    </label>
    ${sp.playerState === 'error' && setup.device === 'browser' ? `<p class="warn">${esc(sp.playerError)} ${t('You can also open the Spotify app on this laptop and pick it above.')}</p>` : ''}
    <p class="hint">${esc(t('Tip: "This browser" hides the song best. If you pick the Spotify app, keep its window out of sight.'))}</p>
    <div class="inline"><button class="btn ghost small" data-action="logout">${t('Log out')}</button></div>
  </section>`;
}

function renderSetup() {
  const s = setup.settings;
  const players = setup.players.map((p, i) => `
    <div class="player-row" style="--pc:${p.color}">
      <button class="swatch" data-action="color" data-id="${p.id}" title="${t('Change colour')}"></button>
      <input data-field="name" data-id="${p.id}" value="${esc(p.name)}" placeholder="${t('Player {n}', { n: i + 1 })}" maxlength="18">
      ${p.remote ? `<span class="phone ${room.online.includes(p.remote) ? 'on' : ''}" title="${room.online.includes(p.remote) ? t('On their phone (connected)') : t('On their phone (not connected right now)')}">📱</span>` : ''}
      <input data-field="born" data-id="${p.id}" value="${esc(p.born)}" placeholder="${t('Born')}" inputmode="numeric" maxlength="4" class="born">
      <span class="order"><button class="icon" data-action="moveUp" data-id="${p.id}" title="${t('Move up')}" ${i ? '' : 'disabled'}>▲</button><button class="icon" data-action="moveDown" data-id="${p.id}" title="${t('Move down')}" ${i < setup.players.length - 1 ? '' : 'disabled'}>▼</button></span>
      <button class="btn ghost small" data-action="era" data-id="${p.id}" title="${t('Pick songs from the years they grew up')}">${t('Their era')}</button>
      <button class="icon" data-action="removePlayer" data-id="${p.id}" title="${t('Remove')}">✕</button>
    </div>`).join('');

  const owners = [{ id: 'all', name: t('Everyone') }].concat(setup.players.map((p) => ({ id: p.id, name: p.name || t('Unnamed') })));
  const ownerName = (id) => owners.find((o) => o.id === id)?.name || t('Everyone');
  const ownerColor = (id) => setup.players.find((p) => p.id === id)?.color || 'var(--dim)';

  const packs = setup.packs.map((p) => {
    const n = G.packSongs(p, library, s).length;
    return `<div class="pack ${p.off ? 'off' : ''}">
      <button class="toggle ${p.off ? '' : 'on'}" data-action="togglePack" data-id="${p.id}" title="${p.off ? t('Turn on') : t('Turn off')}"></button>
      <div class="pack-main"><b>${esc(packName(p))}</b>
        <span class="meta">${t('{n} songs', { n })} · <span class="owner" style="--oc:${ownerColor(p.owner)}">${esc(ownerName(p.owner))}</span>${p.src === 'spotify' ? t(' · from Spotify search') : ''}</span></div>
      ${p.src === 'spotify' ? `<button class="icon" data-action="reloadPack" data-id="${p.id}" title="${t('Search again')}">↻</button>` : ''}
      <button class="icon" data-action="removePack" data-id="${p.id}" title="${t('Remove')}">✕</button>
    </div>`;
  }).join('') || `<p class="empty">${t("No song packs yet. Pick genres and years below and press the orange <b>Add</b> button (or just <b>Start the game</b> to use what's picked).")}</p>`;

  const b = ui.builder;
  const count = builderCount();
  const gOn = G.packGenreIds({ genres: b.genres });
  const genreChips = G.GENRES.map((g) => `<button class="chip ${!b.other && gOn.includes(g.id) ? 'on' : ''}" data-action="genre" data-id="${g.id}">${esc(t(g.label))}</button>`).join('');
  const decadeChips = G.DECADES.map((d) => `<button class="chip ${b.decades.includes(d) ? 'on' : ''}" data-action="decade" data-id="${d}">${decade(d)}</button>`).join('');
  const preview = packName({ src: b.other.trim() ? 'spotify' : 'lib', genre: b.other.trim(), genres: b.genres, decades: b.decades });
  const pool = G.buildPool(setup.packs, library, s, {}).length;

  const inGame = game && game.phase !== 'over';
  return `<div class="setup">
    <header class="top">${logo()}<p class="tag">${t('The song plays, you guess the year. One laptop, the whole table.')}</p>
      <span class="top-right"><button class="btn ghost small" data-action="joinOpen" title="${t('Someone else is hosting? Join their game on this device.')}">${t('Join a game')}</button>${langSwitch()}</span></header>
    <div class="setup-grid">
      <div class="col">
        ${spotifyPanel()}
        ${roomPanel()}
        <section class="panel">
          <h2>${t('Players')}</h2>
          ${players ? `<p class="hint">${t('The top player starts. Use ▲ ▼ to change the order.')}</p>${players}` : `<p class="empty">${t("Add everyone who plays. Birth years are optional: they help pick songs from each person's era.")}</p>`}
          <div class="inline"><button class="btn ghost" data-action="addPlayer">${t('+ Add player')}</button></div>
        </section>
        <section class="panel rules">
          <h2>${t('Rules')}</h2>
          <label class="field row switch-row"><span><b>${t('Cards to win')}</b><small>${t('First to this many cards on their timeline wins.')}</small></span><input type="number" min="3" max="30" data-setting="target" value="${s.target}"></label>
          <div class="field modes-field"><b>${t('Game mode')}</b>
            <div class="modes" role="radiogroup">${G.MODES.map((m) => `<button class="mode ${s.mode === m ? 'on' : ''}" role="radio" aria-checked="${s.mode === m}" data-action="mode" data-id="${m}">${t(MODE_LABEL[m])}</button>`).join('')}</div>
            <small>${esc(t(MODE_HINT[s.mode] || MODE_HINT.classic))}</small></div>
          ${switchRow('war', 'Generation war', 'Two teams split by birth year. Each team gets songs from when the other team grew up. Team score = everyone\'s cards together.')}
          ${s.war ? warPreview() : ''}
          <label class="field row switch-row"><span><b>${t('Starting tokens')}</b><small>${t('Coins everyone starts with. Spend 1 to skip a song or challenge, 3 to buy a card. Name artist + title to earn more (max 5).')}</small></span><input type="number" min="0" max="5" data-setting="startTokens" value="${s.startTokens}"></label>
          ${s.mode === 'classic' ? `${switchRow('equalTurns', 'Equal turns', 'When someone reaches the target, the players after them in the order still get their turn. Most cards wins (tie: most tokens).')}
          ${switchRow('challenges', 'Challenges', 'Others can spend a token to bet on a different spot and steal the card.')}
          ${switchRow('nameBonus', 'Name it for a token', 'Say the artist and title out loud: +1 token if you get both, and another turn if the card is in the right spot too.')}` : ''}
          ${switchRow('ownTaste', 'Everyone gets their own music', 'Songs for each player come from their own packs (plus "Everyone" packs).')}
          ${switchRow('noExtreme', 'Leave out extreme metal', 'Skips death, black and similar metal.', s.exclude.includes('extreme'))}
          <label class="field row">${t('Songs start')} <select data-setting="startAt">
            <option value="start" ${s.startAt === 'start' ? 'selected' : ''}>${t('from the beginning')}</option>
            <option value="30" ${s.startAt === '30' ? 'selected' : ''}>${t('30 seconds in')}</option>
            <option value="random" ${s.startAt === 'random' ? 'selected' : ''}>${t('somewhere in the middle')}</option></select></label>
        </section>
      </div>
      <div class="col">
        <section class="panel songs">
          <div class="head"><h2>${t('Songs')}</h2><span class="meta">${t('{n} songs in the deck', { n: pool })}</span></div>
          <div class="packs">${packs}</div>
          <div class="builder">
            <div class="brow"><span class="lbl">${t('Genres')}</span><div class="chips">${genreChips}</div></div>
            <div class="brow"><span class="lbl"></span><input class="other" data-field="other" value="${esc(b.other)}" placeholder="${t('…or other genres, comma-separated: eurodance, grunge, k-pop (searches Spotify)')}"></div>
            <div class="brow"><span class="lbl">${t('Years')}</span><div class="chips">${decadeChips}<button class="chip ${b.decades.length ? '' : 'on'}" data-action="decade" data-id="all">${t('All years')}</button></div></div>
            <div class="brow"><span class="lbl">${t('For')}</span><div class="chips">${owners.map((o) => `<button class="chip ${b.owner === o.id ? 'on' : ''}" data-action="owner" data-id="${o.id}">${esc(o.name)}</button>`).join('')}</div></div>
            <div class="inline wrap">
              <button class="btn" data-action="addPack">${t('Add {pack}', { pack: esc(preview) })}${count != null ? ` <span class="count">${count}</span>` : ''}</button>
              <button class="btn ghost" data-action="eras" title="${t('One pack per player with every genre from the years they were 8–28')}">${t("Add everyone's era")}</button>
              <button class="btn ghost" data-action="playlists">${t('From a playlist')}</button>
            </div>
          </div>
        </section>
        <div class="start">
          ${inGame ? `<button class="btn big" data-action="resume">${t('Back to the game')}</button><button class="btn ghost" data-action="start">${t('New game')}</button>` : `<button class="btn big" data-action="start">${t('Start the game')}</button>`}
          <button class="btn ghost small" data-action="share">${t('Copy setup link')}</button>
        </div>
      </div>
    </div>
    <footer>Needledrop · <a href="https://github.com/Tjabooo/needledrop" target="_blank" rel="noopener">${t('source')}</a> · ${t('keys: space play/pause, ← → move, enter confirm, U undo')}</footer>
  </div>`;
}

// Generation war preview under the switch: who's on which team and which years they get.
function warPreview() {
  const teams = G.generationTeams(setup.players);
  if (!teams) return `<p class="warn war-note">${t('Needs a birth year for every player, and two generations at least 10 years apart.')}</p>`;
  const nameOf = (id) => esc(setup.players.find((p) => p.id === id)?.name || t('Unnamed'));
  const range = (ds) => (ds.length ? (ds.length === 1 ? decade(ds[0]) : `${decade(ds[0])}–${decade(ds[ds.length - 1])}`) : t('all years'));
  return `<div class="war-teams">${teams.map((tm, i) => `<div class="war-team" style="--tc:${tm.color}">
    <b>${esc(teamName(tm))}</b><span>${tm.members.map(nameOf).join(', ')}</span>
    <small>${t('gets songs from the {range}', { range: range(teams[1 - i].decades) })}</small></div>`).join('')}</div>`;
}

function switchRow(key, label, hint, on) {
  const value = on ?? setup.settings[key];
  return `<div class="field row switch-row"><span><b>${t(label)}</b><small>${esc(t(hint))}</small></span>
    <button class="toggle ${value ? 'on' : ''}" data-action="setting" data-id="${key}" aria-pressed="${value}"></button></div>`;
}

function coins(n, max) {
  let out = '';
  for (let i = 0; i < Math.max(n, max); i++) out += `<i class="${i < n ? 'full' : ''}"></i>`;
  return `<span class="coins" title="${n === 1 ? t('1 token') : t('{n} tokens', { n })}">${out}</span>`;
}

function scoreboard() {
  const me = myPlayerId();
  const all = G.allPlay(game);
  const hot = (p, i) => game.phase !== 'over' && (all ? game.turn?.buzz === p.id : i === game.current);
  const team = (p) => game.teams?.find((tm) => tm.id === p.team);
  return teamsBar() + game.players.map((p, i) => `
    <div class="score ${hot(p, i) ? 'active' : ''} ${p.id === me ? 'me' : ''} ${all && game.turn?.out?.includes(p.id) ? 'out' : ''}" style="--pc:${p.color}">
      <span class="sname">${team(p) ? `<i class="tdot" style="--tc:${team(p).color}"></i>` : ''}${esc(p.name)}${p.id === me ? ` <small class="you">${t('you')}</small>` : ''}</span>
      <span class="snum"><b>${p.timeline.length}</b>/${game.settings.target}</span>
      ${coins(p.tokens, game.settings.maxTokens)}
      <span class="bar"><span style="width:${Math.min(100, (p.timeline.length / game.settings.target) * 100)}%"></span></span>
    </div>`).join('');
}

// Generation war: a team is named after its birth years.
function teamName(tm) {
  if (tm.from === tm.to) return t('Born {y}', { y: tm.from });
  const to = Math.floor(tm.from / 100) === Math.floor(tm.to / 100) ? String(tm.to).slice(2) : tm.to;
  return t('Born {a}–{b}', { a: tm.from, b: to });
}

function teamsBar() {
  if (!game.teams) return '';
  return `<div class="teams">${G.scoreSides(game).map((s) => `<div class="team" style="--tc:${s.team.color}">
    <b>${esc(teamName(s.team))}</b><span class="snum"><b>${s.cards}</b>/${s.target}</span>
    <span class="bar"><span style="width:${Math.min(100, (s.cards / s.target) * 100)}%"></span></span></div>`).join('')}</div>`;
}

const MODE_LABEL = { classic: 'Classic', auction: 'Year auction', sprint: 'Intro sprint' };
const MODE_HINT = {
  classic: 'Take turns placing your own song on your timeline. Tokens, challenges, the works.',
  auction: 'Everyone hears the same song and types a year. Closest gets the card, the exact year earns a token too.',
  sprint: 'The song plays in growing clips (2, 4, 7, 12, 20 s). Buzz in and place it on your timeline: faster = more tokens, a wrong spot locks you out for that song.',
};

function cardHtml(c, cls = '') {
  return `<div class="card ${cls}" style="--cc:${yearColor(c.y)}">
    <span class="cyear">${c.y}</span>
    <span class="cartist">${esc(c.a)}</span>
    <span class="ctitle">${esc(c.t)}</span>
  </div>`;
}

// mode: place (pick a gap) · challenge · watch (someone else is placing: their pick shows, nothing is clickable) · reveal · view
function timelineHtml(p, mode) {
  const t = game.turn;
  const parts = [];
  const tl = p.timeline;
  const res = t?.result;
  for (let i = 0; i <= tl.length; i++) {
    if (mode === 'place' || mode === 'challenge') {
      const mine = t.slot === i;
      const ch = t.challengers.find((c) => c.slot === i);
      const chp = ch && game.players.find((x) => x.id === ch.player);
      const can = mode === 'place' || (ui.challenger && !mine && (!ch || ch.player === ui.challenger));
      parts.push(`<button class="gap ${mine ? 'selected' : ''} ${ch ? 'claimed' : ''} ${can ? '' : 'locked'}" data-action="slot" data-slot="${i}" ${can ? '' : 'tabindex="-1"'}
        style="${chp ? `--chc:${chp.color}` : ''}">
        ${mine ? `<span class="mystery" style="--pc:${p.color}">?</span>` : ''}
        ${chp ? `<span class="flag">${esc(chp.name)}</span>` : ''}
        ${!mine && !chp ? '<span class="plus">+</span>' : ''}
      </button>`);
    } else if (mode === 'watch') {
      parts.push(t?.slot === i ? `<div class="gap selected"><span class="mystery" style="--pc:${p.color}">?</span></div>` : '<div class="gap static"></div>');
    } else if (mode === 'reveal' && res && !res.correct && t.slot === i && !t.bought) {
      parts.push(`<div class="gap ghost-wrong"><span class="mystery wrong">✕</span></div>`);
    } else {
      parts.push('<div class="gap static"></div>');
    }
    if (i < tl.length) {
      const c = tl[i];
      const isNew = mode === 'reveal' && t?.card?.k === c.k;
      parts.push(cardHtml(c, isNew ? 'new' : ''));
    }
  }
  return `<div class="timeline">${parts.join('')}</div>`;
}

function vinyl(p, showArt) {
  const card = game.turn?.card;
  const art = showArt && card?.img ? `style="background-image:url('${esc(card.img)}')"` : '';
  return `<div class="deck">
    <div class="platter ${ui.playing ? 'spin' : ''}">
      <div class="record"><div class="grooves"></div><div class="label ${art ? 'art' : ''}" style="--pc:${p.color}" ${art}></div></div>
    </div>
    <div class="tonearm ${ui.playing ? 'down' : ''}"></div>
  </div>`;
}

function gameMenu() {
  if (role === 'guest') {
    return `<div class="gmenu">
      <button class="btn ghost small" data-action="timelines" title="${tr("Everyone's timelines")}">${tr('Timelines')}</button>${langSwitch()}
      <button class="btn ghost small" data-action="leave">${tr('Leave')}</button></div>`;
  }
  return `<div class="gmenu">${roomChip()}
    <button class="btn ghost small" data-action="timelines" title="${tr("Everyone's timelines")}">${tr('Timelines')}</button>
    <button class="btn ghost small" data-action="undo" ${undoStack.length ? '' : 'disabled'} title="${tr('Undo (U)')}">${tr('Undo')}</button>
    <button class="btn ghost small" data-action="setup">${tr('Setup')}</button>${langSwitch()}
  </div>`;
}

function renderGame() {
  const p = G.activePlayer(game);
  const t = game.turn;
  const mine = mayAct(p.id); // this screen may play the active player's turn
  const me = myPlayerId();
  const guest = role === 'guest';
  const waiting = (s) => `<p class="waiting">${s}</p>`;
  let stage = '';
  let tlMode = 'view';

  if (game.phase === 'over') return renderOver();
  if (G.allPlay(game)) return renderAllPlay();

  if (game.phase === 'deal' || game.phase === 'draw' || !t) {
    stage = `<div class="stage-center">
      <p class="eyebrow" style="--pc:${p.color}">${tr('Up next')}</p>
      <h1 class="who" style="--pc:${p.color}">${esc(p.name)}</h1>
      ${lastRoundNote()}
      ${mine ? `<button class="btn big" data-action="draw">${guest ? tr('Play my song') : tr('Play {poss} song', { poss: esc(poss(p.name)) })}</button>`
        : waiting(tr('Waiting for {name} to start their song…', { name: esc(p.name) }))}
    </div>`;
  } else if (game.phase === 'listen' && mine) {
    tlMode = 'place';
    stage = `<div class="stage-split">
      ${vinyl(p, false)}
      <div class="stage-side">
        <p class="eyebrow" style="--pc:${p.color}">${guest ? tr('Your turn') : tr('{poss} turn', { poss: esc(poss(p.name)) })}</p>
        <h1>${tr('When was this released?')}</h1>
        <p class="lead">${game.settings.nameBonus ? tr('Pick the gap on your timeline where this song fits, and say the artist and title out loud for a bonus token.') : tr('Pick the gap on your timeline where this song fits.')}</p>
        <div class="controls">
          <button class="btn round" data-action="play" title="${tr('Play/pause (space)')}">${ui.playing ? '❚❚' : '▶'}</button>
          <button class="btn ghost" data-action="replay" title="${tr('From the start')}">${tr('⟲ Restart')}</button>
          <button class="btn ghost" data-action="skip" ${G.canSkip(game) ? '' : 'disabled'} title="${tr('Costs 1 token')}">${tr('Skip song')} <span class="cost">1</span></button>
          <button class="btn ghost" data-action="buy" ${G.canBuy(game) ? '' : 'disabled'} title="${tr('Costs 3 tokens: the card is placed for you')}">${tr('Buy card')} <span class="cost">3</span></button>
        </div>
        <button class="btn big lock" data-action="lock" ${t.slot == null ? 'disabled' : ''}>${t.slot == null ? tr('Pick a gap first') : tr('Lock it in')}</button>
      </div>
    </div>`;
  } else if (game.phase === 'listen') {
    tlMode = 'watch';
    const mePlayer = game.players.find((x) => x.id === me);
    stage = `<div class="stage-split">
      ${vinyl(p, false)}
      <div class="stage-side">
        <p class="eyebrow" style="--pc:${p.color}">${tr('{poss} turn', { poss: esc(poss(p.name)) })}</p>
        <h1>${tr('{name} is guessing', { name: esc(p.name) })}</h1>
        <p class="lead">${tr('Their pick shows up on their timeline below.')}${game.settings.challenges && mePlayer?.tokens ? ' ' + tr('Think they are wrong? You can challenge once they lock it in.') : ''}</p>
      </div>
    </div>`;
  } else if (game.phase === 'challenge' && roomGame()) {
    // Room games: everyone who could challenge gets a yes/no popup, and the song is revealed once they all answered.
    tlMode = 'challenge';
    const pending = G.pendingChallengers(game);
    const names = (list) => list.map((x) => `<b style="color:${x.color}">${esc(x.name)}</b>`).join(', ');
    const picker = ui.challenger && game.players.find((x) => x.id === ui.challenger);
    const status = game.players.filter((x) => x.id !== p.id).map((o) => {
      const c = t.challengers.find((x) => x.player === o.id);
      const state = c ? 'challenging' : (t.passed || []).includes(o.id) ? 'passed' : pending.includes(o) ? 'deciding…' : 'no tokens';
      const cancel = c && mayAct(o.id) && pending.length;
      return `<${cancel ? 'button' : 'div'} class="chal ${c ? 'placed' : ''} ${pending.includes(o) ? 'deciding' : ''}" style="--pc:${o.color}" ${cancel ? `data-action="challenger" data-id="${o.id}"` : ''}>
        <b>${esc(o.name)}</b> ${coins(o.tokens, 0)}<small>${tr(cancel ? 'challenging · tap to cancel' : state)}</small></${cancel ? 'button' : 'div'}>`;
    }).join('');
    stage = `<div class="stage-split">
      ${vinyl(p, false)}
      <div class="stage-side">
        <p class="eyebrow" style="--pc:${p.color}">${tr('Challenge?')}</p>
        ${picker ? `<h1>${tr('Pick a gap')}</h1><p class="lead">${tr('{name}: tap the gap on {poss} timeline where you think the song goes.', { name: `<b style="color:${picker.color}">${esc(picker.name)}</b>`, poss: esc(poss(p.name)) })}</p>
          <div class="inline"><button class="btn ghost" data-action="chBack">${tr('Back')}</button></div>`
        : `<h1>${guest && me === p.id ? tr('Locked in') : tr('{name} locked in', { name: esc(p.name) })}</h1>
          <div class="challengers">${status}</div>
          ${pending.length ? waiting(tr('Waiting for {names} to decide…', { names: names(pending) })) : ''}`}
      </div>
    </div>`;
  } else if (game.phase === 'challenge') {
    tlMode = 'challenge';
    let others = game.players.filter((x) => x.id !== p.id);
    if (guest) others = others.filter((o) => o.id === me);
    const activeHere = guest && me === p.id;
    stage = `<div class="stage-split">
      ${vinyl(p, false)}
      <div class="stage-side">
        <p class="eyebrow" style="--pc:${p.color}">${tr('Challenge?')}</p>
        ${activeHere ? `<h1>${tr('Locked in')}</h1><p class="lead">${tr('The others can challenge your pick now. Reveal the song when they are done.')}</p>
          ${t.challengers.length ? `<p class="lead">${t.challengers.map((c) => { const cp = game.players.find((x) => x.id === c.player); return `<b style="color:${cp.color}">${esc(cp.name)}</b>`; }).join(', ')} ${tr('challenged.')}</p>` : ''}`
        : `<h1>${tr('Think {name} got it wrong?', { name: esc(p.name) })}</h1>
        <p class="lead">${tr('Spend a token and pick a different gap. If {name} is wrong and you are right, the card is yours.', { name: esc(p.name) })}</p>`}
        ${others.length ? `<div class="challengers">
          ${others.map((o) => {
            const c = t.challengers.find((x) => x.player === o.id);
            const active = ui.challenger === o.id;
            return `<button class="chal ${active ? 'on' : ''} ${c ? 'placed' : ''}" style="--pc:${o.color}" data-action="challenger" data-id="${o.id}" ${!c && o.tokens < 1 ? 'disabled' : ''}>
              <b>${esc(o.name)}</b> ${coins(o.tokens, 0)}<small>${tr(c ? 'challenging · tap to cancel' : active ? 'now click a gap' : o.tokens < 1 ? 'no tokens' : 'challenge')}</small></button>`;
          }).join('')}
        </div>` : ''}
        ${mine ? `<button class="btn big lock" data-action="reveal">${tr('Reveal the song')}</button>` : waiting(tr('Waiting for {name} to reveal…', { name: esc(p.name) }))}
      </div>
    </div>`;
  } else if (game.phase === 'reveal') {
    tlMode = 'reveal';
    const r = t.result;
    const winner = r.winner && game.players.find((x) => x.id === r.winner);
    let verdict;
    if (r.bought) verdict = `<span class="good">${tr('{name} bought it.', { name: esc(p.name) })}</span>`;
    else if (r.correct) verdict = `<span class="good">${tr('Right! {name} keeps the card.', { name: esc(p.name) })}</span>`;
    else if (winner) verdict = `<span class="steal" style="--pc:${winner.color}">${tr('Wrong spot. {name} steals it!', { name: esc(winner.name) })}</span>`;
    else verdict = `<span class="bad">${tr('Wrong spot. The card is out.')}</span>`;
    const next = game.winner ? tr('See who won') : G.goesAgain(game) ? tr('{name} goes again', { name: esc(p.name) }) : tr('Next: {name}', { name: esc(game.players[(game.current + 1) % game.players.length].name) });
    const named = game.settings.nameBonus && !r.bought
      ? (mine ? `<button class="named ${t.named ? 'on' : ''}" data-action="named">
          <span class="box">${t.named ? '✓' : ''}</span><span>${tr('{name} named the artist <i>and</i> the title', { name: esc(p.name) })}${r.correct ? `<small>${tr('Right spot too: another turn')}</small>` : ''}</span><span class="cost">+1</span></button>`
        : t.named ? `<p class="lead">${tr('{name} named the artist and the title: +1 token.', { name: esc(p.name) })}</p>` : '')
      : '';
    stage = `<div class="stage-split">
      ${vinyl(p, true)}
      <div class="stage-side reveal">
        <div class="big-card" style="--cc:${yearColor(t.card.y)}">
          <span class="cyear">${t.card.y}</span>
          <span class="ctitle">${esc(t.card.t)}</span>
          <span class="cartist">${esc(t.card.a)}</span>
        </div>
        <p class="verdict">${verdict}</p>
        ${named}
        ${mine ? `<div class="inline wrap"><button class="btn big" data-action="next">${next} →</button>
        <button class="btn ghost" data-action="play">${tr(ui.playing ? '❚❚ Pause' : '▶ Keep listening')}</button></div>`
          : waiting(tr('Waiting for {name} to move on…', { name: esc(p.name) }))}
      </div>
    </div>`;
  }

  const spectator = guest && !me ? `<div class="netnote">${tr('You joined during this game: you are watching, and you play in the next one.')}</div>` : '';
  const myTl = guest && me && me !== p.id ? (() => {
    const mp = game.players.find((x) => x.id === me);
    return `<section class="tl-wrap mine" style="--pc:${mp.color}"><div class="tl-head">${tr('Your timeline')} <span class="meta">${mp.timeline.length === 1 ? tr('1 card') : tr('{n} cards', { n: mp.timeline.length })}</span></div>${timelineHtml(mp, 'view')}</section>`;
  })() : '';

  // The challenge question for whoever on this screen still has to answer it. It can't be dismissed: answer to go on.
  let ask = '';
  if (game.phase === 'challenge' && roomGame() && !ui.challenger) {
    const q = G.pendingChallengers(game).find((x) => mayAct(x.id));
    if (q) {
      const away = !guest && q.remote;
      ask = `<div class="decide-bg"><div class="modal decide" style="--pc:${q.color}" role="dialog" aria-modal="true">
        <p class="eyebrow" style="--pc:${q.color}">${guest ? tr('Your call') : tr('{name}, your call', { name: esc(q.name) })}</p>
        <h2>${tr('Challenge {poss} pick?', { poss: esc(poss(p.name)) })}</h2>
        ${away ? `<p class="hint">${tr("{poss} phone isn't connected, so answer here.", { poss: esc(poss(q.name)) })}</p>` : ''}
        <div class="tl-wrap" style="--pc:${p.color}">${timelineHtml(p, 'watch')}</div>
        <p class="hint">${tr('Spend a token and pick a different gap. If {name} is wrong and you are right, the card is yours.', { name: esc(p.name) })} ${coins(q.tokens, 0)}</p>
        <div class="inline wrap">
          <button class="btn big" data-action="chYes" data-id="${q.id}">${tr('Challenge')} <span class="cost">1</span></button>
          <button class="btn ghost big" data-action="chPass" data-id="${q.id}">${tr('Let it ride')}</button>
        </div></div></div>`;
    }
  }

  return `<div class="game ${guest ? 'is-guest' : ''}">
    <header class="gtop">${logo(true)}<div class="scores">${scoreboard()}</div>${gameMenu()}</header>
    ${hostBanner()}${spectator}${ask}
    <main class="stage">${stage}</main>
    <section class="tl-wrap" style="--pc:${p.color}">
      <div class="tl-head">${guest && me === p.id ? tr('Your timeline') : tr('{who} timeline', { who: `<b>${esc(poss(p.name))}</b>` })} <span class="meta">${p.timeline.length === 1 ? tr('1 card') : tr('{n} cards', { n: p.timeline.length })}${tlMode === 'challenge' && ui.challenger ? ` · ${tr('{name} is picking a gap', { name: esc(game.players.find((x) => x.id === ui.challenger).name) })}` : ''}</span></div>
      ${timelineHtml(p, tlMode)}
    </section>
    ${myTl}
  </div>`;
}

// Year auction and Intro sprint: one song for everyone, no turns of their own.
function renderAllPlay() {
  const t = game.turn;
  const me = myPlayerId();
  const guest = role === 'guest';
  const mode = game.settings.mode;
  const mePlayer = game.players.find((x) => x.id === me);
  const pl = (id) => game.players.find((x) => x.id === id);
  const nameB = (x) => `<b style="color:${x.color}">${esc(x.name)}</b>`;
  const waiting = (s) => `<p class="waiting">${s}</p>`;
  const songN = (game.songNo || 0) + 1;
  const eyebrow = `<p class="eyebrow" style="--pc:var(--gold)">${tr(MODE_LABEL[mode])} · ${tr('song {n}', { n: songN })}</p>`;
  const sprintNow = guest ? remote?.sprint || {} : sprint;
  // The song controls belong to the host screen (the music plays there); phones can start and skip too.
  const controls = () => `<div class="controls">
      <button class="btn round" data-action="play" title="${tr('Play/pause (space)')}">${(mode === 'sprint' ? sprintNow.on : ui.playing) ? '❚❚' : '▶'}</button>
      <button class="btn ghost" data-action="replay" title="${tr('From the start')}">${mode === 'sprint' ? tr('⟲ Clip again') : tr('⟲ Restart')}</button>
      <button class="btn ghost" data-action="skip" ${G.canSkip(game) ? '' : 'disabled'} title="${tr('Unknown or wrong song? Skipping is free in this mode.')}">${tr('Skip song')}</button>
    </div>`;
  let stage = '';
  // Which timelines show under the stage: a phone sees its own, the host screen everyone's (for thinking).
  let focus = null;
  let tlMode = 'view';

  if (game.phase === 'draw' || game.phase === 'deal' || !t) {
    stage = `<div class="stage-center">
      ${eyebrow}
      <h1 class="who" style="--pc:var(--gold)">${tr('Everyone plays')}</h1>
      <p class="lead">${tr(MODE_HINT[mode])}</p>
      ${game.teams ? `<p class="hint">${tr('Generation war: the songs take turns between the two eras.')}</p>` : ''}
      ${guest && !me ? waiting(tr('Waiting for the next song…')) : `<button class="btn big" data-action="draw">${tr('Play a song')}</button>`}
    </div>`;
  } else if (game.phase === 'guess') {
    const pending = G.pendingGuessers(game);
    let entry = '';
    if (guest && mePlayer) {
      entry = t.guesses[me] ? `<p class="locked-guess">${tr('Locked in: {y}', { y: `<b>${esc(ui.lastGuess || '✓')}</b>` })} <button class="btn ghost small" data-action="reguess">${tr('Change')}</button></p>`
        : `<div class="guess-me"><input class="guess-in" data-keep="guess-me" id="guess-${me}" type="number" inputmode="numeric" min="1900" max="2100" placeholder="${tr('Year')}" autocomplete="off">
          <button class="btn big" data-action="guess" data-id="${me}">${tr('Lock it in')}</button></div>`;
    } else if (!guest) {
      entry = `<div class="guess-rows">${game.players.map((x) => {
        const done = x.id in t.guesses;
        const here = hostMayPlay(x);
        const right = done ? `<span class="gstate ok">${tr('locked ✓')}</span>`
          : here ? `<input class="guess-in" data-keep="guess-${x.id}" id="guess-${x.id}" type="password" inputmode="numeric" maxlength="4" placeholder="${tr('Year')}" autocomplete="off"><button class="btn small" data-action="guess" data-id="${x.id}">${tr('Lock')}</button>`
            : `<span class="gstate">${tr('guessing on their phone…')}</span>`;
        return `<div class="guess-row" style="--pc:${x.color}"><b>${esc(x.name)}</b>${right}</div>`;
      }).join('')}</div>`;
    }
    const someIn = Object.keys(t.guesses).length;
    const others = pending.filter((x) => x.id !== me); // a phone doesn't wait for itself
    stage = `<div class="stage-split">
      ${vinyl({ color: 'var(--gold)' }, false)}
      <div class="stage-side">
        ${eyebrow}
        <h1>${tr('What year is this?')}</h1>
        <p class="lead">${tr('Type a year. Closest gets the card, the exact year earns a token too.')}</p>
        ${guest ? '' : controls()}
        ${entry}
        ${others.length && someIn ? waiting(tr('Waiting for {names}…', { names: others.map(nameB).join(', ') })) : ''}
        ${someIn && pending.length && !guest ? `<button class="btn ghost small" data-action="revealGuesses">${tr('Reveal now')}</button>` : ''}
      </div>
    </div>`;
    focus = guest ? mePlayer : null;
  } else if (game.phase === 'sprint') {
    const lvl = t.level;
    const pills = G.SPRINT_CLIPS.map((sec, i) => `<span class="clip ${i < lvl ? 'done' : i === lvl ? 'now' : ''}"><b>${sec}s</b><small>+${G.sprintBonus(i)}</small></span>`).join('')
      + `<span class="clip ${lvl >= G.SPRINT_CLIPS.length ? 'now' : ''}"><b>∞</b><small>+0</small></span>`;
    const status = !sprintNow.on ? tr('Paused')
      : lvl >= G.SPRINT_CLIPS.length ? tr('Full song')
        : sprintNow.gap ? tr('Next clip coming…') : tr('Clip {n}: {s} seconds', { n: lvl + 1, s: G.SPRINT_CLIPS[lvl] });
    const wrong = t.lastWrong && pl(t.lastWrong);
    const outNote = t.out.length ? `<p class="hint">${tr('Out for this song: {names}', { names: t.out.map((id) => nameB(pl(id))).join(', ') })}</p>` : '';
    let buzzers = '';
    if (guest && mePlayer) {
      buzzers = t.out.includes(me) ? `<p class="lead">${tr("You're out for this song.")}</p>`
        : `<button class="btn buzz-big" data-action="buzz" data-id="${me}" style="--pc:${mePlayer.color}">${tr('BUZZ')}</button>
          ${G.canSprintBuy(game, me) ? `<button class="btn ghost small" data-action="sbuy" data-id="${me}">${tr('Buy it')} <span class="cost">3</span></button>` : ''}`;
    } else if (!guest) {
      buzzers = `<div class="buzzers">${game.players.map((x, i) => {
        if (!hostMayPlay(x)) return `<div class="buzz phone" style="--pc:${x.color}"><b>${esc(x.name)}</b><small>${t.out.includes(x.id) ? tr('out') : tr('on their phone')}</small></div>`;
        const out = t.out.includes(x.id);
        return `<button class="buzz ${out ? 'out' : ''}" data-action="buzz" data-id="${x.id}" style="--pc:${x.color}" ${out ? 'disabled' : ''}>
          <b>${esc(x.name)}</b><small>${out ? tr('out') : i < 9 ? tr('key {k}', { k: i + 1 }) : ''}</small></button>`;
      }).join('')}</div>`;
    }
    stage = `<div class="stage-split">
      ${vinyl({ color: 'var(--hot)' }, false)}
      <div class="stage-side">
        ${eyebrow}
        <h1>${status}</h1>
        <div class="clips">${pills}</div>
        ${wrong ? `<p class="lead">${tr('{name} missed it. Still open for everyone else.', { name: nameB(wrong) })}</p>` : `<p class="lead">${tr('Know where it goes on your timeline? Buzz in. The sooner, the more tokens.')}</p>`}
        ${buzzers}
        ${outNote}
        ${guest ? '' : `${controls()}<button class="btn ghost small" data-action="giveUp">${tr('Nobody knows: reveal it')}</button>`}
      </div>
    </div>`;
    focus = guest ? mePlayer : null;
  } else if (game.phase === 'buzzed') {
    const b = pl(t.buzz);
    const mine = mayAct(b.id);
    focus = b;
    tlMode = mine ? 'place' : 'watch';
    stage = `<div class="stage-split">
      ${vinyl(b, false)}
      <div class="stage-side">
        <p class="eyebrow" style="--pc:${b.color}">${guest && me === b.id ? tr('You buzzed!') : tr('{name} buzzed!', { name: esc(b.name) })}</p>
        <h1>${mine ? tr('Where does it go?') : tr('{name} is placing it', { name: esc(b.name) })}</h1>
        <p class="lead">${tr('Right gap: the card, +{n} tokens. Wrong gap: out for this song.', { n: G.sprintBonus(t.buzzLevel) })}</p>
        ${mine ? `<button class="btn big lock" data-action="lock" ${t.slot == null ? 'disabled' : ''}>${t.slot == null ? tr('Pick a gap first') : tr('Lock it in')}</button>` : waiting(tr('Waiting for {name}…', { name: nameB(b) }))}
      </div>
    </div>`;
  } else if (game.phase === 'reveal') {
    const r = t.result;
    let verdict;
    let detail = '';
    if (mode === 'auction') {
      const winners = (r.winners || []).map(pl);
      if (!winners.length) verdict = `<span class="bad">${tr('Nobody guessed. The card is out.')}</span>`;
      else if (r.best === 0) verdict = `<span class="good">${tr('Spot on! {names} get the card and a token.', { names: winners.map(nameB).join(' & ') })}</span>`;
      else verdict = `<span class="good">${tr('{names} closest, {n} off. The card is theirs.', { names: winners.map(nameB).join(' & '), n: r.best === 1 ? tr('1 year') : tr('{n} years', { n: r.best }) })}</span>`;
      const rows = Object.entries(t.guesses).map(([id, y]) => ({ p: pl(id), y, off: Math.abs(y - t.card.y) })).filter((x) => x.p).sort((a, b) => a.off - b.off);
      detail = `<ol class="guess-list">${rows.map((x) => `<li class="${r.winners.includes(x.p.id) ? 'win' : ''}" style="--pc:${x.p.color}"><b>${esc(x.p.name)}</b><span class="gy">${x.y}</span><span class="goff">${x.off ? (x.y < t.card.y ? '−' : '+') + x.off : '✓'}</span></li>`).join('')}</ol>`;
      focus = (guest && r.winners.includes(me) ? mePlayer : winners[0]) || (guest ? mePlayer : null);
    } else {
      const w = r.winner && pl(r.winner);
      if (r.bought) verdict = `<span class="good">${tr('{name} bought it.', { name: nameB(w) })}</span>`;
      else if (w) verdict = `<span class="good">${r.bonus ? tr('{name} got it! +{n} tokens.', { name: nameB(w), n: r.bonus }) : tr('{name} got it!', { name: nameB(w) })}</span>`;
      else verdict = `<span class="bad">${tr('Nobody got it. The card is out.')}</span>`;
      if (t.out.length) detail = `<p class="hint">${tr('Wrong spot: {names}', { names: t.out.map((id) => nameB(pl(id))).join(', ') })}</p>`;
      focus = w || (guest ? mePlayer : null);
    }
    if (focus) tlMode = 'reveal';
    stage = `<div class="stage-split">
      ${vinyl(focus || { color: 'var(--gold)' }, true)}
      <div class="stage-side reveal">
        <div class="big-card" style="--cc:${yearColor(t.card.y)}">
          <span class="cyear">${t.card.y}</span>
          <span class="ctitle">${esc(t.card.t)}</span>
          <span class="cartist">${esc(t.card.a)}</span>
        </div>
        <p class="verdict">${verdict}</p>
        ${detail}
        ${guest && !me ? '' : `<div class="inline wrap"><button class="btn big" data-action="next">${game.winner ? tr('See who won') : tr('Next song')} →</button>
          ${guest ? '' : `<button class="btn ghost" data-action="play">${tr(ui.playing ? '❚❚ Pause' : '▶ Keep listening')}</button>`}</div>`}
      </div>
    </div>`;
  }

  const spectator = guest && !me ? `<div class="netnote">${tr('You joined during this game: you are watching, and you play in the next one.')}</div>` : '';
  const cards = (x) => (x.timeline.length === 1 ? tr('1 card') : tr('{n} cards', { n: x.timeline.length }));
  let tls;
  if (focus) {
    tls = `<section class="tl-wrap" style="--pc:${focus.color}">
      <div class="tl-head">${guest && me === focus.id ? tr('Your timeline') : tr('{who} timeline', { who: `<b>${esc(poss(focus.name))}</b>` })} <span class="meta">${cards(focus)}</span></div>
      ${timelineHtml(focus, tlMode)}</section>`;
    if (guest && mePlayer && focus.id !== me) tls += `<section class="tl-wrap mine" style="--pc:${mePlayer.color}"><div class="tl-head">${tr('Your timeline')} <span class="meta">${cards(mePlayer)}</span></div>${timelineHtml(mePlayer, 'view')}</section>`;
  } else {
    tls = `<section class="tl-wrap all">${game.players.map((x) => `<div class="tl-head" style="--pc:${x.color}"><b>${esc(x.name)}</b> <span class="meta">${cards(x)}</span></div>${timelineHtml(x, 'view')}`).join('')}</section>`;
  }

  return `<div class="game allplay ${guest ? 'is-guest' : ''}">
    <header class="gtop">${logo(true)}<div class="scores">${scoreboard()}</div>${gameMenu()}</header>
    ${hostBanner()}${spectator}
    <main class="stage">${stage}</main>
    ${tls}
  </div>`;
}

function lastRoundNote() {
  const by = G.finalRoundBy(game);
  if (!by) return '';
  const name = by.team ? teamName(by.team) : by.players[0].name;
  const color = by.team ? by.team.color : by.players[0].color;
  return `<p class="last-round" style="--pc:${color}"><b>${tr('Last round')}</b> ${tr('{name} has {n} cards. Everyone gets as many turns before the game ends.', { name: esc(name), n: by.cards })}</p>`;
}

function renderOver() {
  const st = G.standings(game);
  const w = game.players.find((p) => p.id === game.winner) || game.players.find((p) => p.id === st[0].id);
  const tied = (game.winners || []).map((id) => game.players.find((p) => p.id === id)).filter(Boolean);
  const guest = role === 'guest';
  const sides = game.teams ? G.scoreSides(game) : null;
  const winTeams = sides ? sides.filter((s) => (game.winSides || []).includes(s.id)) : [];
  const buttons = guest ? `<p class="waiting">${t('Waiting for the host to start a new game…')}</p>`
    : `<div class="inline"><button class="btn big" data-action="again">${t('Play again')}</button><button class="btn ghost" data-action="setup">${t('Setup')}</button></div>`;
  const menu = guest ? gameMenu() : `<div class="gmenu">${roomChip()}<button class="btn ghost small" data-action="undo">${t('Undo')}</button>${langSwitch()}</div>`;
  return `<div class="game over ${guest ? 'is-guest' : ''}">
    <header class="gtop">${logo(true)}<div class="scores">${scoreboard()}</div>${menu}</header>
    ${hostBanner()}
    <main class="stage"><div class="stage-center">
      ${winTeams.length === 1 ? `<p class="eyebrow" style="--pc:${winTeams[0].team.color}">${t('Winning team')}</p>
      <h1 class="who" style="--pc:${winTeams[0].team.color}">${esc(teamName(winTeams[0].team))}</h1>
      <p class="lead">${winTeams[0].players.map((p) => `<b style="color:${p.color}">${esc(p.name)}</b>`).join(' & ')}</p>`
      : winTeams.length > 1 ? `<p class="eyebrow" style="--pc:var(--gold)">${t("It's a tie")}</p>
      <h1 class="who tie">${winTeams.map((s) => `<span style="color:${s.team.color}">${esc(teamName(s.team))}</span>`).join(' & ')}</h1>`
      : tied.length > 1 ? `<p class="eyebrow" style="--pc:${w.color}">${t("It's a tie")}</p>
      <h1 class="who tie">${tied.map((p) => `<span style="color:${p.color}">${esc(p.name)}</span>`).join(' & ')}</h1>`
      : `<p class="eyebrow" style="--pc:${w.color}">${t('Winner')}</p>
      <h1 class="who" style="--pc:${w.color}">${esc(w.name)}</h1>`}
      ${sides ? `<ol class="podium teams-podium">${sides.slice().sort((a, b) => b.cards / b.target - a.cards / a.target).map((s) => `<li style="--pc:${s.team.color}"><b>${esc(teamName(s.team))}</b><span>${t('{cards} of {target} cards', { cards: s.cards, target: s.target })}</span></li>`).join('')}</ol>` : ''}
      <ol class="podium">${st.map((s) => `<li style="--pc:${s.color}"><b>${esc(s.name)}</b><span>${t('{cards} cards · {tokens} tokens', { cards: s.cards, tokens: s.tokens })}</span></li>`).join('')}</ol>
      ${buttons}
    </div></main>
    <section class="tl-wrap all">${game.players.map((p) => `<div class="tl-head" style="--pc:${p.color}"><b>${esc(p.name)}</b></div>${timelineHtml(p, 'view')}`).join('')}</section>
  </div>`;
}

function renderModal() {
  const m = ui.modal;
  if (!m) return '';
  let body = '';
  if (m.type === 'playlists') {
    body = `<h2>${t('Pick a playlist')}</h2><p class="hint">${t("Spotify only shares playlists you made or collaborate on. Years come from each song's album.")}</p>
      <div class="plist">${m.lists.map((l) => `<button class="pl" data-action="pickPlaylist" data-id="${esc(l.id)}">
        ${l.images?.[0]?.url ? `<img src="${esc(l.images[0].url)}" alt="">` : '<span class="noimg"></span>'}<b>${esc(l.name)}</b>
        <small>${l.items?.total ?? l.tracks?.total ?? ''}</small></button>`).join('') || `<p class="empty">${t('No playlists found.')}</p>`}</div>`;
  } else if (m.type === 'timelines') {
    body = `<h2>${t("Everyone's timelines")}</h2>${game.players.map((p) => `<div class="tl-head" style="--pc:${p.color}"><b>${esc(p.name)}</b> ${coins(p.tokens, 0)}</div>${timelineHtml(p, 'view')}`).join('')}`;
  } else if (m.type === 'room' && hostRoom) {
    const url = roomUrl(hostRoom.code);
    body = `<div class="room-big"><div class="qr">${qrSvg(url)}</div><div>
      <h2>${t('Join on your phone')}</h2>
      <p class="hint">${t('Scan the code, or open {url} and type the code:', { url: `<b>${esc(location.host)}</b>` })}</p>
      <span class="room-code huge">${esc(hostRoom.code)}</span>
      <p class="hint">${t('The music keeps playing from this device.')}</p></div></div>`;
  } else if (m.type === 'link') {
    body = `<h2>${t('Setup link')}</h2><p class="hint">${t('Copy this link:')}</p><textarea readonly>${esc(m.url)}</textarea>`;
  }
  return `<div class="modal-bg" data-action="closeModal"><div class="modal" data-stop>${body}<button class="icon close" data-action="closeModal">✕</button></div></div>`;
}

// ---------- events ----------

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'closeModal' && e.target.closest('[data-stop]') && !e.target.closest('.close')) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  const player = id && setup.players.find((p) => p.id === id);
  if (role === 'guest' && game && G.allPlay(game) && ['draw', 'play', 'replay', 'skip', 'next', 'guess', 'reguess', 'revealGuesses', 'buzz', 'sbuy', 'slot', 'lock', 'giveUp'].includes(a)) {
    const me = myPlayerId();
    if (a === 'guess') {
      const v = parseInt($app.querySelector(`#guess-${me}`)?.value, 10);
      if (!(v >= 1900 && v <= 2100)) { toast(t('Type a year, like 1987.')); return; }
      ui.lastGuess = v;
      game.turn.guesses[me] = true;
      render();
      sendAct('guess', { year: v });
      return;
    }
    if (a === 'reguess') { if (game.phase === 'guess') { delete game.turn.guesses[me]; render(); } return; }
    if (a === 'buzz') { if (game.phase === 'sprint' && id === me) { navigator.vibrate?.(40); sendAct('buzz'); } return; }
    if (a === 'sbuy') { if (id === me) sendAct('sbuy'); return; }
    if (a === 'slot') {
      if (game.phase === 'buzzed' && game.turn.buzz === me) { const slot = +el.dataset.slot; game.turn.slot = slot; render(); sendAct('slot', { slot }); }
      return;
    }
    if (a === 'lock') { if (game.phase === 'buzzed' && game.turn.buzz === me) sendAct('lock'); return; }
    if (!me) return;
    sendAct(a);
    return;
  }
  if (role === 'guest' && game && ['draw', 'play', 'replay', 'skip', 'buy', 'lock', 'reveal', 'named', 'next', 'slot', 'challenger', 'chYes', 'chPass', 'chBack'].includes(a)) {
    const me = myPlayerId();
    if (a === 'chYes') { if (id === me && game.phase === 'challenge') { ui.challenger = me; render(); } return; }
    if (a === 'chBack') { ui.challenger = null; render(); return; }
    if (a === 'chPass') { if (id === me && game.phase === 'challenge') { game.turn.passed = [...(game.turn.passed || []), me]; render(); sendAct('pass'); } return; }
    if (a === 'slot') {
      const slot = +el.dataset.slot;
      if (game.phase === 'listen' && mayAct(G.activePlayer(game).id)) { game.turn.slot = slot; render(); sendAct('slot', { slot }); }
      else if (game.phase === 'challenge' && ui.challenger === me) { ui.challenger = null; render(); sendAct('slot', { slot }); }
      return;
    }
    if (a === 'challenger') {
      if (id !== me || game.phase !== 'challenge') return;
      if (game.turn.challengers.some((x) => x.player === me)) { ui.challenger = null; sendAct('unchallenge'); }
      else ui.challenger = ui.challenger ? null : me;
      render();
      return;
    }
    if (a === 'buy' && !G.canBuy(game)) return;
    sendAct(a);
    return;
  }
  if (role !== 'guest' && game && ui.view === 'game' && G.allPlay(game)) {
    // All-play modes: the host screen runs the song; players move for themselves (or for a phone that dropped).
    if (['guess', 'buzz', 'sbuy'].includes(a) && !mayAct(id)) return;
    if (['slot', 'lock'].includes(a) && !(game.phase === 'buzzed' && mayAct(game.turn.buzz))) return;
    switch (a) {
      case 'draw': sp?.activate(); return beginTurn();
      case 'guess': {
        const input = $app.querySelector(`#guess-${id}`);
        const v = parseInt(input?.value, 10);
        if (!(v >= 1900 && v <= 2100)) { toast(t('Type a year, like 1987.')); input?.focus(); return; }
        input.value = '';
        guessFor(id, v);
        $app.querySelector('.guess-rows input')?.focus(); // next player's box
        return;
      }
      case 'revealGuesses': case 'giveUp': return giveUp();
      case 'buzz': sp?.activate(); return doBuzz(id);
      case 'sbuy': return doSprintBuy(id);
      case 'slot': act(() => G.chooseSlot(game, +el.dataset.slot)); return;
      case 'lock': return doSprintLock();
      case 'buy': case 'named': case 'challenger': case 'chYes': case 'chPass': case 'reveal': return;
      default: // play, replay, skip, next, undo, menus: the shared handlers below
    }
  }
  if (role !== 'guest' && game && ui.view === 'game' && !G.allPlay(game)) {
    // Only the screen whose move it is gets to make it (see mayAct).
    const turnHere = mayAct(G.activePlayer(game).id);
    if (['draw', 'skip', 'buy', 'lock', 'named', 'next'].includes(a) && !turnHere) return;
    if (a === 'slot' && game.phase === 'listen' && !turnHere) return;
    if (a === 'slot' && game.phase === 'challenge' && ui.challenger && !mayAct(ui.challenger)) return;
    if (a === 'reveal' && (!turnHere || (roomGame() && G.pendingChallengers(game).length))) return;
    if (['challenger', 'chYes', 'chPass'].includes(a) && !mayAct(id)) return;
  }
  switch (a) {
    case 'chYes': if (game?.phase === 'challenge') { ui.challenger = id; render(); } return;
    case 'chBack': ui.challenger = null; render(); return;
    case 'chPass': act(() => G.passChallenge(game, id)); autoReveal(); return;
    case 'openRoom': return openRoom();
    case 'closeRoom': return closeRoom();
    case 'roomModal': ui.modal = { type: 'room' }; render(); return;
    case 'joinOpen': ui.view = 'join'; ui.joinCode = ''; render(); $app.querySelector('#joinCode')?.focus(); return;
    case 'joinCancel': ui.view = game && game.phase !== 'over' ? 'game' : 'setup'; render(); return;
    case 'joinGo': return joinGo();
    case 'leave': return leaveRoom();
    case 'saveProfile': return saveProfile();
    case 'saveClient': {
      const v = $app.querySelector('#clientId').value.trim();
      if (!/^[0-9a-f]{32}$/i.test(v)) { toast(t('That does not look like a Client ID (32 letters and digits).')); return; }
      store.set('nd.clientId', v);
      makeSpotify();
      render();
      return;
    }
    case 'forgetClient': store.set('nd.clientId', ''); localStorage.removeItem('nd.spotify.token'); makeSpotify(); if (config.spotifyClientId) toast(t("Using the site's default app key.")); render(); return;
    case 'login': return sp.login();
    case 'logout': sp.logout(); ui.me = null; render(); return;
    case 'devices': return refreshDevices();
    case 'copy': navigator.clipboard?.writeText(el.dataset.text).then(() => toast(t('Copied'))); return;
    case 'addPlayer': return addPlayer();
    case 'removePlayer':
      if (player?.remote && link && role === 'host') {
        if (!confirm(t('Remove {name} from the room?', { name: player.name }))) return;
        link.post('kick', { pid: player.remote }).catch(() => {});
        delete hostRoom.members[player.remote];
        saveRoom();
      }
      setup.players = setup.players.filter((p) => p.id !== id);
      setup.packs.forEach((p) => { if (p.owner === id) p.owner = 'all'; });
      if (ui.builder.owner === id) ui.builder.owner = 'all';
      saveSetup(); render(); return;
    case 'moveUp':
    case 'moveDown': {
      const i = setup.players.indexOf(player);
      const j = a === 'moveUp' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= setup.players.length) return;
      [setup.players[i], setup.players[j]] = [setup.players[j], setup.players[i]];
      saveSetup(); render(); return;
    }
    case 'color': {
      const i = G.COLORS.indexOf(player.color);
      player.color = G.COLORS[(i + 1) % G.COLORS.length];
      saveSetup(); render(); return;
    }
    case 'era': {
      const d = G.formativeDecades(player.born);
      if (!d.length) { toast(t('Type {name} birth year first.', { name: player.name || t('their') })); return; }
      Object.assign(ui.builder, { decades: d, owner: player.id });
      render();
      $app.querySelector('.builder')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(t('Years set to when {name} grew up. Pick genres and press Add.', { name: player.name || t('they') }));
      return;
    }
    case 'genre': {
      const gs = ui.builder.genres.filter((x) => x !== 'all');
      ui.builder.genres = id === 'all' ? ['all'] : gs.includes(id) ? gs.filter((x) => x !== id) : gs.concat(id);
      if (!ui.builder.genres.length) ui.builder.genres = ['all'];
      ui.builder.other = '';
      render(); return;
    }
    case 'decade': {
      if (id === 'all') ui.builder.decades = [];
      else {
        const d = +id;
        const ds = ui.builder.decades;
        ui.builder.decades = ds.includes(d) ? ds.filter((x) => x !== d) : ds.concat(d);
      }
      render(); return;
    }
    case 'owner': ui.builder.owner = id; render(); return;
    case 'addPack': return addPack();
    case 'eras': return addEras();
    case 'playlists': return openPlaylists();
    case 'pickPlaylist': return addPlaylist(id);
    case 'togglePack': { const p = setup.packs.find((x) => x.id === id); p.off = !p.off; saveSetup(); render(); return; }
    case 'removePack': setup.packs = setup.packs.filter((x) => x.id !== id); saveSetup(); render(); return;
    case 'reloadPack': return reloadPack(id);
    case 'mode': if (G.MODES.includes(id)) { setup.settings.mode = id; saveSetup(); render(); } return;
    case 'setting': {
      const s = setup.settings;
      if (id === 'noExtreme') s.exclude = s.exclude.includes('extreme') ? s.exclude.filter((x) => x !== 'extreme') : s.exclude.concat('extreme');
      else s[id] = !s[id];
      saveSetup(); render(); return;
    }
    case 'share': return copySetupLink();
    case 'start':
      if (game && game.phase !== 'over' && !confirm(t('Start over? The current game will be lost.'))) return;
      return startGame();
    case 'resume': ui.view = 'game'; render(); return;
    case 'setup': ui.view = 'setup'; refreshDevices(); render(); return;
    case 'again': await stopMusic(); return startGame();
    case 'draw': sp?.activate(); return beginTurn();
    case 'play': return togglePlay();
    case 'replay': return replay();
    case 'skip': return skipSong();
    case 'buy': act(() => G.buy(game)); return;
    case 'slot': {
      const slot = +el.dataset.slot;
      if (game.phase === 'listen') act(() => G.chooseSlot(game, slot));
      else if (game.phase === 'challenge' && ui.challenger) {
        const pid = ui.challenger;
        snapshot();
        G.removeChallenge(game, pid);
        if (G.addChallenge(game, pid, slot)) ui.challenger = null;
        else game = JSON.parse(undoStack.pop());
        saveGame(); render(); autoReveal();
      }
      return;
    }
    case 'lock': act(() => G.lockIn(game)); autoReveal(); return;
    case 'challenger': {
      const c = game.turn.challengers.find((x) => x.player === id);
      if (c) { act(() => G.removeChallenge(game, id)); ui.challenger = null; render(); return; }
      ui.challenger = ui.challenger === id ? null : id;
      render(); return;
    }
    case 'reveal': ui.challenger = null; act(() => G.reveal(game)); return;
    case 'named': act(() => G.setNamed(game, !game.turn.named)); return;
    case 'next': return nextTurn();
    case 'undo': undo(); return;
    case 'timelines': ui.modal = { type: 'timelines' }; render(); return;
    case 'closeModal': ui.modal = null; render(); return;
    case 'lang': pickLang(lang === 'sv' ? 'en' : 'sv'); document.title = t(TITLE); render(); return;
    default:
  }
});

$app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.action === 'device') { setup.device = el.value; saveSetup(); if (el.value !== 'browser') toast(t('Songs will play on that Spotify app. Keep its screen out of sight.')); return; }
  if (el.dataset.setting) {
    const k = el.dataset.setting;
    setup.settings[k] = el.type === 'number' ? Math.max(+el.min || 0, Math.min(+el.max || 99, parseInt(el.value, 10) || 0)) : el.value;
    saveSetup(); render(); return;
  }
});

$app.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.field === 'other') { ui.builder.other = el.value; const btn = $app.querySelector('[data-action="addPack"]'); if (btn) btn.textContent = t('Add {pack}', { pack: packName({ src: el.value.trim() ? 'spotify' : 'lib', genre: el.value.trim(), genres: ui.builder.genres, decades: ui.builder.decades }) }); const on = G.packGenreIds({ genres: ui.builder.genres }); $app.querySelectorAll('.chips .chip[data-action="genre"]').forEach((c) => c.classList.toggle('on', !el.value.trim() && on.includes(c.dataset.id))); return; }
  const p = el.dataset.id && setup.players.find((x) => x.id === el.dataset.id);
  if (p && el.dataset.field === 'name') { p.name = el.value; saveSetup(); }
  if (p && el.dataset.field === 'born') { p.born = el.value.replace(/\D/g, ''); saveSetup(); }
});

$app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.field === 'other') { e.preventDefault(); addPack(); }
  if (e.key === 'Enter' && ['joinCode', 'joinName', 'joinBorn'].includes(e.target.id)) { e.preventDefault(); joinGo(); }
  if (e.key === 'Enter' && ['meName', 'meBorn'].includes(e.target.id)) { e.preventDefault(); saveProfile(); }
  if (e.key === 'Enter' && e.target.classList?.contains('guess-in')) { e.preventDefault(); e.target.closest('.guess-row, .guess-me')?.querySelector('[data-action="guess"]')?.click(); }
  if (e.key === 'Enter' && e.target.id === 'clientId') { e.preventDefault(); $app.querySelector('[data-action="saveClient"]').click(); }
});

document.addEventListener('keydown', (e) => {
  if (role === 'guest') { if (e.key === 'Escape' && ui.modal) { ui.modal = null; render(); } return; }
  if (ui.view !== 'game' || !game || e.target.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (ui.busy) return;
  if (e.key === 'Escape' && ui.modal) { ui.modal = null; render(); return; }
  if (ui.modal) return;
  const t = game.turn;
  if (e.key === ' ') { e.preventDefault(); if (t) togglePlay(); return; }
  if (e.key === 'u' || e.key === 'U') { undo(); return; }
  if (G.allPlay(game)) { allPlayKey(e); return; }
  if (!mayAct(G.activePlayer(game).id)) return; // a phone player's turn: their phone has the controls
  const n = G.activePlayer(game).timeline.length;
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && game.phase === 'listen') {
    e.preventDefault();
    const cur = t.slot ?? (e.key === 'ArrowLeft' ? n + 1 : -1);
    const next = Math.max(0, Math.min(n, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
    act(() => G.chooseSlot(game, next));
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (game.phase === 'listen' && t.slot != null) { act(() => G.lockIn(game)); autoReveal(); }
    else if (game.phase === 'challenge' && !(roomGame() && G.pendingChallengers(game).length)) { ui.challenger = null; act(() => G.reveal(game)); }
    else if (game.phase === 'reveal') nextTurn();
    else if (game.phase === 'draw') beginTurn();
  }
});

// Year auction / Intro sprint keys: 1-9 buzz that player, arrows + enter place a buzzed card, enter = next song.
function allPlayKey(e) {
  const t = game.turn;
  if (game.phase === 'sprint' && /^[1-9]$/.test(e.key)) {
    const p = game.players[+e.key - 1];
    if (p && hostMayPlay(p)) { e.preventDefault(); doBuzz(p.id); }
    return;
  }
  if (game.phase === 'buzzed' && mayAct(t.buzz)) {
    const n = game.players.find((x) => x.id === t.buzz).timeline.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = t.slot ?? (e.key === 'ArrowLeft' ? n + 1 : -1);
      act(() => G.chooseSlot(game, Math.max(0, Math.min(n, cur + (e.key === 'ArrowLeft' ? -1 : 1)))));
    } else if (e.key === 'Enter' && t.slot != null) { e.preventDefault(); doSprintLock(); }
    return;
  }
  if (e.key === 'Enter') {
    if (game.phase === 'reveal') { e.preventDefault(); nextTurn(); } else if (game.phase === 'draw') { e.preventDefault(); beginTurn(); }
  }
}

// ---------- boot ----------

async function boot() {
  followLang(new URLSearchParams(location.search).get('l')); // joined from a host's QR code
  document.title = t(TITLE);
  const loading = $app.querySelector('.busy p');
  if (loading) loading.textContent = t('Loading…');
  try { config = { ...config, ...(await (await fetch('/config.json', { cache: 'no-store' })).json()) }; } catch { /* static hosting */ }
  library = G.parseLibrary(await (await fetch('songs.txt')).text());

  const m = location.hash.match(/#s=([\w-]+)/);
  if (m) {
    try {
      const shared = G.decodeSetup(m[1]);
      setup = { ...setup, players: shared.players, packs: shared.packs.map((p) => ({ ...p, songs: p.songs || [] })), settings: { ...G.DEFAULT_SETTINGS, ...shared.settings } };
      saveSetup();
      ui.view = 'setup';
      setTimeout(() => toast(t('Setup loaded from the link.') + (setup.packs.some((p) => p.src === 'spotify') ? t(' Press ↻ on Spotify search packs to fetch their songs.') : '')), 50);
    } catch { setTimeout(() => toast(t('That setup link is broken.')), 50); }
    history.replaceState(null, '', location.pathname);
  }

  if (pathCode) {
    if (guestSeat?.code === pathCode) connectGuest();
    else if (hostRoom?.code === pathCode) { history.replaceState(null, '', '/'); connectHost(); }
    else { ui.view = 'join'; ui.joinCode = pathCode; }
  } else if (guestSeat) connectGuest();
  else if (hostRoom) connectHost();

  if (role !== 'guest') await startSpotify();
  if (game && game.phase === 'listen') ui.started = null;
  render();
  if (ui.view === 'join') $app.querySelector(ui.joinCode ? '#joinName' : '#joinCode')?.focus();
}

let spotifyStarted = false;
async function startSpotify() {
  if (spotifyStarted) return;
  spotifyStarted = true;
  makeSpotify();
  if (sp) {
    const err = await sp.handleRedirect();
    if (err) setTimeout(() => toast(err, 7000), 50);
    if (sp.loggedIn) {
      sp.loadPlayer('Needledrop');
      sp.me().then((me) => { ui.me = me; render(); }).catch(() => {});
      refreshDevices();
    }
  }
}

boot();
