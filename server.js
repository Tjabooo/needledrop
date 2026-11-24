#!/usr/bin/env node
// Needledrop static server: serves public/, plus /config.json (the Spotify Client ID), /api/health and the
// room relay (/api/rooms, see rooms.js) for games where everyone plays on their own phone.
// No dependencies. Settings come from environment variables or a .env file next to this script.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRooms } from './rooms.js';

const root = dirname(fileURLToPath(import.meta.url));
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const PORT = parseInt(process.env.PORT || '8150', 10);
const HOST = process.env.HOST || '127.0.0.1';
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const pub = join(root, 'public');
const started = new Date().toISOString();
const VERSION = Date.now().toString(36);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...security, ...extra });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/rooms')) { await handleRooms(req, res, url); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
  if (url.pathname === '/config.json') {
    return send(res, 200, JSON.stringify({ spotifyClientId: CLIENT_ID }), 'application/json', { 'Cache-Control': 'no-store' });
  }
  if (url.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, started }), 'application/json', { 'Cache-Control': 'no-store' });
  }
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(pub, path));
  if (!file.startsWith(pub)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    let body = await readFile(file);
    const ext = extname(file);
    // Version every asset reference so a CDN that ignores no-cache still picks up a deploy.
    if (ext === '.html') body = Buffer.from(body.toString().replace(/(href|src)="([\w-]+\.(?:css|js))"/g, `$1="$2?v=${VERSION}"`));
    if (ext === '.js') body = Buffer.from(body.toString().replace(/from '(\.\/[\w-]+\.js)'/g, `from '$1?v=${VERSION}'`));
    // Short cache + revalidation: a deploy shows up on the next visit.
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': body.length,
      'Cache-Control': 'no-cache', 'Last-Modified': st.mtime.toUTCString(), ...security,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    // Unknown paths (including Spotify's /?code= redirect target variations) get the app.
    if (!extname(path)) {
      const body = (await readFile(join(pub, 'index.html'), 'utf8')).replace(/(href|src)="([\w-]+\.(?:css|js))"/g, `$1="/$2?v=${VERSION}"`);
      return send(res, 200, body, TYPES['.html'], { 'Cache-Control': 'no-cache' });
    }
    send(res, 404, 'Not found', 'text/plain');
  }
});

server.listen(PORT, HOST, () => console.log(`needledrop on http://${HOST}:${PORT} (Spotify client id ${CLIENT_ID ? 'set' : 'not set: players paste their own'})`));
