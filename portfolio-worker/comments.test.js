import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './index.js';

test('comment status persists, updates video counts, and stays private to admins', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE comments (id INTEGER PRIMARY KEY, video_id TEXT, timestamp_seconds REAL,
    author TEXT, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE videos (stream_uid TEXT, title TEXT, description TEXT, created_at TEXT, review_id TEXT);
    CREATE TABLE reviews (id TEXT, password_hash TEXT, name TEXT, created_at TEXT);
    INSERT INTO videos VALUES ('video', 'Cut 1', '', '2026-11-03', 'project');`);
  db.exec(readFileSync(new URL('./migrations/0002_comment_status.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./migrations/0003_comment_digests.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./migrations/0004_comment_replies.sql', import.meta.url), 'utf8'));
  const env = { ADMIN_SECRET: 'admin', DB: { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { ...result, last_row_id: Number(result.lastInsertRowid) } }; } };
  } } };
  async function api(path, method = 'GET', body, admin = true) {
    return worker.fetch(new Request(`https://example.com/api/${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: 'Bearer admin' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  }
  async function counts() {
    const response = await api('review/project/videos');
    assert.equal(response.status, 200);
    const [v] = await response.json();
    return [v.comment_count, v.new_comment_count, v.completed_comment_count];
  }
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('je-review-2026client-pass'));
    db.prepare('INSERT INTO reviews (id, password_hash) VALUES (?, ?)').run('project', Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''));
    const created = await api('comments', 'POST', { video_id: 'video', timestamp_seconds: 8, text: 'Revise', author: 'Client', completed: true }, false);
    assert.equal(created.status, 201);
    const { id } = await created.json();
    assert.deepEqual(await counts(), [1, 1, 0]);
    assert.equal((await (await api('reviews')).json())[0].new_comment_count, 1);
    assert.equal((await api('reviews', 'GET', undefined, false)).status, 401);
    const clientVideosResponse = await api('review/project/videos?password=client-pass', 'GET', undefined, false);
    assert.equal(clientVideosResponse.status, 200);
    const [clientVideo] = await clientVideosResponse.json();
    for (const field of ['comment_count', 'new_comment_count', 'completed_comment_count']) {
      assert.equal(field in clientVideo, false);
    }
    const [publicComment] = await (await api('comments/video', 'GET', undefined, false)).json();
    assert.equal('admin_seen' in publicComment, false);
    assert.equal('completed' in publicComment, false);
    assert.equal((await api(`comments/${id}`, 'PATCH', { completed: true }, false)).status, 401);
    assert.equal((await api(`comments/${id}`, 'PATCH', { completed: 'yes' })).status, 400);
    assert.equal((await api(`comments/${id}`, 'PATCH', { admin_seen: true })).status, 200);
    assert.deepEqual(await counts(), [1, 0, 0]);
    assert.equal((await (await api('reviews')).json())[0].new_comment_count, 0);
    assert.equal((await api(`comments/${id}`, 'PATCH', { completed: true })).status, 200);
    assert.deepEqual(await counts(), [1, 0, 1]);
    const [saved] = await (await api('comments/video')).json();
    assert.equal(saved.admin_seen, 1);
    assert.equal(saved.completed, 1);
    await api(`comments/${id}`, 'PATCH', { completed: false });
    assert.deepEqual(await counts(), [1, 0, 0]);
    assert.equal((await api('comments/999', 'PATCH', { completed: true })).status, 404);
    for (const admin of [false, true]) {
      const response = await api('comments', 'POST', { video_id: 'video', parent_id: id, text: 'A reply', author: 'Reviewer' }, admin);
      assert.equal(response.status, 201);
    }
    const thread = await (await api('comments/video', 'GET', undefined, false)).json();
    assert.equal(thread.length, 3);
    assert.equal(thread[0].parent_id, null);
    assert.equal(thread[0].timestamp_seconds, 8);
    for (const reply of thread.slice(1)) {
      assert.equal(reply.parent_id, id);
      assert.equal(reply.timestamp_seconds, null);
      assert.equal('admin_seen' in reply, false);
      assert.equal('completed' in reply, false);
    }
    const nested = await api('comments', 'POST', { video_id: 'video', parent_id: thread[1].id, text: 'Reply to reply' }, false);
    assert.equal(nested.status, 201);
    const nestedId = (await nested.json()).id;
    assert.equal((await (await api('comments/video')).json()).find(c => c.id === nestedId).parent_id, id);
    assert.deepEqual(await counts(), [4, 3, 0]);
    for (const parent_id of [0, -1, '1', 1.5]) {
      assert.equal((await api('comments', 'POST', { video_id: 'video', parent_id, text: 'Invalid' }, false)).status, 400);
    }
    assert.equal((await api('comments', 'POST', { video_id: 'other-video', parent_id: id, text: 'Wrong video' }, false)).status, 404);
    assert.equal((await api('comments', 'POST', { video_id: 'video', parent_id: 9999, text: 'Missing parent' }, false)).status, 404);
    assert.equal((await api('comments', 'POST', { video_id: 'video', parent_id: id, text: '  ' }, false)).status, 400);
    assert.equal((await api(`comments/${thread[1].id}`, 'DELETE', undefined, false)).status, 401);
    await api(`comments/${thread[1].id}`, 'DELETE');
    assert.deepEqual(await counts(), [3, 2, 0]);
    await api(`comments/${id}`, 'DELETE');
    assert.deepEqual(await counts(), [0, 0, 0]);
  } finally { db.close(); }
});
