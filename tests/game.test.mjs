import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../public/game.js';

const library = G.parseLibrary(readFileSync(new URL('../public/songs.txt', import.meta.url), 'utf8'));

test('library parses, has no duplicates and sane years and tags', () => {
  assert.ok(library.length > 500, `only ${library.length} songs`);
  const keys = new Set();
  const tags = new Set(G.GENRES.map((g) => g.id).concat(['extreme']));
  for (const s of library) {
    assert.ok(!keys.has(s.k), `duplicate ${s.a} - ${s.t}`);
    keys.add(s.k);
    assert.ok(s.y >= 1955 && s.y <= 2026, `${s.t} year ${s.y}`);
    for (const t of s.tags) assert.ok(tags.has(t), `${s.t}: unknown tag ${t}`);
  }
});

test('every genre has songs in several decades', () => {
  for (const g of G.GENRES) {
    const decs = new Set(library.filter((s) => g.id === 'all' || s.tags.includes(g.id)).map((s) => Math.floor(s.y / 10)));
    assert.ok(decs.size >= 2, `${g.id} only in ${decs.size} decades`);
  }
});

test('slotFits accepts ties and edges', () => {
  const tl = [{ y: 1970 }, { y: 1985 }, { y: 2001 }];
  assert.ok(G.slotFits(tl, 0, 1960));
  assert.ok(G.slotFits(tl, 0, 1970));
  assert.ok(!G.slotFits(tl, 0, 1971));
  assert.ok(G.slotFits(tl, 1, 1970));
  assert.ok(G.slotFits(tl, 1, 1985));
  assert.ok(G.slotFits(tl, 3, 2020));
  assert.ok(!G.slotFits(tl, 3, 1999));
  assert.ok(G.slotFits([], 0, 1999));
});

test('packs filter by genre, decade and exclusions', () => {
  const metal80 = G.packSongs({ src: 'lib', genre: 'metal', decades: [1980] }, library, G.DEFAULT_SETTINGS);
  assert.ok(metal80.length > 10);
  assert.ok(metal80.every((s) => s.y >= 1980 && s.y <= 1989 && s.tags.includes('metal') && !s.tags.includes('extreme')));
  const withExtreme = G.packSongs({ src: 'lib', genre: 'metal', decades: [1980] }, library, { exclude: [] });
  assert.ok(withExtreme.length > metal80.length);
});

test('multi-genre packs combine genres and label them', () => {
  const pack = { src: 'lib', genres: ['metal', 'swedish'], decades: [1980] };
  const songs = G.packSongs(pack, library, G.DEFAULT_SETTINGS);
  const metal = G.packSongs({ src: 'lib', genre: 'metal', decades: [1980] }, library, G.DEFAULT_SETTINGS);
  assert.ok(songs.length > metal.length);
  assert.ok(songs.every((s) => s.tags.includes('metal') || s.tags.includes('swedish')));
  assert.equal(G.packLabel(pack), "Metal + Swedish · '80s");
  assert.deepEqual(G.packGenreIds({ genres: ['rock', 'all'] }), ['all']);
});

test('own-taste pools only use the player packs plus shared ones', () => {
  const packs = [
    { id: 'a', src: 'lib', genre: 'metal', decades: [1980], owner: 'dad' },
    { id: 'b', src: 'lib', genre: 'pop', decades: [2010], owner: 'kid' },
    { id: 'c', src: 'lib', genre: 'swedish', decades: [1970], owner: 'all' },
  ];
  const settings = { ...G.DEFAULT_SETTINGS, ownTaste: true };
  const dad = G.buildPool(packs, library, settings, { owner: 'dad' });
  assert.ok(dad.every((s) => (s.tags.includes('metal') && s.y < 1990) || s.tags.includes('swedish')));
  const shared = G.buildPool(packs, library, { ...settings, ownTaste: false }, { owner: 'dad' });
  assert.ok(shared.length > dad.length);
});

function game(names = ['A', 'B', 'C'], settings = {}) {
  const g = G.newGame({ players: names.map((n) => ({ id: n, name: n })), settings });
  names.forEach((_, i) => G.dealStarter(g, i, { k: `s${i}`, y: 1980 + i * 10, a: 'x', t: `s${i}` }));
  return g;
}

test('a correct placement keeps the card, a wrong one goes to a correct challenger', () => {
  const g = game();
  G.startTurn(g, { k: 'c1', y: 1975 });
  G.chooseSlot(g, 0);
  G.lockIn(g);
  assert.equal(g.phase, 'challenge');
  G.reveal(g);
  assert.equal(g.turn.result.correct, true);
  assert.equal(g.players[0].timeline.length, 2);
  G.nextTurn(g);
  assert.equal(g.current, 1);

  G.startTurn(g, { k: 'c2', y: 2005 });
  G.chooseSlot(g, 0); // before 1990: wrong
  G.lockIn(g);
  assert.ok(G.addChallenge(g, 'C', 1));
  assert.ok(!G.addChallenge(g, 'A', 1), 'slot already taken');
  assert.ok(!G.addChallenge(g, 'B', 1), 'active player cannot challenge');
  assert.equal(g.players[2].tokens, 1);
  G.reveal(g);
  assert.deepEqual(g.turn.result, { correct: false, winner: 'C', stolen: true });
  assert.equal(g.players[2].timeline.length, 2);
  assert.equal(g.players[1].timeline.length, 1);
});

test('naming bonus respects the cap and can be undone', () => {
  const g = game(['A', 'B'], { maxTokens: 3 });
  G.startTurn(g, { k: 'c', y: 1950 });
  G.chooseSlot(g, 0);
  G.lockIn(g);
  G.reveal(g);
  G.setNamed(g, true);
  assert.equal(g.players[0].tokens, 3);
  G.setNamed(g, false);
  assert.equal(g.players[0].tokens, 2);
  g.players[0].tokens = 3;
  G.setNamed(g, true);
  assert.equal(g.players[0].tokens, 3, 'capped');
  G.setNamed(g, false);
  assert.equal(g.players[0].tokens, 3, 'no refund of a bonus that was never paid');
});

test('skip and buy cost tokens; reaching the target ends the game', () => {
  const g = game(['A', 'B'], { target: 2, challenges: false });
  G.startTurn(g, { k: 'c', y: 1950 });
  assert.ok(G.skip(g, { k: 'd', y: 1960 }));
  assert.equal(g.players[0].tokens, 1);
  assert.ok(!G.buy(g));
  g.players[0].tokens = 3;
  assert.ok(G.buy(g));
  assert.equal(g.players[0].tokens, 0);
  assert.equal(g.winner, 'A');
  G.nextTurn(g);
  assert.equal(g.phase, 'over');
});

test('without challengers lockIn reveals straight away', () => {
  const g = game(['A', 'B'], { challenges: false });
  G.startTurn(g, { k: 'c', y: 2020 });
  G.chooseSlot(g, 1);
  G.lockIn(g);
  assert.equal(g.phase, 'reveal');
  assert.equal(g.turn.result.correct, true);
});

test('Spotify helpers: version filter, best match, earliest year', () => {
  assert.ok(G.isAltVersion('Paranoid - 2012 Remaster'));
  assert.ok(G.isAltVersion('Enter Sandman (Live)'));
  assert.ok(!G.isAltVersion('Livin\' on a Prayer'));
  assert.ok(!G.isAltVersion('Live Forever'));
  const song = { a: 'Black Sabbath', t: 'Paranoid', y: 1970 };
  const tr = (name, artist, year, type = 'album') => ({ uri: `spotify:track:${name}${year}`, name, artists: [{ name: artist }], album: { release_date: `${year}-01-01`, album_type: type } });
  const tracks = [tr('Paranoid - Live', 'Black Sabbath', 1980), tr('Paranoid', 'Black Sabbath', 2009, 'compilation'), tr('Paranoid', 'Black Sabbath', 1970), tr('Paranoid', 'Someone Else', 1970)];
  assert.equal(G.bestMatch(song, tracks).uri, 'spotify:track:Paranoid1970');
  assert.equal(G.earliestYear({ a: 'Black Sabbath', t: 'Paranoid', y: 2009 }, tracks), 1970);
  const songs = G.songsFromTracks(tracks, { decades: [1970] });
  assert.equal(songs.length, 2, 'live + compilation dropped, other artist kept');
  assert.equal(songs[0].y, 1970);
});

test('setup links round-trip, including non-ASCII names', () => {
  const setup = { players: [{ id: 'p', name: 'Måns', color: '#fff', born: 1969, timeline: [] }], packs: [{ id: 'x', src: 'spotify', genre: 'eurodance', decades: [1990], songs: [{}] }], settings: { target: 8 } };
  const back = G.decodeSetup(G.encodeSetup(setup));
  assert.equal(back.players[0].name, 'Måns');
  assert.equal(back.packs[0].songs, undefined);
  assert.equal(back.settings.target, 8);
});

test('formative decades from a birth year', () => {
  assert.deepEqual(G.formativeDecades(1969), [1970, 1980, 1990]);
  assert.deepEqual(G.formativeDecades(2006), [2010, 2020]);
});

test('right spot + named artist and title: same player goes again', () => {
  const g = G.newGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], settings: { challenges: false } });
  G.dealStarter(g, 0, { k: 's1', y: 1990, a: 'x', t: 'x' });
  G.dealStarter(g, 1, { k: 's2', y: 1990, a: 'y', t: 'y' });
  g.phase = 'draw';
  G.startTurn(g, { k: 'c1', y: 2000, a: 'z', t: 'z' });
  G.chooseSlot(g, 1);
  G.lockIn(g);
  assert.equal(g.turn.result.correct, true);
  G.setNamed(g, true);
  assert.equal(G.goesAgain(g), true);
  G.nextTurn(g);
  assert.equal(g.current, 0);
  // right spot without naming passes the turn on
  G.startTurn(g, { k: 'c2', y: 2010, a: 'w', t: 'w' });
  G.chooseSlot(g, 2);
  G.lockIn(g);
  assert.equal(G.goesAgain(g), false);
  G.nextTurn(g);
  assert.equal(g.current, 1);
});

test('challenge decisions: everyone with a token must say yes or no', () => {
  const g = G.newGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], settings: { startTokens: 2 } });
  for (let i = 0; i < 3; i++) G.dealStarter(g, i, { k: 's' + i, y: 1990, a: 'x', t: 'x' });
  g.phase = 'draw';
  G.startTurn(g, { k: 'c1', y: 2000, a: 'z', t: 'z' });
  g.players[2].tokens = 0; // C can't afford a challenge, so isn't asked
  G.chooseSlot(g, 0);
  G.lockIn(g);
  assert.equal(g.phase, 'challenge');
  assert.deepEqual(G.pendingChallengers(g).map((p) => p.id), ['b']);
  assert.equal(G.passChallenge(g, 'a'), false); // the active player never challenges
  assert.equal(G.passChallenge(g, 'b'), true);
  assert.deepEqual(G.pendingChallengers(g), []);
  // a challenger who takes it back has to decide again
  g.turn.passed = [];
  assert.equal(G.addChallenge(g, 'b', 1), true);
  assert.deepEqual(G.pendingChallengers(g), []);
  G.removeChallenge(g, 'b');
  assert.deepEqual(G.pendingChallengers(g).map((p) => p.id), ['b']);
  // no free gap left: nobody is asked
  G.addChallenge(g, 'b', 1);
  g.players[2].tokens = 1;
  assert.deepEqual(G.pendingChallengers(g), []);
});
