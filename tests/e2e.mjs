// Browser smoke test: starts the server, drives headless Chromium over CDP (Node 22 WebSocket, no deps) through
// a demo game (?demo = no Spotify, silent) and optionally saves screenshots.
//   node tests/e2e.mjs [--shots DIR]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || ['/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((f) => fs.existsSync(f));
const PORT = 8199;
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); };

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT: String(PORT), SPOTIFY_CLIENT_ID: '' }, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-e2e-'));
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--no-first-run', '--disable-gpu', `--user-data-dir=${profile}`,
  '--remote-debugging-port=9339', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const click = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
const shot = async (name) => {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await sleep(900);
  await ev(`document.querySelector('.toast')?.remove()`);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
};

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch('http://127.0.0.1:9339/json').then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const errors = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result || {}); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description);
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/?demo` });
  check('setup page renders', await until(`!!document.querySelector('.setup')`));
  check('demo counts as logged in', await until(`document.body.innerText.includes('demo mode')`));

  // three players with birth years
  for (const [name, born] of [['Pappa', '1969'], ['Mamma', '1973'], ['Oliver', '2006']]) {
    await click('[data-action="addPlayer"]');
    await ev(`(() => { const rows = document.querySelectorAll('.player-row'); const r = rows[rows.length - 1];
      const n = r.querySelector('[data-field="name"]'); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event('input', { bubbles: true }));
      const b = r.querySelector('[data-field="born"]'); b.value = ${JSON.stringify(born)}; b.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  }
  await ev(`document.activeElement?.blur()`);
  check('three players', (await ev(`document.querySelectorAll('.player-row').length`)) === 3);

  // packs: metal 80s+90s for Pappa via the builder, then everyone's era
  await ev(`[...document.querySelectorAll('.player-row [data-action="era"]')][0].click()`);
  await click('[data-action="genre"][data-id="metal"]');
  const label = await ev(`document.querySelector('[data-action="addPack"]').textContent`);
  check('era sets decades for Pappa', /Metal · '70s–'90s/.test(label), label.trim());
  await click('[data-action="addPack"]');
  await click('[data-action="eras"]');
  const packs = await ev(`document.querySelectorAll('.pack').length`);
  check('packs added', packs === 4, `${packs}`);
  const deck = await ev(`document.querySelector('.songs .head .meta').textContent`);
  check('deck has songs', parseInt(deck, 10) > 300, deck);
  await click('[data-action="setting"][data-id="ownTaste"]');
  await shot('setup.png');

  await click('[data-action="start"]');
  check('game starts and a song plays', await until(`!!document.querySelector('.stage-split') && document.querySelectorAll('.timeline .card').length === 1`));
  check('every player got a starter card', (await ev(`JSON.parse(localStorage.getItem('nd.game')).players.every(p => p.timeline.length === 1)`)));

  // play 6 turns: place at gap 0, challenge on the second turn, mark the name bonus on the third
  for (let turn = 0; turn < 6; turn++) {
    await click('.gap[data-slot="0"]');
    await click('[data-action="lock"]');
    if (await ev(`!!document.querySelector('[data-action="reveal"]')`)) {
      if (turn === 1) {
        await click('.chal:not([disabled])');
        await click('.gap[data-slot="1"]');
        check('challenge placed', await until(`!!document.querySelector('.gap.claimed')`));
        if (turn === 1) await shot('challenge.png');
      }
      await click('[data-action="reveal"]');
    }
    check(`turn ${turn + 1} reveals`, await until(`!!document.querySelector('.big-card')`));
    if (turn === 2) {
      const before = await ev(`JSON.parse(localStorage.getItem('nd.game')).players[JSON.parse(localStorage.getItem('nd.game')).current].tokens`);
      await click('[data-action="named"]');
      const after = await ev(`JSON.parse(localStorage.getItem('nd.game')).players[JSON.parse(localStorage.getItem('nd.game')).current].tokens`);
      check('name bonus adds a token', after === Math.min(5, before + 1), `${before}→${after}`);
      await shot('reveal.png');
    }
    await click('[data-action="next"]');
    await until(`!!document.querySelector('[data-action="lock"]') || !!document.querySelector('.podium')`);
  }
  const g = await ev(`JSON.parse(localStorage.getItem('nd.game'))`);
  check('cards and turns add up', g.players.reduce((n, p) => n + p.timeline.length, 0) <= 3 + 6 && g.log.filter((l) => l.type === 'turn').length === 6);
  check('years on every timeline are sorted', g.players.every((p) => p.timeline.every((c, i, a) => !i || a[i - 1].y <= c.y)));

  // keyboard: arrows + enter, then undo
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  check('arrow key picks a gap', await until(`!!document.querySelector('.gap.selected')`));
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true }))`);
  check('undo clears the gap', await until(`!document.querySelector('.gap.selected')`));
  await shot('turn.png');

  // reload keeps the game
  await cdp('Page.reload');
  check('game survives a reload', await until(`!!document.querySelector('.game') && document.querySelectorAll('.score').length === 3`));
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  check('run', false, e.stack);
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  server.kill();
  await Promise.race([exited, sleep(3000)]);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still closing */ }
  console.log(`${ok}/${ok + bad} passed`);
  process.exit(bad ? 1 : 0);
}
