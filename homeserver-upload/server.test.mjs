import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile, rename, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, scryptSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createUploadServer } from './server.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'client-upload-'));
  const config = { root, adminSecret: 'test-admin-password-long-enough', signingKey: 'test-signing-key-long-enough-for-hmac', ...options };
  if (options.setup) await options.setup(root);
  let server = await createUploadServer(config);
  const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await listen();
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); });
  async function request(route, method = 'GET', body, token, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/incoming${route}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, data: (res.headers.get('content-type') || '').includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  const admin = (await request('/login', 'POST', { password: config.adminSecret })).data.token;
  const invite = async (overrides = {}) => (await request('/admin', 'POST', { label: 'Client <test>', maxSize: 100, days: 7, ...overrides }, admin)).data;
  const unlock = async row => (await request('/unlock', 'POST', { id: row.id, password: row.password })).data.token;
  const start = (row, token, overrides = {}) => request(`/client/${row.id}/start`, 'POST', { filename: 'all-files.zip', size: 8, fingerprint: 'a'.repeat(64), ...overrides }, token);
  return { root, request, admin, invite, unlock, start,
    restart: async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); server = await createUploadServer(config); await listen(); } };
}

test('admin authentication, private listings, generated password and origin policy', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/admin')).status, 401);
  assert.equal((await f.request('/admin/capabilities')).status, 401);
  assert.deepEqual((await f.request('/admin/capabilities', 'GET', undefined, f.admin)).data, { apiVersion: 3, maxSize: 500000000000 });
  assert.equal((await f.request('/login', 'POST', { password: 'wrong' })).status, 401);
  const row = await f.invite(); assert.ok(row.password.length >= 24);
  const list = await f.request('/admin', 'GET', undefined, f.admin);
  assert.equal(list.data.length, 1); assert.equal(list.data[0].hash, undefined); assert.equal(list.data[0].password, undefined);
  assert.equal((await f.request('/admin', 'GET', undefined, f.admin, { Origin: 'https://evil.example' })).status, 403);
  const allowed = await f.request('/admin', 'OPTIONS', undefined, undefined, { Origin: 'https://www.jordanettinger.com' });
  assert.equal(allowed.status, 204); assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://www.jordanettinger.com');
});

test('a 12-character admin passphrase with spaces can sign in', async t => {
  const f = await fixture(t, { adminSecret: 'three words!' });
  assert.equal((await f.request('/admin', 'GET', undefined, f.admin)).status, 200);
  await assert.rejects(createUploadServer({ root: f.root, adminSecret: 'too short', signingKey: 'test-signing-key-long-enough-for-hmac' }), /adminSecret/);
});

test('one complete ZIP, exact downloaded bytes, range support and single-use enforcement', async t => {
  const f = await fixture(t), row = await f.invite(), token = await f.unlock(row);
  assert.equal((await f.start(row, token)).status, 200);
  const bytes = Buffer.from('PKabcdef');
  assert.equal((await f.request(`/client/${row.id}/chunk`, 'PUT', bytes, token, { 'Upload-Offset': '0' })).status, 200);
  assert.equal((await f.request(`/admin/${row.id}/download`, 'POST', undefined, f.admin)).status, 409);
  assert.equal((await f.request(`/client/${row.id}/complete`, 'POST', undefined, token)).data.state, 'complete');
  assert.equal((await f.request(`/client/${row.id}/complete`, 'POST', undefined, token)).status, 200);
  assert.equal((await f.start(row, token)).status, 409);
  assert.equal((await f.request(`/client/${row.id}/chunk`, 'PUT', bytes, token, { 'Upload-Offset': '0' })).status, 409);
  const download = (await f.request(`/admin/${row.id}/download`, 'POST', undefined, f.admin)).data.url.replace('/incoming', '');
  assert.deepEqual((await f.request(download)).data, bytes);
  const range = await f.request(download, 'GET', undefined, undefined, { Range: 'bytes=2-4' });
  assert.equal(range.status, 206); assert.deepEqual(range.data, Buffer.from('abc'));
  assert.equal((await f.request(download, 'GET', undefined, undefined, { Range: 'bytes=99-' })).status, 416);
  assert.equal((await f.request(`/admin/${row.id}`, 'DELETE', undefined, f.admin)).status, 200);
  assert.equal((await f.request(download)).status, 404);
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).status, 404);
});

test('partial and oversized chunks never advance durable offset; restart resumes original file', async t => {
  const f = await fixture(t), row = await f.invite(), token = await f.unlock(row);
  await f.start(row, token);
  assert.equal((await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('PK'), token, { 'Upload-Offset': '0' })).status, 400);
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).data.offset, 0);
  assert.equal((await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.alloc(9), token, { 'Upload-Offset': '0' })).status, 413);
  await f.restart();
  assert.equal((await f.start(row, token, { fingerprint: 'b'.repeat(64) })).status, 409);
  assert.equal((await f.start(row, token)).data.offset, 0);
  assert.equal((await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('PKabcdef'), token, { 'Upload-Offset': '0' })).status, 200);
  await f.restart();
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).data.offset, 8);
  assert.equal((await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('PKabcdef'), token, { 'Upload-Offset': '0' })).status, 409);
  assert.equal((await f.request(`/client/${row.id}/complete`, 'POST', undefined, token)).status, 200);
  assert.deepEqual(await readFile(path.join(f.root, `${row.id}.file`)), Buffer.from('PKabcdef'));
});

test('multiple chunks resume from the committed boundary and overwrite crash debris', async t => {
  const f = await fixture(t), row = await f.invite({ maxSize: 10 * 1024 ** 2 }), token = await f.unlock(row);
  await f.start(row, token, { size: 8 * 1024 ** 2 + 3 });
  const block = Buffer.alloc(8 * 1024 ** 2, 7);
  assert.equal((await f.request(`/client/${row.id}/chunk`, 'PUT', block, token, { 'Upload-Offset': '0' })).status, 200);
  await appendFile(path.join(f.root, `${row.id}.part`), 'crash debris');
  await f.restart();
  assert.equal((await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('end'), token, { 'Upload-Offset': String(block.length) })).status, 200);
  assert.equal((await f.request(`/client/${row.id}/complete`, 'POST', undefined, token)).status, 200);
  const result = await readFile(path.join(f.root, `${row.id}.file`));
  assert.equal(result.length, block.length + 3); assert.equal(result.subarray(-3).toString(), 'end');
});

test('tokens are scoped to invitation and role, forged tokens and wrong passwords fail', async t => {
  const f = await fixture(t), a = await f.invite(), b = await f.invite(), token = await f.unlock(a);
  assert.equal((await f.request(`/client/${b.id}`, 'GET', undefined, token)).status, 401);
  assert.equal((await f.request('/admin', 'GET', undefined, token)).status, 401);
  assert.equal((await f.request(`/client/${a.id}`, 'GET', undefined, token + 'x')).status, 401);
  assert.equal((await f.request('/unlock', 'POST', { id: a.id, password: 'incorrect' })).status, 401);
  assert.equal((await f.request('/unlock', 'POST', { id: 'unknown', password: 'incorrect' })).status, 401);
});

test('file validation rejects traversal, multiple-file payloads, oversize and non-ZIP names', async t => {
  const f = await fixture(t), row = await f.invite(), token = await f.unlock(row);
  for (const overrides of [{ filename: '../a.zip' }, { filename: 'a.mov' }, { filename: 'a\n.zip' }, { size: 101 }, { size: -1 }, { fingerprint: 'bad' }, { filename: ['a.zip', 'b.zip'] }]) {
    assert.equal((await f.start(row, token, overrides)).status, 400);
  }
  assert.equal((await f.request(`/client/${row.id}/complete`, 'POST', undefined, token)).status, 409);
});

test('quota reservations prevent uncontrolled disk allocations and deletion releases reservations', async t => {
  const f = await fixture(t, { quota: 100 });
  const row = await f.invite();
  assert.equal((await f.request('/admin', 'POST', { label: 'second', maxSize: 1, days: 7 }, f.admin)).status, 507);
  await f.request(`/admin/${row.id}`, 'DELETE', undefined, f.admin);
  assert.ok((await f.invite()).id);
});

test('500 decimal GB can be reserved and started; one byte over the maximum is rejected', async t => {
  const maxSize = 500 * 1000 ** 3;
  const f = await fixture(t, { quota: maxSize });
  assert.equal((await f.request('/admin', 'POST', { label: 'Too large', maxSize: maxSize + 1, days: 7 }, f.admin)).status, 400);
  const row = await f.invite({ maxSize });
  assert.equal(row.maxSize, 500000000000);
  const token = await f.unlock(row);
  const started = await f.start(row, token, { size: maxSize });
  assert.equal(started.status, 200);
  assert.equal(started.data.size, maxSize);
  assert.equal(started.data.offset, 0);
});

test('password attempts are rate limited', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 29; i++) await f.request('/login', 'POST', { password: 'bad' });
  const result = await f.request('/login', 'POST', { password: 'bad' });
  assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '900');
});

test('expired invitations reject writes and startup removes their partial data', async t => {
  const f = await fixture(t), row = await f.invite(), token = await f.unlock(row);
  await f.start(row, token);
  await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('PK'), token, { 'Upload-Offset': '0' });
  const db = new DatabaseSync(path.join(f.root, 'uploads.sqlite'));
  db.prepare('UPDATE invites SET expires=? WHERE id=?').run(Date.now() - 1000, row.id); db.close();
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).status, 410);
  assert.equal((await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('PKabcdef'), token, { 'Upload-Offset': '0' })).status, 410);
  await f.restart();
  await assert.rejects(stat(path.join(f.root, `${row.id}.part`)), { code: 'ENOENT' });
  assert.equal((await f.request('/admin', 'GET', undefined, f.admin)).data.length, 1);
});

test('crash after final rename recovers a complete sealed invitation', async t => {
  const f = await fixture(t), row = await f.invite(), token = await f.unlock(row);
  await f.start(row, token);
  await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('PKabcdef'), token, { 'Upload-Offset': '0' });
  await rename(path.join(f.root, `${row.id}.part`), path.join(f.root, `${row.id}.file`));
  await f.restart();
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).data.state, 'complete');
  assert.equal((await f.start(row, token)).status, 409);
});

test('simultaneous chunks cannot overwrite each other and deletion cannot resurrect data', async t => {
  const f = await fixture(t), row = await f.invite(), token = await f.unlock(row);
  await f.start(row, token);
  const results = await Promise.all([0, 1].map(() => f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('PKabcdef'), token, { 'Upload-Offset': '0' })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  await f.request(`/admin/${row.id}`, 'DELETE', undefined, f.admin);
  assert.equal((await f.request(`/client/${row.id}/complete`, 'POST', undefined, token)).status, 404);
  await f.restart();
  await assert.rejects(stat(path.join(f.root, `${row.id}.file`)), { code: 'ENOENT' });
});

test('custom client passwords work, stay hashed, and blank passwords still generate a password', async t => {
  const f = await fixture(t), row = await f.invite({ password: 'client project password' });
  assert.equal(row.password, 'client project password');
  assert.ok(await f.unlock(row));
  const details = await f.request(`/admin/${row.id}`, 'GET', undefined, f.admin);
  assert.equal(details.status, 200); assert.equal(details.data.password, undefined); assert.equal(details.data.hash, undefined);
  const db = new DatabaseSync(path.join(f.root, 'uploads.sqlite'));
  const stored = db.prepare('SELECT hash FROM invites WHERE id=?').get(row.id); db.close();
  assert.notEqual(stored.hash, row.password); assert.match(stored.hash, /^[a-f0-9]{64}$/);
  for (const password of ['   ', null, 12, 'a'.repeat(257), 'line\nbreak']) {
    assert.equal((await f.request('/admin', 'POST', { label: 'invalid', maxSize: 1, password }, f.admin)).status, 400);
  }
  assert.equal((await f.invite({ password: '' })).password.length, 24);
});

test('editing keeps the link and file progress; changing password revokes old sessions durably', async t => {
  const f = await fixture(t), row = await f.invite({ password: 'original' }), token = await f.unlock(row);
  await f.start(row, token);
  await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('PKabcdef'), token, { 'Upload-Offset': '0' });
  assert.equal((await f.request(`/admin/${row.id}`, 'PATCH', { label: 'Rename' }, token)).status, 401);
  assert.equal((await f.request(`/admin/${row.id}`, 'PATCH', { label: 'Rename' })).status, 401);
  const expires = Date.now() + 14 * 86400000;
  const updated = await f.request(`/admin/${row.id}`, 'PATCH', { label: 'New project', password: 'new client password', maxSize: 200, expires }, f.admin);
  assert.equal(updated.status, 200); assert.equal(updated.data.id, row.id); assert.equal(updated.data.offset, 8);
  assert.equal(updated.data.label, 'New project'); assert.equal(updated.data.maxSize, 200); assert.equal(updated.data.expires, expires);
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).status, 401);
  assert.equal((await f.request('/unlock', 'POST', { id: row.id, password: row.password })).status, 401);
  const nextToken = await f.unlock({ ...row, password: 'new client password' });
  await f.restart();
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, nextToken)).data.offset, 8);
  assert.equal((await f.request(`/client/${row.id}/complete`, 'POST', undefined, nextToken)).status, 200);
  assert.deepEqual(await readFile(path.join(f.root, `${row.id}.file`)), Buffer.from('PKabcdef'));
});

test('edits validate quota and selected ZIP size without partial updates or reopening completion', async t => {
  const f = await fixture(t, { quota: 300 }), row = await f.invite({ password: 'original' }), token = await f.unlock(row);
  await f.invite();
  const failed = await f.request(`/admin/${row.id}`, 'PATCH', { label: 'Should not save', maxSize: 250, password: 'should not save' }, f.admin);
  assert.equal(failed.status, 507);
  assert.equal((await f.request(`/admin/${row.id}`, 'GET', undefined, f.admin)).data.label, row.label);
  assert.ok(await f.unlock(row));
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).status, 200);
  await f.start(row, token);
  assert.equal((await f.request(`/admin/${row.id}`, 'PATCH', { maxSize: 7 }, f.admin)).status, 409);
  for (const body of [{ state: 'waiting' }, { id: 'replacement' }, { label: '' }, { expires: Date.now() - 1000 }, { maxSize: 500000000001 }, { password: ' ' }]) {
    assert.equal((await f.request(`/admin/${row.id}`, 'PATCH', body, f.admin)).status, 400);
  }
  await f.request(`/client/${row.id}/chunk`, 'PUT', Buffer.from('PKabcdef'), token, { 'Upload-Offset': '0' });
  await f.request(`/client/${row.id}/complete`, 'POST', undefined, token);
  assert.equal((await f.request(`/admin/${row.id}`, 'PATCH', { label: 'Delivered', password: 'changed' }, f.admin)).data.state, 'complete');
  const updatedToken = await f.unlock({ ...row, password: 'changed' });
  assert.equal((await f.start(row, updatedToken)).status, 409);
  assert.equal((await f.request(`/admin/${row.id}/download`, 'POST', undefined, f.admin)).status, 200);
});

test('blank edit passwords preserve sessions and expired waiting invitations can be renewed', async t => {
  const f = await fixture(t), row = await f.invite(), token = await f.unlock(row);
  assert.equal((await f.request(`/admin/${row.id}`, 'PATCH', { label: 'New name', password: '' }, f.admin)).status, 200);
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).status, 200);
  const db = new DatabaseSync(path.join(f.root, 'uploads.sqlite'));
  db.prepare('UPDATE invites SET expires=? WHERE id=?').run(Date.now() - 1000, row.id); db.close();
  assert.equal((await f.request(`/admin/${row.id}`, 'PATCH', { expires: Date.now() + 86400000 }, f.admin)).status, 200);
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).status, 200);
  await f.start(row, token);
  const db2 = new DatabaseSync(path.join(f.root, 'uploads.sqlite'));
  db2.prepare('UPDATE invites SET expires=? WHERE id=?').run(Date.now() - 1000, row.id); db2.close();
  await f.restart();
  assert.equal((await f.request(`/admin/${row.id}`, 'PATCH', { expires: Date.now() + 86400000 }, f.admin)).status, 409);
});

test('existing SQLite installations migrate additively and legacy sessions revoke after a password change', async t => {
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const f = await fixture(t, { setup: async root => {
    const db = new DatabaseSync(path.join(root, 'uploads.sqlite'));
    db.exec(`CREATE TABLE invites (id TEXT PRIMARY KEY, label TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
      created INTEGER NOT NULL, expires INTEGER NOT NULL, max_size INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting', filename TEXT, size INTEGER, offset INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT, completed INTEGER);`);
    db.prepare('INSERT INTO invites(id,label,salt,hash,created,expires,max_size) VALUES(?,?,?,?,?,?,?)').run(id, 'Existing', 'salt', scryptSync('original', 'salt', 32).toString('hex'), Date.now(), Date.now() + 86400000, 100);
    db.close();
  } });
  const payload = Buffer.from(JSON.stringify({ role: 'client', id, exp: Date.now() + 86400000 })).toString('base64url');
  const token = `${payload}.${createHmac('sha256', 'test-signing-key-long-enough-for-hmac').update(payload).digest('base64url')}`;
  assert.equal((await f.request(`/client/${id}`, 'GET', undefined, token)).status, 200);
  assert.equal((await f.request(`/admin/${id}`, 'PATCH', { password: 'replacement' }, f.admin)).status, 200);
  assert.equal((await f.request(`/client/${id}`, 'GET', undefined, token)).status, 401);
  await f.restart();
  assert.equal((await f.request(`/client/${id}`, 'GET', undefined, token)).status, 401);
  assert.ok(await f.unlock({ id, password: 'replacement' }));
});

test('full invitation copying is admin-only and passwords are encrypted at rest across restarts', async t => {
  const f = await fixture(t), row = await f.invite({ password: 'client project password' }), token = await f.unlock(row);
  assert.equal((await f.request(`/admin/${row.id}/invitation`, 'POST', {})).status, 401);
  assert.equal((await f.request(`/admin/${row.id}/invitation`, 'POST', {}, token)).status, 401);
  await f.restart();
  const invite = await f.request(`/admin/${row.id}/invitation`, 'POST', {}, f.admin);
  assert.equal(invite.status, 200); assert.equal(invite.data.password, row.password); assert.equal(invite.data.id, row.id);
  assert.equal((await f.request(`/admin/${row.id}`, 'GET', undefined, f.admin)).data.password_box, undefined);
  const db = new DatabaseSync(path.join(f.root, 'uploads.sqlite'));
  const box = db.prepare('SELECT password_box FROM invites WHERE id=?').get(row.id).password_box; db.close();
  assert.match(box, /^v1\./); assert.ok(!box.includes(row.password));
  await f.request(`/admin/${row.id}`, 'PATCH', { password: 'new password' }, f.admin);
  assert.equal((await f.request(`/admin/${row.id}/invitation`, 'POST', {}, f.admin)).data.password, 'new password');
});

test('legacy invitations require the correct password once without changing their client sessions', async t => {
  const f = await fixture(t), row = await f.invite({ password: 'original password' }), token = await f.unlock(row);
  const db = new DatabaseSync(path.join(f.root, 'uploads.sqlite'));
  db.prepare('UPDATE invites SET password_box=NULL WHERE id=?').run(row.id); db.close();
  const missing = await f.request(`/admin/${row.id}/invitation`, 'POST', {}, f.admin);
  assert.equal(missing.status, 409); assert.equal(missing.data.code, 'password_required');
  assert.equal((await f.request(`/admin/${row.id}/invitation`, 'POST', { password: 'wrong password' }, f.admin)).status, 400);
  assert.equal((await f.request(`/admin/${row.id}/invitation`, 'POST', { password: row.password }, f.admin)).data.password, row.password);
  assert.equal((await f.request(`/client/${row.id}`, 'GET', undefined, token)).status, 200);
  await f.restart();
  assert.equal((await f.request(`/admin/${row.id}/invitation`, 'POST', {}, f.admin)).data.password, row.password);
});

test('encrypted passwords cannot be moved between invitation IDs', async t => {
  const f = await fixture(t), a = await f.invite({ password: 'first password' }), b = await f.invite({ password: 'second password' });
  const db = new DatabaseSync(path.join(f.root, 'uploads.sqlite'));
  db.prepare('UPDATE invites SET password_box=(SELECT password_box FROM invites WHERE id=?) WHERE id=?').run(a.id, b.id); db.close();
  assert.equal((await f.request(`/admin/${b.id}/invitation`, 'POST', {}, f.admin)).data.code, 'password_required');
  assert.equal((await f.request(`/admin/${b.id}/invitation`, 'POST', { password: b.password }, f.admin)).data.password, b.password);
});
