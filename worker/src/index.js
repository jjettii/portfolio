import { AwsClient } from 'aws4fetch';

// ─── Constants ───────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const UPLOAD_EXPIRY = 7200;   // 2 hours for upload window
const DOWNLOAD_EXPIRY = 3600; // 1 hour for download links

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}

function requireAdmin(request, env) {
  if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  return null;
}

async function hashPassword(password, env) {
  const salt = env.PASSWORD_SALT || 'je-review-2026';
  const data = new TextEncoder().encode(salt + password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getPresignedUrl(env, r2Key, method, expireSeconds) {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });

  const url = new URL(
    `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${r2Key}`
  );
  url.searchParams.set('X-Amz-Expires', String(expireSeconds));

  const signed = await client.sign(new Request(url.toString(), { method }), {
    aws: { signQuery: true, allHeaders: true },
  });

  return signed.url;
}

// ─── Transfer Handlers ───────────────────────────────────────────────────────

async function handleTransferCreate(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { filename, filesize, description, password } = body;
  if (!filename || !password) return json({ error: 'filename and password are required' }, 400);

  const id = crypto.randomUUID();
  const r2Key = `transfers/${id}/${filename}`;
  const passwordHash = await hashPassword(password, env);

  await env.DB.prepare(
    `INSERT INTO transfers (id, filename, filesize, r2_key, password_hash, description)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, filename, filesize || null, r2Key, passwordHash, description || null).run();

  const uploadUrl = await getPresignedUrl(env, r2Key, 'PUT', UPLOAD_EXPIRY);

  return json({ id, uploadUrl });
}

async function handleTransferInfo(request, env, id) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';

  const row = await env.DB.prepare(
    `SELECT id, filename, filesize, description, created_at, password_hash FROM transfers WHERE id = ?`
  ).bind(id).first();

  if (!row) return json({ error: 'Transfer not found' }, 404);

  const hash = await hashPassword(password, env);
  if (hash !== row.password_hash) return json({ error: 'Invalid password' }, 403);

  return json({
    id: row.id,
    filename: row.filename,
    filesize: row.filesize,
    description: row.description,
    created_at: row.created_at,
  });
}

async function handleTransferDownload(request, env, id) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';

  const row = await env.DB.prepare(
    `SELECT filename, r2_key, password_hash FROM transfers WHERE id = ?`
  ).bind(id).first();

  if (!row) return json({ error: 'Transfer not found' }, 404);

  const hash = await hashPassword(password, env);
  if (hash !== row.password_hash) return json({ error: 'Invalid password' }, 403);

  const downloadUrl = await getPresignedUrl(env, row.r2_key, 'GET', DOWNLOAD_EXPIRY);

  return json({ downloadUrl, filename: row.filename });
}

async function handleTransferList(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    `SELECT id, filename, filesize, description, created_at
     FROM transfers ORDER BY created_at DESC`
  ).all();

  return json(results);
}

async function handleTransferDelete(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  const row = await env.DB.prepare(`SELECT r2_key FROM transfers WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'Transfer not found' }, 404);

  await env.BUCKET.delete(row.r2_key);
  await env.DB.prepare(`DELETE FROM transfers WHERE id = ?`).bind(id).run();

  return json({ ok: true });
}

// ─── Review Handlers ─────────────────────────────────────────────────────────

async function handleReviewCreate(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { name, password } = body;
  if (!name || !password) return json({ error: 'name and password are required' }, 400);

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password, env);

  await env.DB.prepare(
    `INSERT INTO reviews (id, name, password_hash) VALUES (?, ?, ?)`
  ).bind(id, name, passwordHash).run();

  return json({ id });
}

async function handleReviewList(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.name, r.created_at,
            COUNT(v.stream_uid) AS video_count
     FROM reviews r
     LEFT JOIN videos v ON v.review_id = r.id
     GROUP BY r.id
     ORDER BY r.created_at DESC`
  ).all();

  return json(results);
}

async function handleReviewInfo(request, env, id) {
  if (isAdmin(request, env)) {
    const row = await env.DB.prepare(
      `SELECT id, name, created_at FROM reviews WHERE id = ?`
    ).bind(id).first();
    if (!row) return json({ error: 'Review not found' }, 404);
    return json(row);
  }

  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';

  const row = await env.DB.prepare(
    `SELECT id, name, created_at, password_hash FROM reviews WHERE id = ?`
  ).bind(id).first();

  if (!row) return json({ error: 'Review not found' }, 404);

  const hash = await hashPassword(password, env);
  if (hash !== row.password_hash) return json({ error: 'Invalid ID or password.' }, 403);

  return json({ id: row.id, name: row.name, created_at: row.created_at });
}

async function handleReviewUpdate(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const row = await env.DB.prepare(`SELECT id FROM reviews WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'Review not found' }, 404);

  const updates = [];
  const values = [];

  if (body.name) { updates.push('name = ?'); values.push(body.name); }
  if (body.password) { updates.push('password_hash = ?'); values.push(await hashPassword(body.password, env)); }

  if (!updates.length) return json({ error: 'Nothing to update' }, 400);

  values.push(id);
  await env.DB.prepare(`UPDATE reviews SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();

  return json({ ok: true });
}

async function handleReviewDelete(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  const { results: videos } = await env.DB.prepare(
    `SELECT stream_uid FROM videos WHERE review_id = ?`
  ).bind(id).all();

  for (const v of videos) {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/${v.stream_uid}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}` } }
    );
    await env.DB.prepare(`DELETE FROM comments WHERE video_id = ?`).bind(v.stream_uid).run();
    await env.DB.prepare(`DELETE FROM videos WHERE stream_uid = ?`).bind(v.stream_uid).run();
  }

  await env.DB.prepare(`DELETE FROM reviews WHERE id = ?`).bind(id).run();

  return json({ ok: true });
}

async function handleReviewVideos(request, env, id) {
  if (!isAdmin(request, env)) {
    const url = new URL(request.url);
    const password = url.searchParams.get('password') || '';

    const row = await env.DB.prepare(
      `SELECT password_hash FROM reviews WHERE id = ?`
    ).bind(id).first();

    if (!row) return json({ error: 'Review not found' }, 404);

    const hash = await hashPassword(password, env);
    if (hash !== row.password_hash) return json({ error: 'Invalid password' }, 403);
  }

  const { results } = await env.DB.prepare(
    `SELECT stream_uid, title, description, created_at
     FROM videos WHERE review_id = ? ORDER BY created_at ASC`
  ).bind(id).all();

  return json(results);
}

// ─── Stream Handlers ─────────────────────────────────────────────────────────

async function handleStreamUploadCreate(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { title, description, review_id } = body;
  if (!title) return json({ error: 'title is required' }, 400);
  if (!review_id) return json({ error: 'review_id is required' }, 400);

  const reviewRow = await env.DB.prepare(`SELECT id FROM reviews WHERE id = ?`).bind(review_id).first();
  if (!reviewRow) return json({ error: 'Review not found' }, 404);

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/direct_upload`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STREAM_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        maxDurationSeconds: 7200,
        requireSignedURLs: false,
        meta: { name: title },
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    return json({ error: 'Stream API error', detail: text }, 502);
  }

  const { result } = await resp.json();
  const uploadUrl = result.uploadURL;
  const streamUid = result.uid;

  await env.DB.prepare(
    `INSERT INTO videos (stream_uid, title, description, review_id) VALUES (?, ?, ?, ?)`
  ).bind(streamUid, title, description || null, review_id).run();

  return json({ uploadUrl, streamUid });
}

async function handleStreamVideoList(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    `SELECT stream_uid, title, description, review_id, created_at FROM videos ORDER BY created_at DESC`
  ).all();

  return json(results);
}

async function handleStreamVideoDelete(request, env, streamUid) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/${streamUid}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}` },
    }
  );

  await env.DB.prepare(`DELETE FROM comments WHERE video_id = ?`).bind(streamUid).run();
  await env.DB.prepare(`DELETE FROM videos WHERE stream_uid = ?`).bind(streamUid).run();

  return json({ ok: true });
}

// ─── Comment Handlers ────────────────────────────────────────────────────────

async function handleCommentCreate(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { video_id, timestamp_seconds, author, text } = body;
  if (!video_id || timestamp_seconds == null || !text) {
    return json({ error: 'video_id, timestamp_seconds, and text are required' }, 400);
  }

  const { meta } = await env.DB.prepare(
    `INSERT INTO comments (video_id, timestamp_seconds, author, body) VALUES (?, ?, ?, ?)`
  ).bind(video_id, Number(timestamp_seconds), author?.trim() || 'Anonymous', text.trim()).run();

  return json({ id: meta.last_row_id }, 201);
}

async function handleCommentList(request, env, videoId) {
  const { results } = await env.DB.prepare(
    `SELECT id, timestamp_seconds, author, body, created_at
     FROM comments WHERE video_id = ? ORDER BY timestamp_seconds ASC`
  ).bind(videoId).all();

  return json(results);
}

async function handleCommentDelete(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  await env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(Number(id)).run();
  return json({ ok: true });
}

// ─── Main Router ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const { pathname } = new URL(request.url);
    const method = request.method;

    try {
      // Health
      if (pathname === '/health' && method === 'GET') {
        return json({ ok: true });
      }

      // ── Transfers ──
      if (pathname === '/api/transfer/create' && method === 'POST') {
        return handleTransferCreate(request, env);
      }
      if (pathname === '/api/transfers' && method === 'GET') {
        return handleTransferList(request, env);
      }

      const xferMatch = pathname.match(/^\/api\/transfer\/([^/]+)(\/download)?$/);
      if (xferMatch) {
        const [, id, sub] = xferMatch;
        if (method === 'GET') {
          return sub === '/download'
            ? handleTransferDownload(request, env, id)
            : handleTransferInfo(request, env, id);
        }
        if (method === 'DELETE') return handleTransferDelete(request, env, id);
      }

      // ── Reviews ──
      if (pathname === '/api/review/create' && method === 'POST') {
        return handleReviewCreate(request, env);
      }
      if (pathname === '/api/reviews' && method === 'GET') {
        return handleReviewList(request, env);
      }

      const reviewMatch = pathname.match(/^\/api\/review\/([^/]+)(\/videos)?$/);
      if (reviewMatch) {
        const [, rid, sub] = reviewMatch;
        if (method === 'GET') {
          return sub === '/videos'
            ? handleReviewVideos(request, env, rid)
            : handleReviewInfo(request, env, rid);
        }
        if (method === 'PATCH') return handleReviewUpdate(request, env, rid);
        if (method === 'DELETE') return handleReviewDelete(request, env, rid);
      }

      // ── Stream ──
      if (pathname === '/api/stream/upload' && method === 'POST') {
        return handleStreamUploadCreate(request, env);
      }
      if (pathname === '/api/stream/videos' && method === 'GET') {
        return handleStreamVideoList(request, env);
      }

      const streamMatch = pathname.match(/^\/api\/stream\/([^/]+)$/);
      if (streamMatch && method === 'DELETE') {
        return handleStreamVideoDelete(request, env, streamMatch[1]);
      }

      // ── Comments ──
      if (pathname === '/api/comments' && method === 'POST') {
        return handleCommentCreate(request, env);
      }

      const commentMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentMatch) {
        const id = commentMatch[1];
        if (method === 'GET') return handleCommentList(request, env, id);
        if (method === 'DELETE') return handleCommentDelete(request, env, id);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal server error' }, 500);
    }
  },
};
