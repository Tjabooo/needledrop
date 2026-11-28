// Browser test for room games: a host page (?demo, silent) and a phone page (different origin, so separate storage)
// play two turns against each other through the server.
//   node tests/e2e-room.mjs [--shots DIR]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || ['/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((f) => fs.existsSync(f));
const PORT = 8198;
const DBG = 9338;
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); };

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT: String(PORT), SPOTIFY_CLIENT_ID: '' }, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-e2e-room-'));
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--no-first-run', '--disable-gpu', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${DBG}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

class Page {
  static async open(width, height, mobile) {
    const p = new Page();
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      target = await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()).catch(() => null);
    }
    p.ws = new WebSocket(target.webSocketDebuggerUrl);
    p.seq = 0; p.pending = new Map(); p.errors = [];
    await new Promise((r) => p.ws.addEventListener('open', r));
    p.ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && p.pending.has(msg.id)) { p.pending.get(msg.id)(msg.result || {}); p.pending.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') p.errors.push(msg.params.exceptionDetails.exception?.description);
    });
    await p.cdp('Runtime.enable');
    await p.cdp('Page.enable');
    await p.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await p.ev(`window.confirm = () => true`).catch(() => {});
    return p;
  }
  cdp(method, params = {}) { return new Promise((resolve) => { const id = ++this.seq; this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async go(url) { await this.cdp('Page.navigate', { url }); await sleep(300); await this.ev(`window.confirm = () => true`); }
  click(sel) { return this.ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`); }
  type(sel, value) { return this.ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`); }
  async until(expr, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await this.ev(expr).catch(() => false)) return true; await sleep(150); } return false; }
  async shot(name) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await sleep(900);
    await this.ev(`document.querySelector('.toast')?.remove()`);
    const { data } = await this.cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
  }
}

const hostGame = (h) => h.ev(`JSON.parse(localStorage.getItem('nd.game'))`);

try {
  const host = await Page.open(1440, 900, false);
  const phone = await Page.open(390, 844, true);

  // host: one player at the table, then a room
  await host.go(`http://127.0.0.1:${PORT}/?demo`);
  check('host setup renders', await host.until(`!!document.querySelector('.setup') && document.body.innerText.includes('demo mode')`));
  await host.click('[data-action="addPlayer"]');
  await host.type('.player-row [data-field="name"]', 'Oliver');
  await host.click('[data-action="openRoom"]');
  check('room opens with a QR code', await host.until(`!!document.querySelector('.modal .qr svg') && !!JSON.parse(localStorage.getItem('nd.room'))?.code`));
  const code = await host.ev(`JSON.parse(localStorage.getItem('nd.room')).code`);
  check('room link carries the host language', await host.until(`/\\?l=en$/.test(document.querySelector('.room-box .copy')?.dataset.text || '')`));
  await host.shot('room-modal.png');
  await host.click('.modal .close');

  // phone: the link opens the join screen with the code filled in
  await phone.go(`http://localhost:${PORT}/${code}`);
  check('phone gets the join screen', await phone.until(`document.querySelector('#joinCode')?.value === ${JSON.stringify(code)}`));
  await phone.ev(`document.querySelector('#joinName').value = 'Mamma'; document.querySelector('#joinBorn').value = '1973'`);
  await phone.shot('phone-join.png');
  await phone.click('[data-action="joinGo"]');
  check('phone lands in the lobby', await phone.until(`!!document.querySelector('.lobby .who') && document.querySelector('.lobby .who').textContent.includes('Mamma')`));
  check('host lists the phone player', await host.until(`document.querySelectorAll('.player-row').length === 2 && !!document.querySelector('.player-row .phone.on')`));
  check('phone sees both players', await phone.until(`document.querySelectorAll('.roster .pchip').length === 2`));
  await host.shot('room-setup.png');
  await phone.shot('phone-lobby.png');

  // phone renames itself; the host follows
  await phone.ev(`document.querySelector('#meName').value = 'Mor'`);
  await phone.click('[data-action="saveProfile"]');
  check('rename reaches the host', await host.until(`[...document.querySelectorAll('.player-row [data-field="name"]')].some((i) => i.value === 'Mor')`));

  // start: Oliver (host screen) goes first
  await host.click('[data-action="start"]');
  check('game starts on the host', await host.until(`!!document.querySelector('[data-action="lock"]')`));
  check('phone follows into the game', await phone.until(`!!document.querySelector('.game.is-guest') && document.body.innerText.includes('Oliver is guessing')`));
  let g = await hostGame(host);
  const secret = g.turn.card.t;
  check('phone cannot see the hidden song', !(await phone.ev(`document.body.innerText.includes(${JSON.stringify(secret)})`)), secret);
  check('phone has no turn controls on someone else\'s turn', !(await phone.ev(`!!document.querySelector('[data-action="lock"], [data-action="skip"]')`)));

  await host.click('.gap[data-slot="0"]');
  check('phone sees the host pick live', await phone.until(`!!document.querySelector('.tl-wrap .gap.selected')`));
  await host.click('[data-action="lock"]');
  check('phone gets the challenge popup', await phone.until(`!!document.querySelector('.decide [data-action="chYes"]') && !!document.querySelector('.decide [data-action="chPass"]')`));
  check('phone has no reveal button on someone else\'s turn', !(await phone.ev(`!!document.querySelector('[data-action="reveal"]')`)));
  check('host cannot reveal while a phone decides', await host.until(`!document.querySelector('[data-action="reveal"]') && document.body.innerText.includes('to decide')`));
  await phone.shot('phone-challenge-popup.png');
  await phone.click('[data-action="chYes"]');
  check('popup gives way to gap picking', await phone.until(`!document.querySelector('.decide') && !!document.querySelector('[data-action="chBack"]')`));
  await phone.click('.gap[data-slot="1"]');
  check('phone challenge reaches the host', await host.until(`(g => g.turn.challengers.length === 1 || g.phase === 'reveal')(JSON.parse(localStorage.getItem('nd.game')))`));
  check('reveal comes once everyone answered', await host.until(`JSON.parse(localStorage.getItem('nd.game')).phase === 'reveal'`));
  check('phone sees the reveal', await phone.until(`!!document.querySelector('.big-card')`));
  check('phone waits for the host to move on', await phone.ev(`!document.querySelector('[data-action="next"]') && !!document.querySelector('.waiting')`));
  await host.click('[data-action="next"]');

  // Mor's turn, played from the phone
  check('phone gets its turn', await phone.until(`!!document.querySelector('[data-action="lock"]') && document.body.innerText.toLowerCase().includes('your turn')`));
  await phone.shot('phone-turn.png');
  check('host has no turn controls on the phone\'s turn', await host.until(`!document.querySelector('[data-action="lock"], [data-action="skip"], [data-action="buy"]') && !!document.querySelector('.waiting, .stage h1')`));
  await host.click('.gap[data-slot="1"]'); // must be ignored: it's Mor's move
  await phone.click('.gap[data-slot="0"]');
  check('phone pick reaches the host', await host.until(`JSON.parse(localStorage.getItem('nd.game')).turn.slot === 0`));
  await phone.click('[data-action="lock"]');
  check('phone lock reaches the host', await host.until(`['challenge', 'reveal'].includes(JSON.parse(localStorage.getItem('nd.game')).phase)`));
  if ((await hostGame(host)).phase === 'challenge') {
    check('host table player gets the popup', await host.until(`!!document.querySelector('.decide [data-action="chPass"]')`));
    check('phone waits for the answer, no reveal button', await phone.until(`!document.querySelector('[data-action="reveal"]') && document.body.innerText.includes('to decide')`));
    await host.shot('host-challenge-popup.png');
    await host.click('.decide [data-action="chPass"]');
  }
  check('phone reveal reaches the host', await host.until(`JSON.parse(localStorage.getItem('nd.game')).phase === 'reveal'`));
  await phone.until(`!!document.querySelector('[data-action="named"]')`);
  await phone.click('[data-action="named"]');
  check('phone name bonus reaches the host', await host.until(`JSON.parse(localStorage.getItem('nd.game')).turn.named === true`));
  await phone.shot('phone-reveal.png');
  await phone.click('[data-action="next"]');
  check('phone next moves the game on', await host.until(`(g => g.log.filter((l) => l.type === 'turn').length === 2 && g.phase !== 'reveal')(JSON.parse(localStorage.getItem('nd.game')))`));
  await host.shot('room-host-game.png');

  // ---------- game modes through a room ----------
  await host.ev(`window.confirm = () => true`);
  await host.click('[data-action="setup"]');
  await host.until(`!!document.querySelector('.setup')`);
  await host.click('[data-action="mode"][data-id="auction"]');
  await host.click('[data-action="start"]');
  check('auction: phone gets a year box', await phone.until(`!!document.querySelector('.guess-me input')`));
  check('auction: host shows the phone player as guessing', await host.until(`document.body.innerText.includes('guessing on their phone')`));
  await host.ev(`(() => { const r = document.querySelector('.guess-rows input'); r.value = '1980'; r.closest('.guess-row').querySelector('[data-action="guess"]').click(); })()`);
  await host.until(`Object.keys(JSON.parse(localStorage.getItem('nd.game')).turn.guesses).length === 1`);
  await sleep(400);
  check('auction: phone never gets the other year', !(await phone.ev(`document.body.innerText.includes('1980')`)));
  await phone.ev(`document.querySelector('.guess-me input').value = '1990'`);
  await phone.shot('phone-auction-guess.png');
  await phone.click('.guess-me [data-action="guess"]');
  check('auction: both years in = reveal', await host.until(`JSON.parse(localStorage.getItem('nd.game')).phase === 'reveal'`));
  check('auction: phone sees both years', await phone.until(`document.querySelectorAll('.guess-list li').length === 2`));
  await phone.shot('phone-auction-reveal.png');

  await host.click('[data-action="setup"]');
  await host.until(`!!document.querySelector('.setup')`);
  await host.click('[data-action="mode"][data-id="sprint"]');
  await host.click('[data-action="start"]');
  check('sprint: phone gets a buzz button', await phone.until(`!!document.querySelector('.buzz-big')`));
  await phone.shot('phone-sprint.png');
  await phone.click('.buzz-big');
  check('sprint: phone buzz reaches the host', await host.until(`JSON.parse(localStorage.getItem('nd.game')).phase === 'buzzed'`));
  check('sprint: phone places the card', await phone.until(`!!document.querySelector('[data-action="lock"]') && !!document.querySelector('.gap[data-slot="0"]')`));
  await phone.click('.gap[data-slot="0"]');
  await host.until(`JSON.parse(localStorage.getItem('nd.game')).turn.slot === 0`);
  await phone.click('[data-action="lock"]');
  check('sprint: phone lock resolves on the host', await host.until(`(g => g.phase === 'reveal' || g.turn.out.length === 1)(JSON.parse(localStorage.getItem('nd.game')))`));
  await host.click('[data-action="setup"]');
  await host.until(`!!document.querySelector('.setup')`);
  await host.click('[data-action="mode"][data-id="classic"]');
  await host.click('[data-action="resume"]');

  // a phone that reloads gets its seat back
  await phone.cdp('Page.reload');
  check('phone reload keeps the seat', await phone.until(`!!document.querySelector('.game.is-guest') && !!document.querySelector('.score.me')`));

  // language: a phone follows the host screen until its owner picks one on the phone
  await host.click('[data-action="lang"]');
  check('phone follows the host language', await phone.until(`document.documentElement.lang === 'sv' && document.body.innerText.includes('Tidslinjer')`));
  await phone.click('[data-action="lang"]');
  check('phone can pick its own language', await phone.until(`document.documentElement.lang === 'en'`));
  await host.click('[data-action="lang"]');
  await host.click('[data-action="lang"]');
  await host.until(`document.documentElement.lang === 'sv'`);
  await new Promise((r) => setTimeout(r, 800));
  check('phone keeps its own pick after that', await phone.ev(`document.documentElement.lang === 'en'`));
  await host.click('[data-action="lang"]');

  // leaving: the host drops the player from setup (the running game keeps them)
  await phone.ev(`window.confirm = () => true`);
  await phone.click('[data-action="leave"]');
  check('phone is back on its own setup', await phone.until(`!!document.querySelector('.setup') && location.pathname === '/'`));
  check('host drops the player', await host.until(`JSON.parse(localStorage.getItem('nd.setup')).players.length === 1`));
  check('no page errors', host.errors.length + phone.errors.length === 0, [...host.errors, ...phone.errors].join(' | ').slice(0, 300));
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
