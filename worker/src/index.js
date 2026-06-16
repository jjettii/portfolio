import { AwsClient } from 'aws4fetch';

// ─── ZIP helpers ─────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function zipLocalHeader(nameBytes, dosTime, dosDate) {
  const buf = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x04034B50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 0x0008, true);   // bit 3: data descriptor follows
  v.setUint16(8, 0, true);        // STORE (no compression)
  v.setUint16(10, dosTime, true);
  v.setUint16(12, dosDate, true);
  // CRC32, compressed size, uncompressed size all 0 — filled by data descriptor
  v.setUint16(26, nameBytes.length, true);
  buf.set(nameBytes, 30);
  return buf;
}

function zipDataDescriptor(crc, size) {
  const buf = new Uint8Array(16);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x08074B50, true);
  v.setUint32(4, crc, true);
  v.setUint32(8, size, true);
  v.setUint32(12, size, true);
  return buf;
}

function zipCentralEntry(nameBytes, dosTime, dosDate, crc, size, localOffset) {
  const buf = new Uint8Array(46 + nameBytes.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x02014B50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 20, true);
  v.setUint16(8, 0x0008, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, dosTime, true);
  v.setUint16(14, dosDate, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, nameBytes.length, true);
  v.setUint32(42, localOffset, true);
  buf.set(nameBytes, 46);
  return buf;
}

function zipEndRecord(count, cdSize, cdOffset) {
  const buf = new Uint8Array(22);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x06054B50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return buf;
}

async function streamZipDownload(env, files, zipName) {
  const { readable, writable } = new IdentityTransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  (async () => {
    try {
      const central = [];
      let offset = 0;

      for (const f of files) {
        const nameBytes = enc.encode(f.filename);
        const localOffset = offset;
        const header = zipLocalHeader(nameBytes, dosTime, dosDate);
        await writer.write(header);
        offset += header.length;

        const obj = await env.BUCKET.get(f.r2_key);
        const crc = (f.crc32 >>> 0) || 0;  // pre-computed at upload time
        let size = 0;

        if (obj) {
          const reader = obj.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            await writer.write(value);
            offset += value.length;
          }
        }

        const desc = zipDataDescriptor(crc, size);
        await writer.write(desc);
        offset += desc.length;

        central.push({ nameBytes, dosTime, dosDate, crc, size, localOffset });
      }

      const cdOffset = offset;
      for (const e of central) {
        const entry = zipCentralEntry(e.nameBytes, e.dosTime, e.dosDate, e.crc, e.size, e.localOffset);
        await writer.write(entry);
        offset += entry.length;
      }

      await writer.write(zipEndRecord(central.length, offset - cdOffset, cdOffset));
      await writer.close();
    } catch (err) {
      console.error('ZIP stream error:', err.message ?? err);
      try { await writer.abort(err); } catch {}
    }
  })();

  const safeName = zipName.replace(/[^\w\s.-]/g, '_');
  return new Response(readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}.zip"`,
      ...CORS,
    },
  });
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const UPLOAD_EXPIRY = 7200;      // 2 hours for upload window
const DOWNLOAD_EXPIRY = 2592000; // 30 days for download links

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

async function getPresignedUrl(env, r2Key, method, expireSeconds, disposition) {
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
  if (disposition) url.searchParams.set('response-content-disposition', disposition);

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
  if (isAdmin(request, env)) {
    const row = await env.DB.prepare(
      `SELECT id, filename, filesize, total_size, description, created_at FROM transfers WHERE id = ?`
    ).bind(id).first();
    if (!row) return json({ error: 'Transfer not found' }, 404);

    const { results: files } = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM transfer_files WHERE transfer_id = ?`
    ).bind(id).all();
    const fileCount = files[0]?.cnt || 0;
    const isMulti = fileCount > 0;
    return json({
      id: row.id,
      filename: row.filename,
      filesize: isMulti ? row.total_size : row.filesize,
      description: row.description,
      created_at: row.created_at,
      is_multi: isMulti,
      file_count: isMulti ? fileCount : null,
    });
  }

  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';

  const row = await env.DB.prepare(
    `SELECT id, filename, filesize, total_size, description, created_at, password_hash FROM transfers WHERE id = ?`
  ).bind(id).first();

  if (!row) return json({ error: 'Transfer not found' }, 404);

  const hash = await hashPassword(password, env);
  if (hash !== row.password_hash) return json({ error: 'Invalid password' }, 403);

  const { results: files } = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM transfer_files WHERE transfer_id = ?`
  ).bind(id).all();

  const fileCount = files[0]?.cnt || 0;
  const isMulti = fileCount > 0;

  return json({
    id: row.id,
    filename: row.filename,
    filesize: isMulti ? row.total_size : row.filesize,
    description: row.description,
    created_at: row.created_at,
    is_multi: isMulti,
    file_count: isMulti ? fileCount : null,
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

  const { results: files } = await env.DB.prepare(
    `SELECT filename, r2_key, crc32 FROM transfer_files WHERE transfer_id = ? ORDER BY sort_order ASC`
  ).bind(id).all();

  if (files.length > 0) {
    return streamZipDownload(env, files, row.filename);
  }

  const downloadUrl = await getPresignedUrl(env, row.r2_key, 'GET', DOWNLOAD_EXPIRY, `attachment; filename="${row.filename}"`);
  return json({ downloadUrl, filename: row.filename });
}

async function handleTransferList(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    `SELECT t.id, t.filename, t.filesize, t.total_size, t.description, t.created_at,
            COUNT(tf.id) AS file_count
     FROM transfers t
     LEFT JOIN transfer_files tf ON tf.transfer_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC`
  ).all();

  return json(results);
}

async function handleTransferDelete(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  const row = await env.DB.prepare(`SELECT r2_key FROM transfers WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'Transfer not found' }, 404);

  const { results: files } = await env.DB.prepare(
    `SELECT r2_key FROM transfer_files WHERE transfer_id = ?`
  ).bind(id).all();

  for (const f of files) await env.BUCKET.delete(f.r2_key);
  await env.DB.prepare(`DELETE FROM transfer_files WHERE transfer_id = ?`).bind(id).run();

  if (row.r2_key) await env.BUCKET.delete(row.r2_key);
  await env.DB.prepare(`DELETE FROM transfers WHERE id = ?`).bind(id).run();

  return json({ ok: true });
}

async function handleTransferUpdate(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const row = await env.DB.prepare(`SELECT id FROM transfers WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'Transfer not found' }, 404);

  const updates = [];
  const values = [];

  if (body.filename !== undefined) { updates.push('filename = ?'); values.push(body.filename); }
  if (body.password) { updates.push('password_hash = ?'); values.push(await hashPassword(body.password, env)); }

  if (!updates.length) return json({ error: 'Nothing to update' }, 400);

  values.push(id);
  await env.DB.prepare(`UPDATE transfers SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();

  return json({ ok: true });
}

async function handleTransferFileDelete(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { filename } = body;
  if (!filename) return json({ error: 'filename required' }, 400);

  const file = await env.DB.prepare(
    `SELECT r2_key, filesize FROM transfer_files WHERE transfer_id = ? AND filename = ?`
  ).bind(id, filename).first();
  if (!file) return json({ error: 'File not found' }, 404);

  if (file.r2_key) await env.BUCKET.delete(file.r2_key);
  await env.DB.prepare(`DELETE FROM transfer_files WHERE transfer_id = ? AND filename = ?`).bind(id, filename).run();

  if (file.filesize) {
    await env.DB.prepare(
      `UPDATE transfers SET total_size = MAX(0, COALESCE(total_size, 0) - ?) WHERE id = ?`
    ).bind(file.filesize, id).run();
  }

  return json({ ok: true });
}

async function handleTransferFileCrc(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { filename, crc32 } = body;
  if (!filename || crc32 == null) return json({ error: 'filename and crc32 required' }, 400);

  await env.DB.prepare(
    `UPDATE transfer_files SET crc32 = ? WHERE transfer_id = ? AND filename = ?`
  ).bind(crc32 >>> 0, id, filename).run();

  return json({ ok: true });
}

async function handleTransferFileList(request, env, id) {
  if (!isAdmin(request, env)) {
    const url = new URL(request.url);
    const password = url.searchParams.get('password') || '';

    const row = await env.DB.prepare(
      `SELECT password_hash FROM transfers WHERE id = ?`
    ).bind(id).first();
    if (!row) return json({ error: 'Transfer not found' }, 404);

    const hash = await hashPassword(password, env);
    if (hash !== row.password_hash) return json({ error: 'Invalid password' }, 403);
  } else {
    const row = await env.DB.prepare(`SELECT id FROM transfers WHERE id = ?`).bind(id).first();
    if (!row) return json({ error: 'Transfer not found' }, 404);
  }

  const { results: files } = await env.DB.prepare(
    `SELECT filename, filesize, r2_key FROM transfer_files WHERE transfer_id = ? ORDER BY sort_order ASC`
  ).bind(id).all();

  const result = await Promise.all(files.map(async f => {
    const leafName = f.filename.split('/').pop();
    const downloadUrl = await getPresignedUrl(
      env, f.r2_key, 'GET', DOWNLOAD_EXPIRY,
      `attachment; filename="${leafName}"`
    );
    return { filename: f.filename, filesize: f.filesize, url: downloadUrl };
  }));

  return json({ files: result });
}

async function handleTransferCreateMulti(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { name, description, password } = body;
  if (!name || !password) return json({ error: 'name and password are required' }, 400);

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password, env);

  // r2_key = '' signals a multi-file transfer; files stored in transfer_files
  await env.DB.prepare(
    `INSERT INTO transfers (id, filename, filesize, r2_key, password_hash, description)
     VALUES (?, ?, NULL, '', ?, ?)`
  ).bind(id, name, passwordHash, description || null).run();

  return json({ id });
}

async function handleTransferAddFile(request, env, id) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  const transfer = await env.DB.prepare(`SELECT id FROM transfers WHERE id = ?`).bind(id).first();
  if (!transfer) return json({ error: 'Transfer not found' }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { filename, filesize, sort_order } = body;
  if (!filename) return json({ error: 'filename required' }, 400);

  const r2Key = `transfers/${id}/${filename}`;

  await env.DB.prepare(
    `INSERT INTO transfer_files (transfer_id, filename, r2_key, filesize, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, filename, r2Key, filesize || null, sort_order ?? 0).run();

  await env.DB.prepare(
    `UPDATE transfers SET total_size = COALESCE(total_size, 0) + ? WHERE id = ?`
  ).bind(filesize || 0, id).run();

  const uploadUrl = await getPresignedUrl(env, r2Key, 'PUT', UPLOAD_EXPIRY);

  return json({ uploadUrl });
}

// ─── Multipart Upload Handlers ───────────────────────────────────────────────

async function handleMultipartCreate(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { key } = body;
  if (!key) return json({ error: 'key is required' }, 400);

  const mpu = await env.BUCKET.createMultipartUpload(key);
  return json({ uploadId: mpu.uploadId, key: mpu.key });
}

async function handleMultipartPresignPart(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { key, uploadId, partNumber } = body;
  if (!key || !uploadId || partNumber == null) return json({ error: 'key, uploadId, and partNumber are required' }, 400);

  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });

  const url = new URL(
    `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`
  );
  url.searchParams.set('X-Amz-Expires', String(UPLOAD_EXPIRY));
  url.searchParams.set('partNumber', String(partNumber));
  url.searchParams.set('uploadId', uploadId);

  const signed = await client.sign(new Request(url.toString(), { method: 'PUT' }), {
    aws: { signQuery: true, allHeaders: true },
  });

  return json({ url: signed.url });
}

async function handleMultipartComplete(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { key, uploadId, parts } = body;
  if (!key || !uploadId || !Array.isArray(parts)) return json({ error: 'key, uploadId, and parts are required' }, 400);

  const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
  await mpu.complete(parts);

  return json({ ok: true });
}

async function handleMultipartAbort(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { key, uploadId } = body;
  if (!key || !uploadId) return json({ error: 'key and uploadId are required' }, 400);

  const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
  await mpu.abort();

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

async function handleStreamVideoUpdate(request, env, streamUid) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { title, description } = body;
  if (!title) return json({ error: 'title is required' }, 400);

  await env.DB.prepare(
    `UPDATE videos SET title = ?, description = ? WHERE stream_uid = ?`
  ).bind(title.trim(), description?.trim() || null, streamUid).run();

  return json({ ok: true });
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
      if (pathname === '/api/transfer/create-multi' && method === 'POST') {
        return handleTransferCreateMulti(request, env);
      }
      if (pathname === '/api/transfer/multipart/create' && method === 'POST') {
        return handleMultipartCreate(request, env);
      }
      if (pathname === '/api/transfer/multipart/presign-part' && method === 'POST') {
        return handleMultipartPresignPart(request, env);
      }
      if (pathname === '/api/transfer/multipart/complete' && method === 'POST') {
        return handleMultipartComplete(request, env);
      }
      if (pathname === '/api/transfer/multipart/abort' && method === 'POST') {
        return handleMultipartAbort(request, env);
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
        if (method === 'PATCH') return handleTransferUpdate(request, env, id);
        if (method === 'DELETE') return handleTransferDelete(request, env, id);
      }

      const xferFileMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/add-file$/);
      if (xferFileMatch && method === 'POST') {
        return handleTransferAddFile(request, env, xferFileMatch[1]);
      }

      const xferSingleFileDeleteMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/file$/);
      if (xferSingleFileDeleteMatch && method === 'DELETE') {
        return handleTransferFileDelete(request, env, xferSingleFileDeleteMatch[1]);
      }

      const xferCrcMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/file-crc$/);
      if (xferCrcMatch && method === 'PATCH') {
        return handleTransferFileCrc(request, env, xferCrcMatch[1]);
      }

      const xferFilesListMatch = pathname.match(/^\/api\/transfer\/([^/]+)\/files$/);
      if (xferFilesListMatch && method === 'GET') {
        return handleTransferFileList(request, env, xferFilesListMatch[1]);
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
      if (streamMatch) {
        if (method === 'PATCH') return handleStreamVideoUpdate(request, env, streamMatch[1]);
        if (method === 'DELETE') return handleStreamVideoDelete(request, env, streamMatch[1]);
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
