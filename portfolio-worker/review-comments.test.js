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

const commentSource = html.slice(html.indexOf('function renderComments('), html.indexOf('async function updateCommentStatus('));
for (const admin of [false, true]) {
  test(`threads group replies without timestamps and offer Reply for every comment (${admin})`, () => {
    const list = { innerHTML: '' };
    runInNewContext(`${commentSource}\nrenderComments()`, {
      commentsCache: [
        { id: 1, author: 'Client', body: 'First note', timestamp_seconds: 8 },
        { id: 2, parent_id: 1, author: 'Jordan', body: '<reply>', timestamp_seconds: null },
        { id: 3, author: 'Client', body: 'Second note', timestamp_seconds: 20 },
        { id: 4, parent_id: 1, author: 'Client', body: 'Follow-up', timestamp_seconds: null },
      ],
      adminToken: admin ? 'admin' : null, activeReplyId: null,
      document: { getElementById: () => list },
      esc: s => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      formatTime: seconds => { assert.notEqual(seconds, null); return `0:${seconds}`; },
    });
    assert.equal((list.innerHTML.match(/>Reply<\/button>/g) || []).length, 4);
    assert.equal((list.innerHTML.match(/class="rv-comment-ts"/g) || []).length, 2);
    assert.equal((list.innerHTML.match(/class="rv-comment rv-comment-reply"/g) || []).length, 2);
    assert.ok(list.innerHTML.indexOf('comment-4') < list.innerHTML.indexOf('comment-3'));
    assert.match(list.innerHTML, /&lt;reply&gt;/);
    assert.equal(list.innerHTML.includes('Delete comment'), admin);
    assert.doesNotMatch(list.innerHTML, /id="comment-2" onclick/);
  });
}

for (const fails of [false, true]) {
  test(`reply submission omits video time and preserves failed drafts (${fails})`, async () => {
    const requests = [], alerts = [];
    let reloads = 0;
    const context = {
      replyDraft: ' My reply ', replyAuthor: ' Jordan ', replySubmitting: false, activeReplyId: 2,
      currentVideo: { stream_uid: 'video' }, WORKER_URL: '',
      renderComments() {}, document: { getElementById: () => null },
      fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: !fails, json: async () => ({ id: 5 }) }; },
      loadComments: async () => { reloads++; }, alert: message => alerts.push(message),
      event: { preventDefault() {}, stopPropagation() {} },
    };
    const submitSource = commentSource.slice(commentSource.indexOf('async function submitReply('));
    await runInNewContext(`${submitSource}\nsubmitReply(event, 2)`, context);
    assert.deepEqual(requests, [{ video_id: 'video', parent_id: 2, author: 'Jordan', text: 'My reply' }]);
    assert.equal(context.replySubmitting, false);
    assert.equal(context.replyDraft, fails ? ' My reply ' : '');
    assert.equal(context.activeReplyId, fails ? 2 : null);
    assert.equal(reloads, fails ? 0 : 1);
    assert.equal(alerts.length, fails ? 1 : 0);
  });
}
