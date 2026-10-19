import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './index.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE transfers (id TEXT PRIMARY KEY, filename TEXT, filesize INTEGER, total_size INTEGER,
    r2_key TEXT, password_hash TEXT, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE transfer_files (id INTEGER PRIMARY KEY, transfer_id TEXT, filename TEXT, r2_key TEXT,
    filesize INTEGER, sort_order INTEGER, crc32 INTEGER);`);
  db.exec(readFileSync(new URL('./migrations/0001_transfer_storage.sql', import.meta.url), 'utf8'));
  const env = {
    ADMIN_SECRET: 'test-admin', PASSWORD_SALT: 'test-salt', HOMESERVER_URL: 'https://files.example', HOMESERVER_API_TOKEN: 'test-server-only',
    CF_ACCOUNT_ID: 'example', R2_BUCKET_NAME: 'example', R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret',
    BUCKET: { delete: async () => { throw Error('Homeserver must not touch R2'); } },
    DB: {
      prepare(sql) {
        let values = [];
        return { bind(...args) { values = args; return this; },
          async first() { return db.prepare(sql).get(...values) ?? null; },
          async all() { return { results: db.prepare(sql).all(...values) }; },
          async run() { return { meta: db.prepare(sql).run(...values) }; } };
      },
      async batch(statements) {
        db.exec('BEGIN');
        try { const results = []; for (const s of statements) results.push(await s.run()); db.exec('COMMIT'); return results; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    },
  };
  const requests = [];
  const ready = new Set();
  let failDelete = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://files.example');
    assert.equal(options.headers.Authorization, 'Bearer test-server-only');
    const body = options.body && JSON.parse(options.body);
    requests.push({ path: new URL(url).pathname, method: options.method, body });
    if (options.method === 'DELETE') return new Response(null, { status: failDelete ? 503 : 204 });
    if (String(url).endsWith('/health')) return Response.json({ ready: true });
    if (String(url).endsWith('/authorize')) return Response.json({ url: `https://files.example/capability/${body.object_id}` });
    if (String(url).endsWith('/files')) return Response.json({ object_ids: [...ready] });
    return Response.json({ ok: true });
  };
  async function api(path, method = 'GET', body, admin = true) {
    return worker.fetch(new Request(`https://worker.example/api/${path}`, {
      method, headers: { ...(admin ? { Authorization: 'Bearer test-admin' } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  }
  return { db, env, api, requests, ready, failDeletion: value => { failDelete = value; }, close() { globalThis.fetch = originalFetch; db.close(); } };
}

test('Cloudflare remains default, homeserver single upload/download stays behind password', async () => {
  const t = setup();
  try {
    let response = await t.api('transfer/create', 'POST', { filename: 'old.mov', filesize: 100, password: 'pass' });
    assert.equal(response.status, 200);
    const cf = await response.json();
    assert.equal(cf.storage_provider, 'cloudflare');
    assert.match(cf.uploadUrl, /r2.cloudflarestorage.com/);
    response = await t.api('transfer/create', 'POST', { filename: 'clip.mov', filesize: 6e9, password: 'pass', storage_provider: 'homeserver' });
    const hs = await response.json();
    assert.equal(response.status, 200);
    assert.equal(hs.storage_provider, 'homeserver');
    assert.match(hs.uploadUrl, /files.example/);
    assert.equal(t.requests.at(-1).body.filesize, 6e9);
    assert.equal((await t.api(`transfer/${hs.id}/download?password=wrong`, 'GET', undefined, false)).status, 403);
    const download = await t.api(`transfer/${hs.id}/download?password=pass`, 'GET', undefined, false);
    assert.equal(download.status, 200);
    assert.match((await download.json()).downloadUrl, /files.example/);
    const info = await (await t.api(`transfer/${hs.id}?password=pass`, 'GET', undefined, false)).json();
    assert.equal(info.storage_provider, undefined);
    const list = await (await t.api('transfers')).json();
    assert.deepEqual(new Set(list.map(x => x.storage_provider)), new Set(['cloudflare', 'homeserver']));
    const denied = await t.api('transfer/multipart/create', 'POST', { key: t.db.prepare('SELECT r2_key FROM transfers WHERE id=?').get(hs.id).r2_key });
    assert.equal(denied.status, 409);
  } finally { t.close(); }
});

test('folder files inherit hosting, pending uploads stay hidden, deletion waits for disk success', async () => {
  const t = setup();
  try {
    const { id } = await (await t.api('transfer/create-multi', 'POST', { name: 'Folder', password: 'pass', storage_provider: 'homeserver' })).json();
    assert.equal((await (await t.api(`transfer/${id}`)).json()).is_multi, true);
    const add = await t.api(`transfer/${id}/add-file`, 'POST', { filename: 'folder/clip.mov', filesize: 123 });
    assert.equal(add.status, 200);
    assert.equal((await add.json()).storage_provider, 'homeserver');
    const file = t.db.prepare('SELECT * FROM transfer_files').get();
    assert.equal((await (await t.api(`transfer/${id}/files?password=pass`, 'GET', undefined, false)).json()).files.length, 0);
    t.ready.add(file.r2_key.split('/').pop());
    const visible = await (await t.api(`transfer/${id}/files?password=pass`, 'GET', undefined, false)).json();
    assert.equal(visible.files.length, 1);
    assert.match(visible.files[0].url, /files.example/);
    t.failDeletion(true);
    assert.equal((await t.api(`transfer/${id}/file`, 'DELETE', { filename: file.filename })).status, 503);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM transfer_files').get().n, 1);
    assert.equal((await t.api(`transfer/${id}`, 'DELETE')).status, 503);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM transfers').get().n, 1);
    assert.equal((await t.api(`transfer/${id}/add-file`, 'POST', { filename: 'later', filesize: 0 })).status, 409);
    assert.equal((await t.api(`transfer/${id}/files?password=pass`, 'GET', undefined, false)).status, 409);
    t.failDeletion(false);
    assert.equal((await t.api(`transfer/${id}`, 'DELETE')).status, 200);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM transfers').get().n, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM transfer_files').get().n, 0);
  } finally { t.close(); }
});

test('capabilities require admin; unconfigured and invalid provider requests cannot create files', async () => {
  const t = setup();
  try {
    assert.equal((await t.api('transfer/capabilities', 'GET', undefined, false)).status, 401);
    assert.deepEqual((await (await t.api('transfer/capabilities')).json()).storage_providers, ['cloudflare', 'homeserver']);
    for (const filename of ['../escape', '/absolute', 'a\\b', 'a/%2e%2e/b']) {
      assert.equal((await t.api('transfer/create', 'POST', { filename, filesize: 0, password: 'pass', storage_provider: 'homeserver' })).status, 400);
    }
    assert.equal((await t.api('transfer/create-multi', 'POST', { name: 'bad', password: 'pass', storage_provider: 'other' })).status, 400);
    delete t.env.HOMESERVER_API_TOKEN;
    assert.deepEqual((await (await t.api('transfer/capabilities')).json()).storage_providers, ['cloudflare']);
    assert.equal((await t.api('transfer/create-multi', 'POST', { name: 'bad', password: 'pass', storage_provider: 'homeserver' })).status, 503);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM transfers').get().n, 0);
  } finally { t.close(); }
});

test('individual removal deletes the homeserver object and preserves its transfer', async () => {
  const t = setup();
  try {
    const { id } = await (await t.api('transfer/create-multi', 'POST', { name: 'Folder', password: 'pass', storage_provider: 'homeserver' })).json();
    const file = { filename: 'clip.mov', filesize: 123 };
    assert.equal((await t.api(`transfer/${id}/add-file`, 'POST', file)).status, 200);
    assert.equal((await t.api(`transfer/${id}/add-file`, 'POST', file)).status, 409);
    assert.equal((await t.api(`transfer/${id}`, 'PATCH', { storage_provider: 'cloudflare' })).status, 400);
    const objectId = t.db.prepare('SELECT r2_key FROM transfer_files').get().r2_key.split('/').pop();
    assert.equal((await t.api(`transfer/${id}/file`, 'DELETE', { filename: file.filename })).status, 200);
    assert.equal(t.requests.at(-1).path, `/v1/transfers/${id}/files/${objectId}`);
    assert.equal(t.requests.at(-1).method, 'DELETE');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM transfer_files').get().n, 0);
    assert.equal(t.db.prepare('SELECT total_size FROM transfers WHERE id=?').get(id).total_size, 0);
    assert.equal((await (await t.api(`transfer/${id}`)).json()).is_multi, true);
  } finally { t.close(); }
});
