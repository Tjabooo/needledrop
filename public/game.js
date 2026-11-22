// Needledrop game logic: pure functions, no DOM, no network. Shared by the browser and the tests.

export const DECADES = [1960, 1970, 1980, 1990, 2000, 2010, 2020];

export const GENRES = [
  { id: 'all', label: 'Everything' },
  { id: 'rock', label: 'Rock' },
  { id: 'hardrock', label: 'Hard rock' },
  { id: 'metal', label: 'Metal' },
  { id: 'punk', label: 'Punk' },
  { id: 'alt', label: 'Alternative' },
  { id: 'indie', label: 'Indie' },
  { id: 'pop', label: 'Pop' },
  { id: 'dance', label: 'Dance & disco' },
  { id: 'soul', label: 'Soul, funk & R&B' },
  { id: 'hiphop', label: 'Hip-hop' },
  { id: 'country', label: 'Country' },
  { id: 'reggae', label: 'Reggae' },
  { id: 'swedish', label: 'Swedish' },
];

export const DEFAULT_SETTINGS = {
  target: 10, // cards on your timeline to win
  startTokens: 2,
  maxTokens: 5,
  challenges: true,
  nameBonus: true,
  ownTaste: false, // each player's songs come from their own packs (plus "everyone" packs)
  exclude: ['extreme'], // library tags never dealt
  startAt: 'start', // start | 30 | random
};

export const COLORS = ['#ff6b4a', '#4ad6c2', '#f5c044', '#8f7bff', '#ff5fa2', '#7fd46a', '#58a6ff', '#ff9f43'];

// ---------- text helpers ----------

export function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\s+-\s+.*$/, '') // "Song - Remastered 2011"
    .replace(/\((feat|with|ft)\.?[^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Title without bracketed extras, for comparing a library title with a Spotify track name.
export function coreTitle(s) {
  return norm(String(s || '').replace(/\s*[[(][^\])]*[\])]/g, ' ')) || norm(s);
}

export function songKey(artist, title) {
  return norm(artist).split(' feat ')[0] + '|' + coreTitle(title);
}

const VERSION_RE = /\b(live|remix|re-?mix|mix|edit|version|demo|acoustic|karaoke|instrumental|remaster(ed)?|mono|stereo|re-?recorded|cover|tribute|sped up|slowed|nightcore)\b/i;

// True when a Spotify track name looks like a live take, remix, remaster or similar.
export function isAltVersion(name) {
  const extras = [];
  String(name).replace(/[[(]([^\])]*)[\])]/g, (_, x) => extras.push(x));
  const dash = String(name).split(/\s+-\s+/).slice(1).join(' ');
  return [...extras, dash].some((x) => VERSION_RE.test(x));
}

// ---------- library ----------

// songs.txt: "year | artist | title | tags", # comments.
export function parseLibrary(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;
    const y = parseInt(parts[0], 10);
    if (!(y > 1900 && y < 2100)) continue;
    const tags = (parts[3] || '').split(/\s+/).filter(Boolean);
    out.push({ k: songKey(parts[1], parts[2]), y, a: parts[1], t: parts[2], tags, src: 'lib' });
  }
  return out;
}

export function decadeLabel(d) {
  return d >= 2000 ? `${d}s` : `'${String(d).slice(2)}s`;
}

export function packLabel(pack) {
  const g = pack.src === 'lib' ? (GENRES.find((x) => x.id === pack.genre) || { label: pack.genre }).label : pack.genre;
  if (pack.src === 'playlist') return `Playlist: ${pack.name || pack.genre}`;
  const decs = [...(pack.decades || [])].sort((a, b) => a - b);
  let range = 'all years';
  if (decs.length === DECADES.length) range = 'all years';
  else if (decs.length && decs.every((d, i) => i === 0 || d - decs[i - 1] === 10)) {
    range = decs.length === 1 ? decadeLabel(decs[0]) : `${decadeLabel(decs[0])}–${decadeLabel(decs[decs.length - 1])}`;
  } else if (decs.length) range = decs.map(decadeLabel).join(', ');
  return `${g} · ${range}`;
}

function inDecades(y, decades) {
  if (!decades || !decades.length) return true;
  return decades.some((d) => y >= d && y <= d + 9);
}

// Songs a pack contributes. Library packs filter the curated list; search/playlist packs carry their own songs.
export function packSongs(pack, library, settings = DEFAULT_SETTINGS) {
  const exclude = settings.exclude || [];
  if (pack.src === 'lib') {
    return library.filter((s) =>
      (pack.genre === 'all' || s.tags.includes(pack.genre)) &&
      inDecades(s.y, pack.decades) &&
      !s.tags.some((t) => exclude.includes(t)));
  }
  return (pack.songs || []).filter((s) => inDecades(s.y, pack.decades));
}

// The deck for one draw: every song from the packs that apply, minus used ones, deduplicated.
export function buildPool(packs, library, settings, { owner = null, used = [] } = {}) {
  const usedSet = new Set(used);
  const seen = new Set();
  const pool = [];
  for (const pack of packs) {
    if (pack.off) continue;
    if (owner && settings.ownTaste && pack.owner && pack.owner !== 'all' && pack.owner !== owner) continue;
    for (const s of packSongs(pack, library, settings)) {
      if (usedSet.has(s.k) || seen.has(s.k)) continue;
      seen.add(s.k);
      pool.push(s);
    }
  }
  return pool;
}

export function pick(pool, rng = Math.random) {
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

// ---------- timeline ----------

// slot i = before timeline[i]; slot timeline.length = after the last card. Equal years fit either side.
export function slotFits(timeline, slot, year) {
  const prev = timeline[slot - 1];
  const next = timeline[slot];
  return (!prev || prev.y <= year) && (!next || year <= next.y);
}

export function insertSorted(timeline, card) {
  const out = timeline.slice();
  let i = 0;
  while (i < out.length && out[i].y <= card.y) i++;
  out.splice(i, 0, card);
  return out;
}

// ---------- game state ----------

export function newGame(setup) {
  const settings = { ...DEFAULT_SETTINGS, ...(setup.settings || {}) };
  return {
    v: 1,
    phase: 'deal',
    settings,
    players: setup.players.map((p, i) => ({
      id: p.id, name: p.name, color: p.color || COLORS[i % COLORS.length],
      tokens: settings.startTokens, timeline: [],
    })),
    current: 0,
    round: 1,
    used: [],
    turn: null,
    log: [],
    winner: null,
  };
}

export function activePlayer(g) {
  return g.players[g.current];
}

export function dealStarter(g, playerIndex, card) {
  const p = g.players[playerIndex];
  p.timeline = insertSorted(p.timeline, { ...card, starter: true });
  g.used.push(card.k);
}

export function startTurn(g, card) {
  g.phase = 'listen';
  g.used.push(card.k);
  g.turn = { card, slot: null, challengers: [], named: false, result: null, bought: false };
}

export function chooseSlot(g, slot) {
  if (g.phase !== 'listen' && g.phase !== 'challenge') return;
  g.turn.slot = slot;
}

// Spend a token to throw the current song away and draw another.
export function canSkip(g) {
  return g.phase === 'listen' && activePlayer(g).tokens >= 1;
}

export function skip(g, card) {
  const p = activePlayer(g);
  if (p.tokens < 1) return false;
  p.tokens -= 1;
  g.used.push(card.k);
  g.turn = { card, slot: null, challengers: [], named: false, result: null, bought: false };
  g.log.push({ type: 'skip', player: p.id });
  return true;
}

export function canBuy(g) {
  return g.phase === 'listen' && activePlayer(g).tokens >= 3;
}

// Trade three tokens: the current song goes straight onto the timeline in the right place.
export function buy(g) {
  const p = activePlayer(g);
  if (p.tokens < 3) return false;
  p.tokens -= 3;
  g.turn.bought = true;
  p.timeline = insertSorted(p.timeline, g.turn.card);
  g.turn.result = { correct: true, winner: p.id, bought: true };
  g.phase = 'reveal';
  checkWinner(g);
  return true;
}

export function lockIn(g) {
  if (g.phase !== 'listen' || g.turn.slot == null) return false;
  const others = g.players.filter((p, i) => i !== g.current && p.tokens >= 1);
  g.phase = g.settings.challenges && others.length ? 'challenge' : 'reveal';
  if (g.phase === 'reveal') resolve(g);
  return true;
}

// A challenger spends a token and claims a different slot on the active player's timeline.
export function addChallenge(g, playerId, slot) {
  if (g.phase !== 'challenge') return false;
  const p = g.players.find((x) => x.id === playerId);
  if (!p || p === activePlayer(g) || p.tokens < 1) return false;
  if (slot === g.turn.slot || g.turn.challengers.some((c) => c.slot === slot || c.player === playerId)) return false;
  p.tokens -= 1;
  g.turn.challengers.push({ player: playerId, slot });
  return true;
}

export function removeChallenge(g, playerId) {
  if (g.phase !== 'challenge') return;
  const i = g.turn.challengers.findIndex((c) => c.player === playerId);
  if (i < 0) return;
  g.turn.challengers.splice(i, 1);
  g.players.find((x) => x.id === playerId).tokens += 1;
}

export function reveal(g) {
  if (g.phase !== 'challenge') return;
  g.phase = 'reveal';
  resolve(g);
}

function resolve(g) {
  const p = activePlayer(g);
  const { card, slot, challengers } = g.turn;
  const correct = slotFits(p.timeline, slot, card.y);
  let winner = null;
  if (correct) {
    p.timeline = insertSorted(p.timeline, card);
    winner = p.id;
  } else {
    const c = challengers.find((x) => slotFits(p.timeline, x.slot, card.y));
    if (c) {
      const cp = g.players.find((x) => x.id === c.player);
      cp.timeline = insertSorted(cp.timeline, card);
      winner = cp.id;
    }
  }
  g.turn.result = { correct, winner, stolen: !correct && !!winner };
  g.log.push({ type: 'turn', player: p.id, card: card.k, year: card.y, correct, winner });
  checkWinner(g);
}

// The active player said the artist and title out loud and the table agrees: one token (up to the cap).
export function setNamed(g, named) {
  if (g.phase !== 'reveal' || !g.settings.nameBonus) return;
  const p = activePlayer(g);
  if (named && !g.turn.named) {
    if (p.tokens < g.settings.maxTokens) { p.tokens += 1; g.turn.namedPaid = true; }
    g.turn.named = true;
  } else if (!named && g.turn.named) {
    if (g.turn.namedPaid) p.tokens -= 1;
    g.turn.named = false;
    g.turn.namedPaid = false;
  }
}

function checkWinner(g) {
  const w = g.players.find((p) => p.timeline.length >= g.settings.target);
  if (w) g.winner = w.id;
}

export function nextTurn(g) {
  if (g.winner) { g.phase = 'over'; g.turn = null; return; }
  g.current = (g.current + 1) % g.players.length;
  if (g.current === 0) g.round += 1;
  g.turn = null;
  g.phase = 'draw';
}

export function standings(g) {
  return g.players
    .map((p) => ({ id: p.id, name: p.name, color: p.color, cards: p.timeline.length, tokens: p.tokens }))
    .sort((a, b) => b.cards - a.cards || b.tokens - a.tokens);
}

// Suggest the decades someone grew up with: roughly age 8 to 28.
export function formativeDecades(born) {
  const b = parseInt(born, 10);
  if (!(b > 1900)) return [];
  const from = Math.floor((b + 8) / 10) * 10;
  const to = Math.floor((b + 28) / 10) * 10;
  return DECADES.filter((d) => d >= from && d <= to);
}

// Spotify search results → playable songs. Drops live takes, remixes, remasters and compilations.
export function songsFromTracks(tracks, { decades = [], src = 'spotify' } = {}) {
  const out = [];
  const seen = new Set();
  for (const t of tracks) {
    if (!t || !t.uri || t.type === 'episode' || t.is_local) continue;
    const album = t.album || {};
    if (album.album_type === 'compilation') continue;
    if (isAltVersion(t.name) || isAltVersion(album.name || '')) continue;
    const y = parseInt(String(album.release_date || '').slice(0, 4), 10);
    if (!(y > 1900)) continue;
    if (decades.length && !inDecades(y, decades)) continue;
    const artist = (t.artists || []).map((a) => a.name).join(', ');
    const k = songKey((t.artists || [])[0]?.name || artist, t.name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      k, y, a: artist, t: t.name.replace(/\s+-\s+.*$/, ''), uri: t.uri,
      img: (album.images || [])[0]?.url || '', artistId: (t.artists || [])[0]?.id || '', src,
    });
  }
  return out;
}

// Pick the Spotify track that is the original recording of a library song.
export function bestMatch(song, tracks) {
  const want = coreTitle(song.t);
  const wantArtists = norm(song.a).split(/\s+(?:and|feat|x|with)\s+|,/).map((s) => s.trim()).filter(Boolean);
  let best = null;
  let bestScore = -Infinity;
  for (const t of tracks) {
    if (!t || !t.uri) continue;
    const name = coreTitle(t.name);
    const artists = (t.artists || []).map((a) => norm(a.name));
    const artistHit = artists.some((a) => wantArtists.some((w) => a === w || a.includes(w) || w.includes(a)));
    if (!artistHit) continue;
    if (!(name === want || name.startsWith(want) || want.startsWith(name))) continue;
    const album = t.album || {};
    const y = parseInt(String(album.release_date || '').slice(0, 4), 10) || 0;
    let score = name === want ? 4 : 1;
    if (isAltVersion(t.name)) score -= 5;
    if (album.album_type === 'compilation') score -= 2;
    if (y) score -= Math.min(6, Math.abs(y - song.y)) * 0.8;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// Earliest plausible release year among search results for the same song (fixes remaster/compilation years).
export function earliestYear(song, tracks) {
  const want = coreTitle(song.t);
  const first = norm(song.a.split(',')[0]);
  let min = song.y;
  for (const t of tracks) {
    if (!t) continue;
    if (coreTitle(t.name) !== want) continue;
    if (!(t.artists || []).some((a) => norm(a.name) === first)) continue;
    const y = parseInt(String(t.album?.release_date || '').slice(0, 4), 10);
    if (y > 1900 && y < min) min = y;
  }
  return min;
}

// Setup shared through a link: players, packs (search/playlist packs without their downloaded songs) and rules.
export function encodeSetup(setup) {
  const slim = {
    players: setup.players.map(({ id, name, color, born }) => ({ id, name, color, born })),
    packs: setup.packs.map(({ songs, ...rest }) => rest),
    settings: setup.settings,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(slim));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSetup(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(data.players) || !Array.isArray(data.packs)) throw new Error('bad setup');
  return data;
}
