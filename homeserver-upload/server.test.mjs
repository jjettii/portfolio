import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile, rename, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createUploadServer } from './server.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'client-upload-'));
  const config = { root, adminSecret: 'test-admin-password-long-enough', signingKey: 'test-signing-key-long-enough-for-hmac', ...options };
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

test('1000 decimal GB can be reserved and started; one byte over the maximum is rejected', async t => {
  const maxSize = 1000 * 1000 ** 3;
  const f = await fixture(t, { quota: maxSize });
  assert.equal((await f.request('/admin', 'POST', { label: 'Too large', maxSize: maxSize + 1, days: 7 }, f.admin)).status, 400);
  const row = await f.invite({ maxSize });
  assert.equal(row.maxSize, 1000000000000);
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
