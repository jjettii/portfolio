import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sendCommentDigests } from './digests.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE reviews (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE videos (stream_uid TEXT PRIMARY KEY, review_id TEXT, title TEXT, created_at TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT, timestamp_seconds REAL,
      author TEXT, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO reviews VALUES ('a','Project A'), ('b','Project B');
    INSERT INTO videos VALUES ('a1','a','Cut 1','2026-11-03'), ('a2','a','Cut 2','2026-11-03'), ('b1','b','Other video','2026-11-03');
    INSERT INTO comments (video_id, timestamp_seconds, author, body) VALUES ('a1',8,'Michael','Old comment');`);
  db.exec(readFileSync(new URL('./migrations/0002_comment_status.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./migrations/0003_comment_digests.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./migrations/0004_comment_replies.sql', import.meta.url), 'utf8'));
  const messages = [];
  const env = { COMMENT_DIGEST_ENABLED: 'true', COMMENT_DIGEST_TO: 'owner@example.com',
    COMMENT_DIGEST_FROM: 'reviews@notify.example.com', REVIEW_SITE_URL: 'https://example.com',
    COMMENT_EMAIL: { async send(message) { messages.push(message); } },
    DB: { prepare(sql) {
      let args = [];
      return { bind(...values) { args = values; return this; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { return { meta: db.prepare(sql).run(...args) }; } };
    }, async batch(statements) {
      db.exec('BEGIN');
      try { const result = []; for (const s of statements) result.push(await s.run()); db.exec('COMMIT'); return result; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    } },
  };
  function add(video, now, body = 'New feedback') {
    const result = db.prepare('INSERT INTO comments(video_id,timestamp_seconds,author,body) VALUES (?,8,?,?)').run(video, 'Michael', body);
    db.prepare('UPDATE comment_digest_projects SET last_comment_at = ? WHERE project_id = (SELECT review_id FROM videos WHERE stream_uid = ?)').run(now, video);
    return Number(result.lastInsertRowid);
  }
  return { db, env, messages, add };
}

test('30-minute quiet period resets across videos in a project; projects send independently', async () => {
  const { db, env, messages, add } = setup();
  try {
    await sendCommentDigests(env, 10000);
    assert.equal(messages.length, 0); // No backlog from before the migration.
    add('a1', 10000, 'First feedback');
    add('b1', 10000);
    await sendCommentDigests(env, 11799);
    assert.equal(messages.length, 0);
    add('a2', 11799, 'Second feedback');
    await sendCommentDigests(env, 11800);
    assert.equal(messages.length, 1);
    assert.match(messages[0].subject, /Project B/);
    await sendCommentDigests(env, 13598);
    assert.equal(messages.length, 1);
    await sendCommentDigests(env, 13599);
    assert.equal(messages.length, 2);
    const message = messages[1];
    assert.match(message.text, /2 new comments on Project A/);
    assert.match(message.text, /Cut 1/);
    assert.match(message.text, /Cut 2/);
    assert.match(message.text, /Michael at 0:08/);
    assert.match(message.text, /https:\/\/example.com\/review\/\?id=a/);
    assert.doesNotMatch(message.text, /Old comment/);
    assert.equal(message.to, 'owner@example.com');
    await sendCommentDigests(env, 20000);
    assert.equal(messages.length, 2);
  } finally { db.close(); }
});

test('failed delivery retries; comments arriving during delivery stay queued for their own quiet period', async () => {
  const { db, env, messages, add } = setup();
  try {
    add('a1', 10000);
    env.COMMENT_EMAIL.send = async () => { throw new Error('temporary outage'); };
    await sendCommentDigests(env, 11800);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM comment_digest_outbox').get().n, 1);
    env.COMMENT_EMAIL.send = async message => { messages.push(message); add('a2', 12100, 'Arrived during delivery'); };
    await sendCommentDigests(env, 12099);
    assert.equal(messages.length, 0);
    await sendCommentDigests(env, 12100);
    assert.equal(messages.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM comment_digest_outbox').get().n, 1);
    env.COMMENT_EMAIL.send = async message => messages.push(message);
    await sendCommentDigests(env, 13899);
    assert.equal(messages.length, 1);
    await sendCommentDigests(env, 13900);
    assert.equal(messages.length, 2);
    assert.match(messages[1].text, /Arrived during delivery/);
  } finally { db.close(); }
});

test('overlapping runs do not duplicate delivery; deleted comments are omitted; status stays unchanged', async () => {
  const { db, env, messages, add } = setup();
  try {
    const deleted = add('a1', 10000, 'Deleted feedback');
    db.prepare('DELETE FROM comments WHERE id = ?').run(deleted);
    const kept = add('a2', 10000, 'Kept feedback');
    db.prepare('UPDATE comments SET admin_seen = 1, completed = 1 WHERE id = ?').run(kept);
    env.COMMENT_EMAIL.send = async message => {
      await sendCommentDigests(env, 11800);
      messages.push(message);
    };
    await sendCommentDigests(env, 11800);
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0].text, /Deleted feedback/);
    assert.match(messages[0].text, /Kept feedback/);
    assert.deepEqual({ ...db.prepare('SELECT admin_seen, completed FROM comments WHERE id = ?').get(kept) }, { admin_seen: 1, completed: 1 });
    add('b1', 12000);
    db.prepare('DELETE FROM reviews WHERE id = ?').run('b');
    await sendCommentDigests(env, 14000);
    assert.equal(messages.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM comment_digest_outbox').get().n, 0);
  } finally { db.close(); }
});

test('disabled delivery leaves pending comments queued', async () => {
  const { db, env, messages, add } = setup();
  try {
    add('a1', 10000);
    env.COMMENT_DIGEST_ENABLED = 'false';
    await sendCommentDigests(env, 11800);
    assert.equal(messages.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM comment_digest_outbox').get().n, 1);
  } finally { db.close(); }
});
