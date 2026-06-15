import { AwsClient } from 'aws4fetch';

// ─── Constants ───────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

// ─── Stream Handlers ─────────────────────────────────────────────────────────

async function handleStreamUploadCreate(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { title, description, filesize } = body;
  if (!title || !filesize) return json({ error: 'title and filesize are required' }, 400);

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream?direct_user=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STREAM_API_TOKEN}`,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(filesize),
        'Upload-Metadata': `name ${btoa(title)},requiresignedurls ${btoa('false')}`,
      },
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    return json({ error: 'Stream API error', detail: text }, 502);
  }

  const uploadUrl = resp.headers.get('location');
  const streamUid = resp.headers.get('stream-media-id');

  // Register video in D1 so clients can list it without Stream API access
  await env.DB.prepare(
    `INSERT INTO videos (stream_uid, title, description) VALUES (?, ?, ?)`
  ).bind(streamUid, title, description || null).run();

  return json({ uploadUrl, streamUid });
}

async function handleStreamVideoList(request, env) {
  // Public endpoint — reads from D1, not Stream API
  const { results } = await env.DB.prepare(
    `SELECT stream_uid, title, description, created_at FROM videos ORDER BY created_at DESC`
  ).all();

  return json(results);
}

async function handleStreamVideoDelete(request, env, streamUid) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  // Delete from Stream
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/${streamUid}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}` },
    }
  );

  // Delete comments for this video
  await env.DB.prepare(`DELETE FROM comments WHERE video_id = ?`).bind(streamUid).run();

  // Remove from D1
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
