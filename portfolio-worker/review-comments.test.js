import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext, Script } from 'node:vm';

const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('async function loadComments('), html.indexOf('function renderComments('));

test('review inline scripts parse', () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Script(match[1]);
});

for (const admin of [true, false]) {
  test(`viewing a video marks all new comments seen only for admins (${admin})`, async () => {
    const comments = [{ id: 1, admin_seen: 0 }, { id: 2, admin_seen: 1 }, { id: 3, admin_seen: 0 }];
    const updates = [];
    const context = {
      adminToken: admin ? 'token' : null, currentVideo: { stream_uid: 'video' },
      WORKER_URL: 'https://example.com', commentsCache: [],
      document: { getElementById: () => ({ innerHTML: '' }) },
      fetch: async () => ({ ok: true, json: async () => comments }),
      updateCommentStatus: async (id, status) => updates.push([id, status.admin_seen]),
      renderComments() {}, alert(message) { assert.fail(message); },
    };
    await runInNewContext(`${source}\nloadComments('video')`, context);
    assert.deepEqual(updates, admin ? [[1, true], [3, true]] : []);
    assert.deepEqual(comments.map(c => c.admin_seen), admin ? [1, 1, 1] : [0, 1, 0]);
  });
}

test('failed status saves retain new labels and report the failure', async () => {
  const comments = [{ id: 1, admin_seen: 0 }, { id: 2, admin_seen: 0 }];
  const alerts = [];
  await runInNewContext(`${source}\nloadComments('video')`, {
    adminToken: 'token', currentVideo: { stream_uid: 'video' }, WORKER_URL: '', commentsCache: [],
    document: { getElementById: () => ({ innerHTML: '' }) },
    fetch: async () => ({ ok: true, json: async () => comments }),
    updateCommentStatus: async id => { if (id === 2) throw new Error('offline'); },
    renderComments() {}, alert: message => alerts.push(message),
  });
  assert.deepEqual(comments.map(c => c.admin_seen), [1, 0]);
  assert.equal(alerts.length, 1);
});
