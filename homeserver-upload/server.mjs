import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const derive = promisify(scrypt);
const CHUNK = 8 * 1024 * 1024;
const GiB = 1024 ** 3;
const GB = 1000 ** 3;
const fail = (status, message) => Object.assign(new Error(message), { status });
const equal = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createUploadServer(config) {
  const { root, adminSecret, signingKey, origin = 'https://www.jordanettinger.com', trustProxy = false } = config;
  if (!adminSecret || adminSecret.length < 12 || !signingKey || signingKey.length < 32) throw Error('adminSecret (12+) and signingKey (32+) are required');
  const quota = config.quota ?? 500 * GiB;
  if (!Number.isSafeInteger(quota) || quota < 1) throw Error('Upload quota must be a positive integer');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(root, 'uploads.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
      created INTEGER NOT NULL, expires INTEGER NOT NULL, max_size INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting', filename TEXT, size INTEGER, offset INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT, completed INTEGER
    );`);
  const get = id => db.prepare('SELECT * FROM invites WHERE id = ?').get(id);
  const location = (id, ext) => path.join(root, `${id}.${ext}`);
  const locks = new Set();
  const buckets = new Map();
  let hashing = 0;
  async function passwordHash(password, salt) {
    if (hashing >= 4) throw fail(503, 'Server is busy. Please retry shortly.');
    hashing++;
    try { return await derive(password, salt, 32); } finally { hashing--; }
  }
  function limit(key, max) {
    const now = Date.now();
    if (buckets.size > 10000) for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
    if (!buckets.has(key) && buckets.size >= 10000) throw fail(429, 'Too many requests. Try again later.');
    let b = buckets.get(key);
    if (!b || b.until < now) buckets.set(key, b = { n: 0, until: now + 15 * 60 * 1000 });
    if (++b.n > max) throw fail(429, 'Too many attempts. Try again in 15 minutes.');
  }
  function sign(data) {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${payload}.${createHmac('sha256', signingKey).update(payload).digest('base64url')}`;
  }
  function verify(token, role, id) {
    const [payload, signature, extra] = String(token || '').split('.');
    if (!payload || !signature || extra || !equal(signature, createHmac('sha256', signingKey).update(payload).digest('base64url'))) throw fail(401, 'Please sign in again.');
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url')); } catch { throw fail(401, 'Please sign in again.'); }
    if (data.role !== role || data.exp < Date.now() || (id && data.id !== id)) throw fail(401, 'Please sign in again.');
  }
  const view = row => ({ id: row.id, label: row.label, created: row.created, expires: row.expires, maxSize: row.max_size,
    state: row.state, filename: row.filename, size: row.size, offset: row.offset, fingerprint: row.fingerprint,
    completed: row.completed, chunkSize: CHUNK });
  async function json(req) {
    let body = '';
    for await (const part of req) { body += part; if (Buffer.byteLength(body) > 8192) throw fail(413, 'Request too large.'); }
    try { return JSON.parse(body); } catch { throw fail(400, 'Invalid request.'); }
  }
  function live(row) {
    if (!row || row.state === 'deleting') throw fail(404, 'Upload not found.');
    if (row.state !== 'complete' && row.expires <= Date.now()) throw fail(410, 'This upload invitation has expired.');
  }
  async function locked(id, fn) {
    if (locks.has(id)) throw fail(409, 'Another operation is in progress. Please retry.');
    locks.add(id);
    try { return await fn(); } finally { locks.delete(id); }
  }
  async function complete(row) {
    if (row.state === 'complete') return;
    if (row.state !== 'uploading' || row.offset !== row.size) throw fail(409, 'Upload is not finished.');
    try { await rename(location(row.id, 'part'), location(row.id, 'file')); }
    catch (e) { if (e.code !== 'ENOENT' || (await stat(location(row.id, 'file'))).size !== row.size) throw e; }
    if (process.platform !== 'win32') {
      const directory = await open(root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    db.prepare("UPDATE invites SET state='complete', completed=? WHERE id=?").run(Date.now(), row.id);
  }
  // Recover a crash between durable rename and the SQLite commit.
  for (const row of db.prepare("SELECT * FROM invites WHERE state='uploading' AND offset=size").all()) {
    try { await stat(location(row.id, 'file')); await complete(row); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async function clean() {
    for (const row of db.prepare("SELECT * FROM invites WHERE (expires < ? AND state != 'complete') OR state='deleting'").all(Date.now())) {
      if (locks.has(row.id)) continue;
      await locked(row.id, async () => {
        await rm(location(row.id, 'part'), { force: true });
        if (row.state === 'deleting') {
          await rm(location(row.id, 'file'), { force: true });
          db.prepare('DELETE FROM invites WHERE id=?').run(row.id);
        }
      });
    }
  }
  await clean();
  const timer = setInterval(() => clean().catch(() => console.error('Upload cleanup failed')), 3600000).unref();
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.origin) {
      if (req.headers.origin !== origin) { send(403, { error: 'Origin not allowed.' }); return; }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Upload-Offset');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'incoming') throw fail(404, 'Not found.');
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const ip = trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
      if (req.method === 'POST' && parts.length === 2 && ['login', 'unlock'].includes(parts[1])) {
        limit(`login:${ip}`, 30);
        const body = await json(req);
        if (parts[1] === 'login') {
          if (typeof body.password !== 'string' || !equal(body.password, adminSecret)) throw fail(401, 'Incorrect password.');
          send(200, { token: sign({ role: 'admin', exp: Date.now() + 8 * 3600000 }) }); return;
        }
        const row = typeof body.id === 'string' ? get(body.id) : null;
        const password = typeof body.password === 'string' && body.password.length <= 256 ? body.password : '';
        // Unknown IDs perform the same password derivation, avoiding a timing oracle.
        const hash = await passwordHash(password, row?.salt || 'unknown-invitation');
        if (!row || !equal(hash.toString('hex'), row.hash)) throw fail(401, 'Incorrect upload ID or password.');
        live(row);
        send(200, { token: sign({ role: 'client', id: row.id, exp: Date.now() + 7 * 86400000 }), upload: view(row) }); return;
      }
      if (parts[1] === 'admin') {
        verify(bearer, 'admin');
        if (parts.length === 2 && req.method === 'GET') { send(200, db.prepare('SELECT * FROM invites ORDER BY created DESC').all().map(view)); return; }
        if (parts.length === 2 && req.method === 'POST') {
          const b = await json(req);
          const maxSize = b.maxSize ?? 20 * GB, days = b.days ?? 7;
          if (!Number.isSafeInteger(maxSize) || maxSize < 1 || maxSize > 1000 * GB || !Number.isInteger(days) || days < 1 || days > 30 || typeof b.label !== 'string' || b.label.length > 120) throw fail(400, 'Use a label, 1–30 days and a file limit up to 1000 GB.');
          const used = db.prepare("SELECT COALESCE(SUM(CASE WHEN state='complete' THEN size ELSE max_size END),0) AS n FROM invites WHERE state='complete' OR expires>?").get(Date.now()).n;
          if (used + maxSize > quota) throw fail(507, 'Upload storage quota is reserved. Delete older invitations or files.');
          const id = randomUUID(), password = randomBytes(18).toString('base64url'), salt = randomBytes(16).toString('hex');
          const hash = (await passwordHash(password, salt)).toString('hex');
          // Password hashing yields; recheck quota before the synchronous insert.
          const reserved = db.prepare("SELECT COALESCE(SUM(CASE WHEN state='complete' THEN size ELSE max_size END),0) AS n FROM invites WHERE state='complete' OR expires>?").get(Date.now()).n;
          if (reserved + maxSize > quota) throw fail(507, 'Upload storage quota is reserved.');
          db.prepare('INSERT INTO invites(id,label,salt,hash,created,expires,max_size) VALUES(?,?,?,?,?,?,?)').run(id, b.label, salt, hash, Date.now(), Date.now() + days * 86400000, maxSize);
          send(201, { ...view(get(id)), password }); return;
        }
        const id = parts[2];
        if (!/^[a-f0-9-]{36}$/.test(id || '')) throw fail(404, 'Not found.');
        const row = get(id);
        if (!row) throw fail(404, 'Not found.');
        if (parts.length === 3 && req.method === 'DELETE') {
          await locked(id, async () => {
            db.prepare("UPDATE invites SET state='deleting' WHERE id=?").run(id);
            await rm(location(id, 'part'), { force: true }); await rm(location(id, 'file'), { force: true });
            db.prepare('DELETE FROM invites WHERE id=?').run(id);
          }); send(200, { ok: true }); return;
        }
        if (parts.length === 4 && parts[3] === 'download' && req.method === 'POST') {
          if (row.state !== 'complete') throw fail(409, 'No completed file.');
          send(200, { url: `/incoming/download/${id}?token=${sign({ role: 'download', id, exp: Date.now() + 3600000 })}` }); return;
        }
      }
      if (parts[1] === 'download' && parts.length === 3 && req.method === 'GET') {
        const id = parts[2]; verify(url.searchParams.get('token'), 'download', id);
        const row = get(id);
        if (!row || row.state !== 'complete') throw fail(404, 'File not found.');
        let start = 0, end = row.size - 1, status = 200;
        if (req.headers.range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!m || (!m[1] && !m[2])) throw fail(416, 'Invalid range.');
          if (!m[1]) start = Math.max(0, row.size - Number(m[2]));
          else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
          if (start > end || start >= row.size) { res.setHeader('Content-Range', `bytes */${row.size}`); throw fail(416, 'Invalid range.'); }
          status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${row.size}`);
        }
        res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="upload.zip"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()]/g, escape)}`);
        res.setHeader('Content-Length', row.size === 0 ? 0 : end - start + 1);
        res.writeHead(status);
        if (!row.size) res.end(); else await pipeline(createReadStream(location(id, 'file'), { start, end }), res);
        return;
      }
      if (parts[1] === 'client' && parts.length >= 3 && parts.length <= 4) {
        const id = parts[2]; verify(bearer, 'client', id);
        const row = get(id); live(row);
        if (parts.length === 3 && req.method === 'GET') { send(200, view(row)); return; }
        await locked(id, async () => {
          const current = get(id); live(current);
          if (parts[3] === 'start' && req.method === 'POST') {
            if (current.state === 'complete') throw fail(409, 'This invitation has already been used.');
            const b = await json(req);
            if (typeof b.filename !== 'string' || !b.filename.toLowerCase().endsWith('.zip') || b.filename.length > 240 || /[\/\\\x00-\x1f\x7f]/.test(b.filename) || !Number.isSafeInteger(b.size) || b.size < 1 || b.size > current.max_size || !/^[a-f0-9]{64}$/.test(b.fingerprint || '')) throw fail(400, 'Choose one ZIP file within the size limit.');
            if (current.state === 'uploading') {
              if (current.filename !== b.filename || current.size !== b.size || current.fingerprint !== b.fingerprint) throw fail(409, 'This invitation is already uploading another file. Select the original ZIP to resume.');
            } else db.prepare("UPDATE invites SET state='uploading',filename=?,size=?,fingerprint=? WHERE id=?").run(b.filename, b.size, b.fingerprint, id);
            send(200, view(get(id))); return;
          }
          if (parts[3] === 'chunk' && req.method === 'PUT') {
            if (current.state !== 'uploading') throw fail(409, 'This invitation cannot receive more files.');
            const offset = Number(req.headers['upload-offset']);
            if (req.headers['upload-offset'] === undefined || !Number.isSafeInteger(offset) || offset !== current.offset || offset >= current.size) throw fail(409, 'Upload offset changed. Check progress and retry.');
            const expected = Math.min(CHUNK, current.size - offset);
            const disk = await statfs(root);
            if (disk.bavail * disk.bsize < expected + 256 * 1024 * 1024) throw fail(507, 'Server storage is full. Contact Jordan.');
            let handle;
            try { handle = await open(location(id, 'part'), 'r+'); } catch (e) { if (e.code !== 'ENOENT' || offset !== 0) throw e; handle = await open(location(id, 'part'), 'w+', 0o600); }
            try {
              await handle.truncate(offset);
              let count = 0;
              for await (const chunk of req) {
                if (count + chunk.length > expected) throw fail(413, 'Chunk exceeds expected size.');
                let written = 0;
                while (written < chunk.length) { const r = await handle.write(chunk, written, chunk.length - written, offset + count + written); written += r.bytesWritten; }
                count += chunk.length;
              }
              if (count !== expected) throw fail(400, 'Incomplete chunk. Please retry.');
              await handle.sync();
              db.prepare('UPDATE invites SET offset=? WHERE id=?').run(offset + count, id);
            } finally { await handle.close(); }
            send(200, view(get(id))); return;
          }
          if (parts[3] === 'complete' && req.method === 'POST') { await complete(current); send(200, view(get(id))); return; }
          throw fail(404, 'Not found.');
        }); return;
      }
      throw fail(404, 'Not found.');
    } catch (e) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      if (e.status === 429) res.setHeader('Retry-After', '900');
      if (!e.status) console.error('Upload operation failed:', e.code || e.name);
      send(e.status || 500, { error: e.status ? e.message : 'Server error. Please retry or contact Jordan.' });
    }
  });
  // Each request carries at most 8 MiB; this is an inactivity timeout, not a whole-file deadline.
  server.requestTimeout = 0; server.headersTimeout = 30000; server.setTimeout(120000, socket => socket.destroy());
  server.on('close', () => { clearInterval(timer); db.close(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createUploadServer({ root: process.env.UPLOAD_ROOT || '/mnt/storage1/homeserver-uploads/data',
    adminSecret: process.env.UPLOAD_ADMIN_SECRET, signingKey: process.env.UPLOAD_SIGNING_KEY,
    origin: process.env.UPLOAD_SITE_ORIGIN || 'https://www.jordanettinger.com', trustProxy: true,
    quota: Number(process.env.UPLOAD_QUOTA_BYTES || 500 * GiB) });
  server.listen(Number(process.env.PORT || 8789), '127.0.0.1', () => console.log('Client upload service listening on loopback'));
}
